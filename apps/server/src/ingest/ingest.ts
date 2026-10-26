import { Cron } from 'croner';
import { type Insertable, type Kysely, sql, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { DB } from '../db/db.ts';
import { startHeartbeat } from '../heartbeat.ts';
import type { createClient, Query } from '../openf1/client.ts';
import { type Endpoint, parse, type Result, type Rows } from '../openf1/schemas.ts';
import { meetingRow, normaliseSession, type SessionData, type SessionRows, sessionRow } from './normalise.ts';
import {
  afterFailure,
  afterSuccess,
  busyGuard,
  type ErrorCode,
  errorCode,
  FIRST_FETCH_AFTER_MS,
  firstFetchAt,
  type IngestState,
  type Progress,
} from './state.ts';

// The ingest daemon and the backfill/refetch jobs (A§8). Logs carry keys, states,
// counts and fixed codes only: never a URL, a password or a response body.

const FIRST_YEAR = 2023;
const SESSION_ENDPOINTS = ['drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result'] as const;
const REPLACED = ['raw_response', 'driver', 'lap', 'stint', 'pit', 'race_control', 'result'] as const;
// 1,000 rows × ≤ 20 columns stays far below PostgreSQL's 65,535 bind parameters.
const CHUNK = 1_000;

export type Deps = {
  db: Kysely<DB>;
  client: ReturnType<typeof createClient>;
  /** The app clock (D7): every state decision takes its time from here, never from SQL now(). */
  now: () => Date;
  log: Pick<Logger, 'info' | 'error'>;
};
export type Outcome = Result<IngestState, ErrorCode | 'unknown_session'>;

/** A thrown value's code (a SQLSTATE or a Node errno), never its message. */
export const codeOf = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unknown';

const chunks = <T>(rows: readonly T[]) =>
  Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

async function fetchRows<E extends Endpoint>(
  client: Deps['client'],
  endpoint: E,
  query: Query,
): Promise<Result<{ status: number; body: unknown; rows: Rows<E> }, ErrorCode>> {
  const fetched = await client.get(endpoint, query);
  if (!fetched.ok) return { ok: false, error: errorCode(fetched.error) };
  const parsed = parse(endpoint, fetched.value.body);
  if (!parsed.ok) return { ok: false, error: errorCode(parsed.error) };
  return { ok: true, value: { ...fetched.value, rows: parsed.value } };
}

/** meetings + sessions per year → upsert, metadata only; `next_fetch_at` moves only while `scheduled`. */
export async function syncSchedule({ db, client, log }: Deps, years: readonly number[]): Promise<boolean> {
  let ok = true;
  for (const year of years) {
    const meetings = await fetchRows(client, 'meetings', { year });
    if (!meetings.ok) {
      log.error({ year, last_error: meetings.error }, 'sync');
      ok = false;
      continue;
    }
    const sessions = await fetchRows(client, 'sessions', { year });
    if (!sessions.ok) {
      log.error({ year, last_error: sessions.error }, 'sync');
      ok = false;
      continue;
    }
    // A session whose meeting OpenF1 left out would fail the year on the FK: skip it.
    const known = new Set(meetings.value.rows.map((m) => m.meeting_key));
    const rows = sessions.value.rows
      .filter((s) => known.has(s.meeting_key))
      .map((s) => ({ ...sessionRow(s), next_fetch_at: firstFetchAt(new Date(s.date_end)) }));
    try {
      await db.transaction().execute(async (trx) => {
        for (const chunk of chunks(meetings.value.rows.map(meetingRow))) {
          await trx
            .insertInto('meeting')
            .values(chunk)
            .onConflict((oc) =>
              oc.column('meeting_key').doUpdateSet((eb) => ({
                source: eb.ref('excluded.source'),
                year: eb.ref('excluded.year'),
                name: eb.ref('excluded.name'),
                official_name: eb.ref('excluded.official_name'),
                location: eb.ref('excluded.location'),
                country_code: eb.ref('excluded.country_code'),
                circuit_short_name: eb.ref('excluded.circuit_short_name'),
                gmt_offset: eb.ref('excluded.gmt_offset'),
                date_start: eb.ref('excluded.date_start'),
                date_end: eb.ref('excluded.date_end'),
              })),
            )
            .execute();
        }
        for (const chunk of chunks(rows)) {
          await trx
            .insertInto('session')
            .values(chunk)
            .onConflict((oc) =>
              oc.column('session_key').doUpdateSet((eb) => ({
                source: eb.ref('excluded.source'),
                meeting_key: eb.ref('excluded.meeting_key'),
                type: eb.ref('excluded.type'),
                name: eb.ref('excluded.name'),
                date_start: eb.ref('excluded.date_start'),
                date_end: eb.ref('excluded.date_end'),
                next_fetch_at: eb
                  .case()
                  .when('session.ingest_state', '=', 'scheduled')
                  .then(eb.ref('excluded.next_fetch_at'))
                  .else(eb.ref('session.next_fetch_at'))
                  .end(),
              })),
            )
            .execute();
        }
      });
    } catch (err) {
      log.error({ year, last_error: 'db', cause: codeOf(err) }, 'sync');
      ok = false;
      continue;
    }
    const skipped = sessions.value.rows.length - rows.length;
    log.info({ year, meetings: meetings.value.rows.length, sessions: rows.length, skipped }, 'sync');
  }
  return ok;
}

const lockSession = (trx: Transaction<DB>, key: number) =>
  trx
    .selectFrom('session')
    .select(['date_end', 'fetch_count', 'fail_count'])
    .where('session_key', '=', key)
    .forUpdate()
    .executeTakeFirstOrThrow();

const setProgress = (trx: Transaction<DB>, key: number, p: Progress) =>
  trx.updateTable('session').set(p).where('session_key', '=', key).execute();

/**
 * D6: fetch all six endpoints (no write on any error), then one transaction: lock the
 * session row, decide from the locked row, replace raw responses and child rows, set the
 * state. A failure is its own short locked write. `refetch` never changes state on failure.
 * Never throws; logs one line per session.
 */
export async function processSession(deps: Deps, key: number, refetch = false): Promise<Outcome> {
  const { db, client, now, log } = deps;
  const started = performance.now();
  const line = (fields: Record<string, unknown>) => ({
    session_key: key,
    ...fields,
    ms: Math.round(performance.now() - started),
  });

  const fail = async (code: ErrorCode, cause?: unknown): Promise<Outcome> => {
    let state: IngestState | 'unchanged' = 'unchanged';
    let lost: string | undefined;
    if (!refetch) {
      try {
        state = await db.transaction().execute(async (trx) => {
          const next = afterFailure(await lockSession(trx, key), code, now());
          await setProgress(trx, key, next);
          return next.ingest_state;
        });
      } catch (err) {
        lost = codeOf(err); // not recorded: the session stays as it was
      }
    }
    const codes = { cause: cause === undefined ? undefined : codeOf(cause), unrecorded: lost };
    log.error(line({ state, last_error: code, ...codes }), 'session');
    return { ok: false, error: code };
  };

  try {
    if (!(await db.selectFrom('session').select('session_key').where('session_key', '=', key).executeTakeFirst())) {
      log.error(line({ error: 'unknown_session' }), 'session');
      return { ok: false, error: 'unknown_session' };
    }
  } catch (err) {
    log.error(line({ state: 'unchanged', last_error: 'db', cause: codeOf(err) }), 'session');
    return { ok: false, error: 'db' };
  }

  const raw: Insertable<DB['raw_response']>[] = [];
  const data = {} as Record<(typeof SESSION_ENDPOINTS)[number], unknown[]>;
  for (const endpoint of SESSION_ENDPOINTS) {
    const fetched = await fetchRows(client, endpoint, { session_key: key });
    if (!fetched.ok) return fail(fetched.error);
    data[endpoint] = fetched.value.rows;
    const { status, body } = fetched.value;
    // The JSON text: pg would turn a JS array into a PostgreSQL array, not jsonb.
    raw.push({
      session_key: key,
      source: 'openf1',
      endpoint,
      fetched_at: now(),
      http_status: status,
      body: JSON.stringify(body),
    });
  }
  let normalised: ReturnType<typeof normaliseSession>;
  try {
    normalised = normaliseSession(key, data as SessionData);
  } catch (err) {
    return fail('unknown', err); // a bug must not stop the tick at this session for good
  }
  const { rows, skipped } = normalised;

  let done: { next: Progress; empty: boolean };
  try {
    done = await db.transaction().execute(async (trx) => {
      const row = await lockSession(trx, key);
      // Empty guard: [] where the stored response had rows is a transient reply; keep the data.
      const had = await trx
        .selectFrom('raw_response')
        .select('endpoint')
        .where('session_key', '=', key)
        .where(sql<boolean>`jsonb_array_length(body) > 0`)
        .execute();
      if (had.some((r) => data[r.endpoint as keyof typeof data]?.length === 0)) {
        const next = afterFailure(row, 'empty', now());
        if (!refetch) await setProgress(trx, key, next);
        return { next, empty: true };
      }
      for (const table of REPLACED) await trx.deleteFrom(table).where('session_key', '=', key).execute();
      await trx.insertInto('raw_response').values(raw).execute();
      // The cast: Kysely cannot relate a table name from a loop to its row type.
      for (const [table, list] of Object.entries(rows) as [keyof SessionRows, object[]][]) {
        for (const chunk of chunks(list))
          await trx
            .insertInto(table)
            .values(chunk as never)
            .execute();
      }
      // P1c: the timing rules (deleted laps, quali phase) run here, inside this transaction (D12).
      const next = afterSuccess(row, now());
      await setProgress(trx, key, next);
      return { next, empty: false };
    });
  } catch (err) {
    return fail('db', err);
  }
  if (done.empty) {
    log.error(line({ state: refetch ? 'unchanged' : done.next.ingest_state, last_error: 'empty' }), 'session');
    return { ok: false, error: 'empty' };
  }
  const counts = Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, list.length]));
  log.info(line({ state: done.next.ingest_state, rows: counts, skipped }), 'session');
  return { ok: true, value: done.next.ingest_state };
}

/**
 * A§6.1: from 30 min before any session starts until 30 min after it ends, OpenF1 answers
 * every free request with 401, past sessions included. The tick and the backfill wait it out.
 */
async function live({ db, now }: Deps): Promise<boolean> {
  const at = now().getTime();
  const margin = 30 * 60_000;
  const row = await db
    .selectFrom('session')
    .select('session_key')
    .where('date_start', '<=', new Date(at + margin))
    .where('date_end', '>', new Date(at - margin))
    .executeTakeFirst();
  return row !== undefined;
}

/** Marks every session whose time has come `due`, then processes the due ones, newest first. */
export async function tick(deps: Deps, stopping: () => boolean = () => false): Promise<number> {
  const at = deps.now();
  await deps.db
    .updateTable('session')
    .set({ ingest_state: 'due' })
    .where('ingest_state', 'in', ['scheduled', 'fetched'])
    .where('next_fetch_at', '<=', at)
    .execute();
  const due = await deps.db
    .selectFrom('session')
    .select('session_key')
    .where('ingest_state', '=', 'due')
    .where('next_fetch_at', '<=', at)
    .orderBy('date_end', 'desc')
    .execute();
  let processed = 0;
  for (const { session_key } of due) {
    if (stopping()) break; // SIGTERM ends a long (first) tick after the current session
    if (await live(deps)) {
      deps.log.info({ due: due.length - processed }, 'live session: waiting'); // a later tick goes on
      break;
    }
    await processSession(deps, session_key);
    processed++;
  }
  return processed;
}

const yearRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Every year from 2023, then each past session that is not final, newest first, once.
 * Resumable: the state is in the database. True when nothing failed. A live window
 * stops it (run it again afterwards).
 */
export async function backfill(deps: Deps): Promise<boolean> {
  const ok = await syncSchedule(deps, yearRange(FIRST_YEAR, deps.now().getUTCFullYear()));
  const todo = await deps.db
    .selectFrom('session')
    .select('session_key')
    .where('ingest_state', '<>', 'final')
    .where('date_end', '<=', new Date(deps.now().getTime() - FIRST_FETCH_AFTER_MS))
    .orderBy('date_end', 'desc')
    .execute();
  let done = 0;
  let failed = 0;
  for (const { session_key } of todo) {
    if (await live(deps)) {
      deps.log.error({ sessions: todo.length, done, failed }, 'backfill: live session, stopping');
      return false;
    }
    if (!(await processSession(deps, session_key)).ok) failed++;
    done++;
  }
  deps.log.info({ sessions: todo.length, done, failed }, 'backfill');
  return ok && failed === 0;
}

/**
 * The daemon: a schedule sync at start and daily at 00:30 UTC (the current year plus
 * every year from 2023 without a meeting: all of them on the first run), a tick every
 * minute. Resolves after SIGTERM/SIGINT once the running jobs have finished.
 */
export async function startIngest(deps: Deps): Promise<void> {
  const { db, now, log } = deps;
  let stopping = false;
  const stop = new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  }).then(() => {
    stopping = true;
  });
  const guarded = (job: string, fn: () => Promise<unknown>) =>
    busyGuard(async () => {
      if (stopping) return;
      await fn().catch((err: unknown) => log.error({ job, cause: codeOf(err) }, 'job failed'));
    });

  const stopHeartbeat = startHeartbeat();
  const sync = guarded('sync', async () => {
    const seen = new Set((await db.selectFrom('meeting').select('year').distinct().execute()).map((m) => m.year));
    const current = now().getUTCFullYear();
    await syncSchedule(
      deps,
      yearRange(FIRST_YEAR, current).filter((y) => y === current || !seen.has(y)),
    );
  });
  const work = guarded('tick', () => tick(deps, () => stopping));
  await sync.run();
  void work.run();
  const jobs = [
    new Cron('30 0 * * *', { timezone: 'UTC' }, () => void sync.run()),
    new Cron('* * * * *', { timezone: 'UTC' }, () => void work.run()),
  ];

  await stop;
  log.info({}, 'stopping');
  for (const job of jobs) job.stop();
  await Promise.all([sync.idle(), work.idle()]);
  stopHeartbeat();
}
