import { type Kysely, sql } from 'kysely';
import { codeOf, type DB } from '../db/db.ts';
import { parse } from '../openf1/schemas.ts';
import { type Deps, fetchRows, live, processSession, replaceRows, SESSION_ENDPOINTS } from './ingest.ts';
import { normaliseSession, type SessionData } from './normalise.ts';
import { FIRST_FETCH_AFTER_MS } from './state.ts';

// The recovery tools (#103, A§8): a batch refetch, a rederive from raw_response, accept-empty and rain-refetch. Each
// logs keys, counts and fixed codes only, never a value, a URL or a body, and never throws a per-session error.

/**
 * `refetch <key> | --failed | --meeting <key>`: processSession as a refetch (no state change on a failure), one
 * session after another on one client, so one limiter serves the run. `failed` and `meeting` run newest first; a
 * meeting takes its ended sessions only (the backfill filter). A live window stops the run. No lock: the row lock
 * serialises it against the daemon. True when nothing failed; a meeting without such sessions is `no_sessions`.
 */
export async function refetch(deps: Deps, which: number[] | 'failed' | { meeting: number }): Promise<boolean> {
  const { db, now, log } = deps;
  const meeting = Array.isArray(which) || which === 'failed' ? undefined : which.meeting;
  const keys = Array.isArray(which)
    ? which
    : (
        await db
          .selectFrom('session')
          .select('session_key')
          .where('source', '=', 'openf1')
          .where('is_cancelled', '=', false)
          .$if(meeting === undefined, (q) => q.where('ingest_state', '=', 'failed'))
          .$if(meeting !== undefined, (q) =>
            q
              .where('meeting_key', '=', meeting ?? 0)
              .where('date_end', '<=', new Date(now().getTime() - FIRST_FETCH_AFTER_MS)),
          )
          .orderBy('date_end', 'desc')
          .execute()
      ).map((s) => s.session_key);
  let done = 0;
  let failed = 0;
  for (const key of keys) {
    const outcome = await processSession(deps, key, true);
    done++;
    if (outcome.ok) continue;
    failed++;
    if (outcome.error === 'live_session') break; // run it again afterwards
  }
  const error = meeting !== undefined && keys.length === 0 ? 'no_sessions' : undefined;
  const ok = failed === 0 && error === undefined;
  log[ok ? 'info' : 'error']({ sessions: keys.length, done, failed, error }, 'refetch_done');
  return ok;
}

type Rederived = { outcome: 'rederived' | 'skipped' | 'failed'; line: Record<string, unknown> };

/**
 * A§2 principle 3: derives stored sessions again from their raw responses, with today's normaliser and rules. No
 * OpenF1 call (so no empty guard), and no state, progress or raw change. Per session one transaction: lock the
 * session row, then read the raw rows under the lock, so a concurrent fetch is never overwritten by older raw. The
 * grid carries over by driver from the stored results (D2). `all` takes every OpenF1 session, newest first. True when
 * nothing failed (a skip is no failure).
 */
export async function rederive(deps: Pick<Deps, 'db' | 'log' | 'beat'>, keys: number[] | 'all'): Promise<boolean> {
  const { db, log, beat } = deps;
  const started = performance.now();
  const list =
    keys !== 'all'
      ? keys
      : (
          await db
            .selectFrom('session')
            .select('session_key')
            .where('source', '=', 'openf1')
            .orderBy('date_end', 'desc')
            .execute()
        ).map((s) => s.session_key);
  const counts = { rederived: 0, skipped: 0, failed: 0 };
  for (const key of list) {
    const t = performance.now();
    let done: Rederived;
    try {
      done = await db.transaction().execute(async (trx): Promise<Rederived> => {
        const s = await trx
          .selectFrom('session')
          .select(['source', 'type'])
          .where('session_key', '=', key)
          .forUpdate()
          .executeTakeFirst();
        if (!s) return { outcome: 'failed', line: { error: 'unknown_session' } };
        if (s.source !== 'openf1') return { outcome: 'failed', line: { error: 'not_openf1' } };
        const raw = await trx
          .selectFrom('raw_response')
          .select(['endpoint', 'body'])
          .where('session_key', '=', key)
          .where('endpoint', 'in', SESSION_ENDPOINTS)
          .execute();
        if (raw.length === 0) return { outcome: 'skipped', line: { skipped: 'no_raw' } };
        const bodies = new Map(raw.map((r) => [r.endpoint, r.body]));
        if (SESSION_ENDPOINTS.some((e) => !bodies.has(e)))
          return { outcome: 'skipped', line: { skipped: 'incomplete' } };
        const data = {} as Record<(typeof SESSION_ENDPOINTS)[number], unknown[]>;
        for (const endpoint of SESSION_ENDPOINTS) {
          const parsed = parse(endpoint, bodies.get(endpoint));
          if (!parsed.ok)
            return { outcome: 'failed', line: { error: 'schema', endpoint, issues: parsed.error.issues } };
          data[endpoint] = parsed.value;
        }
        const { rows, skipped, rules } = normaliseSession(key, data as SessionData, s.type);
        const stored = await trx
          .selectFrom('result')
          .select(['driver_number', 'grid'])
          .where('session_key', '=', key)
          .execute();
        const grids = new Map(stored.map((r) => [r.driver_number, r.grid]));
        const result = rows.result.map((r) => ({ ...r, grid: grids.get(r.driver_number) ?? null }));
        const merge = await replaceRows(trx, key, { ...rows, result });
        const counted = Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, list.length]));
        const ms = Math.round(performance.now() - t);
        return { outcome: 'rederived', line: { rows: counted, skipped, rules, merge, ms } };
      });
    } catch (err) {
      done = { outcome: 'failed', line: { error: codeOf(err) } }; // the code only: a message could quote a value
    }
    counts[done.outcome]++;
    log[done.outcome === 'failed' ? 'error' : 'info']({ session_key: key, ...done.line }, 'rederive');
    beat(); // a `run --rm` container inherits the healthcheck, and f1-tick restarts an unhealthy one
  }
  const ok = counts.failed === 0;
  const ms = Math.round(performance.now() - started);
  log[ok ? 'info' : 'error']({ sessions: list.length, ...counts, ms }, 'rederive_done');
  return ok;
}

const storedRows = (db: Kysely<DB>, key: number, endpoint: string) =>
  db
    .selectFrom('raw_response')
    .select(sql<number>`jsonb_array_length(body)`.as('n'))
    .where('session_key', '=', key)
    .where('endpoint', '=', endpoint)
    .executeTakeFirst()
    .then((r) => r?.n ?? 0);

/**
 * D4: OpenF1 emptied one endpoint of a session for good. Deletes that stored raw row, and only it, when it has rows
 * and OpenF1 answers `[]` now (one request), so the next fetch (the tick, or `refetch` for a failed or final session)
 * passes the empty guard. The data rows stay until then. Refuses outside an OpenF1 session and inside a live window.
 */
export async function acceptEmpty(
  deps: Deps,
  key: number,
  endpoint: (typeof SESSION_ENDPOINTS)[number],
): Promise<boolean> {
  const { db, log } = deps;
  const refuse = (error: string) => {
    log.error({ session_key: key, endpoint, error }, 'accept_empty');
    return false;
  };
  try {
    const s = await db.selectFrom('session').select('source').where('session_key', '=', key).executeTakeFirst();
    if (!s) return refuse('unknown_session');
    if (s.source !== 'openf1') return refuse('not_openf1');
    if (await live(deps)) return refuse('live_session');
    if ((await storedRows(db, key, endpoint)) === 0) return refuse('no_rows'); // before any request
    const fetched = await fetchRows(deps, endpoint, { session_key: key });
    if (!fetched.ok) return refuse(fetched.error.last_error);
    if (fetched.value.rows.length > 0) return refuse('not_empty');
    const rows = await db.transaction().execute(async (trx) => {
      await trx.selectFrom('session').select('session_key').where('session_key', '=', key).forUpdate().execute();
      const n = await storedRows(trx, key, endpoint); // again, under the lock
      if (n > 0)
        await trx.deleteFrom('raw_response').where('session_key', '=', key).where('endpoint', '=', endpoint).execute();
      return n;
    });
    if (rows === 0) return refuse('no_rows');
    log.info({ session_key: key, endpoint, rows }, 'accept_empty'); // rows: the deleted body's row count
    return true;
  } catch (err) {
    return refuse(codeOf(err)); // the code only
  }
}

/**
 * Re-queues a failed rain grid: live and due now, its failures reset. The daemon's next rain step fetches it as a due
 * grid (Historical once past date_end + 24 h). A grid in another state is `not_failed`, none is `no_grid`.
 */
export async function rainRefetch(deps: Pick<Deps, 'db' | 'now' | 'log'>, key: number): Promise<boolean> {
  const { db, now, log } = deps;
  try {
    const at = now();
    const updated = await db
      .updateTable('rain_grid')
      .set({ state: 'live', fail_count: 0, last_error: null, next_fetch_at: at, updated_at: at })
      .where('session_key', '=', key)
      .where('state', '=', 'failed')
      .returning('session_key')
      .executeTakeFirst();
    if (updated) {
      log.info({ session_key: key }, 'rain_refetch');
      return true;
    }
    const grid = await db.selectFrom('rain_grid').select('state').where('session_key', '=', key).executeTakeFirst();
    log.error({ session_key: key, error: grid ? 'not_failed' : 'no_grid' }, 'rain_refetch');
  } catch (err) {
    log.error({ session_key: key, error: codeOf(err) }, 'rain_refetch'); // the code only
  }
  return false;
}
