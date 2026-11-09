import { CIRCUITS, gridPoints } from '@f1/contracts';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import type { BudgetKind, createBudget, createRainClient } from './client.ts';
import { rainQuery, toFrames } from './grid.ts';
import {
  afterRainFailure,
  afterRainSuccess,
  apiFor,
  FINAL_AFTER_MS,
  frameWindow,
  GRID,
  inLiveWindow,
  LIVE_MARGIN_MS,
  type RainCode,
  rainErrorCode,
} from './state.ts';

// The rain job (A§8, P5c): a step of the ingest daemon's minute job, after the OpenF1 tick, so it runs during live
// windows too (Open-Meteo has none). Logs carry keys, states, counts and fixed codes only: never a value, a URL, a
// coordinate or a body.

export type RainDeps = {
  db: Kysely<DB>;
  client: ReturnType<typeof createRainClient>;
  budget: ReturnType<typeof createBudget>;
  /** The app clock: every state decision takes its time from here, never from SQL now(). */
  now: () => Date;
  log: Pick<Logger, 'info' | 'error'>;
  beat: () => void;
};

const HOUR_MS = 3_600_000;
const MAPPED = Object.keys(CIRCUITS);
const POINTS = GRID.size * GRID.size;

/** The due grid with the newest date_end (of session `key` only, if given). */
const dueGrid = (db: Kysely<DB>, at: Date, key?: number) =>
  db
    .selectFrom('rain_grid')
    .innerJoin('session', 'session.session_key', 'rain_grid.session_key')
    .select([
      'rain_grid.session_key',
      'rain_grid.centre_lat',
      'rain_grid.centre_lon',
      'rain_grid.size',
      'rain_grid.step_m',
      'rain_grid.fetch_count',
      'session.date_start',
      'session.date_end',
    ])
    .where('rain_grid.state', '=', 'live')
    .where('rain_grid.next_fetch_at', '<=', at)
    .$if(key !== undefined, (q) => q.where('rain_grid.session_key', '=', key ?? 0))
    .orderBy('session.date_end', 'desc')
    .limit(1)
    .executeTakeFirst();
type Due = NonNullable<Awaited<ReturnType<typeof dueGrid>>>;

/** Sessions joined to their meeting's circuit, without a grid. */
const gridless = (db: Kysely<DB>) =>
  db
    .selectFrom('session')
    .innerJoin('meeting', 'meeting.meeting_key', 'session.meeting_key')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('rain_grid').select('session_key').whereRef('rain_grid.session_key', '=', 'session.session_key'),
        ),
      ),
    );

/**
 * Locks the grid (an UPDATE takes the row lock) and counts the attempt, in the transaction that records its outcome:
 * every Open-Meteo attempt for a grid that still exists is counted, whatever its state now.
 */
const countAttempt = (trx: Transaction<DB>, key: number, at: Date) =>
  trx
    .updateTable('rain_grid')
    .set((eb) => ({ attempt_count: eb('attempt_count', '+', 1), updated_at: at }))
    .where('session_key', '=', key)
    .returning(['state', 'fetch_count', 'fail_count'])
    .executeTakeFirst();

/** The minute job's rain step, with its per-process memory (the budget seed, the unmapped log, the refusal streaks). */
export function createRainStep(deps: RainDeps) {
  const { db, client, budget, now, log, beat } = deps;
  let seeded = false;
  let unmappedLogged = false; // C5: once per process
  let pausedLogged = false;
  const refusing: Record<BudgetKind, boolean> = { live: false, backfill: false };

  /**
   * D3: a restart counts the attempts of every grid touched in the last 24 h (and hour) as made now. attempt_count
   * counts a grid's attempts over its whole life and updated_at is only its last, so this over-counts: a restart never
   * exceeds a cap. The one gap is an attempt whose own write failed (logged as `unrecorded`).
   */
  async function seed(at: Date): Promise<void> {
    const t = at.getTime();
    const { rows } = await sql<{ day: string | null; hour: string | null }>`
      SELECT sum(attempt_count * size * size) AS day,
             sum(attempt_count * size * size) FILTER (WHERE updated_at > ${new Date(t - HOUR_MS)}) AS hour
      FROM rain_grid WHERE updated_at > ${new Date(t - 24 * HOUR_MS)}`.execute(db);
    budget.seed(Number(rows[0]?.day ?? 0), Number(rows[0]?.hour ?? 0));
  }

  /** A 429's pause skips the step: no request, no budget, no failure. Logged once per pause. */
  function paused(): boolean {
    const ms = client.pausedFor();
    if (ms > 0 && !pausedLogged) log.info({ ms }, 'rain_paused');
    pausedLogged = ms > 0;
    return ms > 0;
  }

  /** A refusal ends the step; it is logged when a streak of them starts, not every minute. */
  function take(kind: BudgetKind): boolean {
    const ok = budget.take(POINTS, kind);
    if (!ok && !refusing[kind]) log.info({ kind, used: budget.used() }, 'rain_budget');
    refusing[kind] = !ok;
    return ok;
  }

  async function insertGrid(key: number, circuit: string | null, at: Date): Promise<void> {
    const c = CIRCUITS[circuit ?? ''];
    if (!c) return;
    await db
      .insertInto('rain_grid')
      .values({
        session_key: key,
        source: 'open-meteo',
        map_id: c.id,
        centre_lat: c.lat,
        centre_lon: c.lon,
        size: GRID.size,
        step_m: GRID.stepM,
        state: 'live',
        next_fetch_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.column('session_key').doNothing())
      .execute();
  }

  /** A failure is its own short locked write. Never throws: an unrecorded failure leaves the grid as it was. */
  async function fail(key: number, at: Date, code: RainCode): Promise<{ state: string; unrecorded?: string }> {
    try {
      return await db.transaction().execute(async (trx) => {
        const row = await countAttempt(trx, key, at);
        if (row?.state !== 'live') return { state: row?.state ?? 'gone' };
        const next = afterRainFailure(row, at, code);
        await trx.updateTable('rain_grid').set(next).where('session_key', '=', key).execute();
        return { state: next.state };
      });
    } catch (err) {
      return { state: 'unchanged', unrecorded: codeOf(err) };
    }
  }

  /**
   * One fetch, then one transaction: lock the grid and count the attempt, replace its frames, set its state. Never
   * throws; one log line.
   */
  async function processGrid(g: Due): Promise<void> {
    const started = performance.now();
    const at = now();
    const key = g.session_key;
    const points = g.size * g.size;
    const api = apiFor(g, at);
    let code: RainCode | undefined;
    let cause: string | undefined;
    let done: { state: string; frames: number; unrecorded?: string } | undefined;
    try {
      const { from, to } = frameWindow(g, at, api);
      const query = rainQuery(gridPoints(g.centre_lat, g.centre_lon, g.size, g.step_m), from, to);
      const fetched = await client.get(api, query, { points, from, to });
      if (!fetched.ok) code = rainErrorCode(fetched.error);
      else {
        const frames = toFrames(fetched.value);
        try {
          done = await db.transaction().execute(async (trx) => {
            const row = await countAttempt(trx, key, at);
            if (row?.state !== 'live') return { state: row?.state ?? 'gone', frames: 0 }; // changed meanwhile
            await trx.deleteFrom('rain_frame').where('session_key', '=', key).execute();
            if (frames.length > 0)
              await trx
                .insertInto('rain_frame')
                // The cast: the generated type says number[], but a real[] element may be null.
                .values(frames.map((f) => ({ session_key: key, date: f.date, mm: f.mm as number[] })))
                .execute();
            const next = afterRainSuccess({ date_end: g.date_end, fetch_count: row.fetch_count }, at, api);
            await trx.updateTable('rain_grid').set(next).where('session_key', '=', key).execute();
            return { state: next.state, frames: frames.length };
          });
        } catch (err) {
          code = 'db';
          cause = codeOf(err);
        }
      }
    } catch (err) {
      code = 'unknown'; // a bug must not stop the step at this grid for good
      cause = codeOf(err);
    }
    if (code) done = { ...(await fail(key, at, code)), frames: 0 };
    const line = {
      session_key: key,
      api,
      ...done,
      points,
      ms: Math.round(performance.now() - started),
      last_error: code ?? null,
      cause,
    };
    if (code) log.error(line, 'rain');
    else log.info(line, 'rain');
    beat();
  }

  /**
   * New grids for sessions in their live window (database only), then at most one Open-Meteo request (C4): the due
   * grid with the newest date_end, else one backfill session. So the busy guard never waits on more than one request,
   * and none while a 429's pause lasts. Never rejects: the busy guard's precondition.
   */
  return async function rainStep(stopping: () => boolean): Promise<void> {
    beat();
    try {
      const at = now();
      const t = at.getTime();
      if (!seeded) {
        await seed(at);
        seeded = true;
      }
      if (!unmappedLogged) {
        // Every session that has or would have had a grid by now, whose circuit has no outline.
        const { count } = await gridless(db)
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('session.is_cancelled', '=', false)
          .where('session.date_start', '<=', new Date(t + LIVE_MARGIN_MS))
          .where((eb) =>
            eb.or([eb('meeting.circuit_short_name', 'is', null), eb('meeting.circuit_short_name', 'not in', MAPPED)]),
          )
          .executeTakeFirstOrThrow();
        if (Number(count) > 0) {
          log.info({ count: Number(count) }, 'rain_unmapped');
          unmappedLogged = true;
        }
      }

      const live = await gridless(db)
        .select([
          'session.session_key',
          'session.date_start',
          'session.date_end',
          'session.is_cancelled',
          'meeting.circuit_short_name',
        ])
        .where('session.date_start', '<=', new Date(t + LIVE_MARGIN_MS))
        .where('session.date_end', '>', new Date(t - LIVE_MARGIN_MS))
        .where('meeting.circuit_short_name', 'in', MAPPED)
        .execute();
      for (const s of live.filter((s) => inLiveWindow(s, at)))
        await insertGrid(s.session_key, s.circuit_short_name, at);

      if (stopping() || paused()) return;
      const due = await dueGrid(db, at);
      if (due) {
        // A backfill grid that has never succeeded retries on the backfill's share; a live grid's final fetch on live's.
        if (take(apiFor(due, at) === 'historical' && due.fetch_count === 0 ? 'backfill' : 'live'))
          await processGrid(due);
        return;
      }

      const past = await gridless(db)
        .select(['session.session_key', 'meeting.circuit_short_name'])
        .where('session.is_cancelled', '=', false)
        .where('session.date_end', '<=', new Date(t - FINAL_AFTER_MS))
        .where(sql<boolean>`session.date_end - session.date_start <= interval '12 hours'`)
        .where('meeting.circuit_short_name', 'in', MAPPED)
        .orderBy('session.date_end', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (past && take('backfill')) {
        await insertGrid(past.session_key, past.circuit_short_name, at);
        const g = await dueGrid(db, at, past.session_key);
        if (g) await processGrid(g);
      }
    } catch (err) {
      log.error({ cause: codeOf(err) }, 'rain failed'); // the code only
    } finally {
      beat();
    }
  };
}
