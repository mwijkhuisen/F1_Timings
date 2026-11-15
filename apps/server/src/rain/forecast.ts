import { CIRCUITS } from '@f1/contracts';
import { type Kysely, sql, type Transaction } from 'kysely';
import { codeOf, type DB } from '../db/db.ts';
import type { BudgetKind } from './client.ts';
import { minute } from './grid.ts';
import type { RainDeps } from './job.ts';
import { afterRainFailure, type RainCode, type RainProgress, rainErrorCode } from './state.ts';

// The weekend forecast (#120, A§8): one Open-Meteo forecast per meeting at its circuit's centre, every 3 h from the
// Wednesday before its first session until its last session ends. A step of the rain job, so it shares the client,
// the budget and the one request per run (C4). Logs carry keys, states, counts and fixed codes only: never a value,
// a URL, a coordinate or a body.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEDNESDAY = 3;
export const FORECAST_REFRESH_MS = 3 * HOUR_MS;
/** A meeting longer than this (a bad date) gets no forecast: one call is one location-call only below 2 weeks (U2). */
export const MAX_MEETING_MS = 7 * DAY_MS;
const MAPPED = Object.keys(CIRCUITS);

export const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const ceilHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS;

/** C1: 00:00 UTC of the Wednesday on or before `first` (its UTC weekday). */
export function opensAt(first: Date): Date {
  const midnight = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  return new Date(midnight - ((first.getUTCDay() - WEDNESDAY + 7) % 7) * DAY_MS);
}

/**
 * C2: one point (4 decimals) and four hourly variables over [fromMs, toMs], both on the hour, in unixtime so the
 * answer carries no zone, wind in m/s (the Weather tab's unit). `land` is Open-Meteo's default, set explicitly: one
 * centre point wants a land cell at a similar height for its temperature (the grid's `nearest`, U5, is about points
 * at sea). Open-Meteo dates an hourly sum by the hour's end.
 */
export function forecastQuery(lat: number, lon: number, fromMs: number, toMs: number): Record<string, string> {
  if (fromMs !== floorHour(fromMs) || toMs !== floorHour(toMs) || toMs < fromMs) {
    throw new RangeError('the forecast window must run between whole hours');
  }
  return {
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'precipitation_probability,precipitation,temperature_2m,wind_speed_10m',
    start_hour: minute(fromMs),
    end_hour: minute(toMs),
    timeformat: 'unixtime',
    timezone: 'GMT',
    wind_speed_unit: 'ms',
    cell_selection: 'land',
  };
}

/** C5: the next refresh 3 h on; final once that is at or past `close` (the last session's end). */
export function afterForecastSuccess(f: { fetch_count: number }, at: Date, close: Date): RainProgress {
  const done = { fetch_count: f.fetch_count + 1, fail_count: 0, last_error: null };
  const next = at.getTime() + FORECAST_REFRESH_MS;
  return next >= close.getTime()
    ? { ...done, state: 'final', next_fetch_at: null }
    : { ...done, state: 'live', next_fetch_at: new Date(next) };
}

/** C5: the rain's back-off (the 9th failure in a row → failed); a retry at or past `close` → final. */
export function afterForecastFailure(
  f: { fetch_count: number; fail_count: number },
  at: Date,
  code: RainCode,
  close: Date,
): RainProgress {
  const next = afterRainFailure(f, at, code);
  return next.next_fetch_at !== null && next.next_fetch_at.getTime() >= close.getTime()
    ? { ...next, state: 'final', next_fetch_at: null }
    : next;
}

type Take = (kind: BudgetKind, n?: number) => boolean;

/** The live forecast due longest, with its meeting's first start and last end over the sessions not cancelled. */
const dueForecast = (db: Kysely<DB>, at: Date) =>
  db
    .selectFrom('forecast')
    .innerJoin('meeting', 'meeting.meeting_key', 'forecast.meeting_key')
    .leftJoin('session', (join) =>
      join.onRef('session.meeting_key', '=', 'forecast.meeting_key').on('session.is_cancelled', '=', false),
    )
    .select(['forecast.meeting_key', 'forecast.lat', 'forecast.lon', 'meeting.is_cancelled'])
    .select((eb) => [eb.fn.min('session.date_start').as('first'), eb.fn.max('session.date_end').as('last')])
    .where('forecast.state', '=', 'live')
    .where('forecast.next_fetch_at', '<=', at)
    .groupBy(['forecast.meeting_key', 'meeting.is_cancelled'])
    .orderBy('forecast.next_fetch_at')
    .orderBy('forecast.meeting_key')
    .limit(1)
    .executeTakeFirst();
type Due = NonNullable<Awaited<ReturnType<typeof dueForecast>>>;

/** Locks the forecast and counts the attempt, in the transaction that records its outcome (as the rain's). */
const countAttempt = (trx: Transaction<DB>, key: number, at: Date) =>
  trx
    .updateTable('forecast')
    .set((eb) => ({ attempt_count: eb('attempt_count', '+', 1), updated_at: at }))
    .where('meeting_key', '=', key)
    .returning(['state', 'fetch_count', 'fail_count'])
    .executeTakeFirst();

/** The rain step's forecast part: `seed` and `open` touch the database only, `run` makes at most one request. None rejects. */
export function createForecastStep({ db, client, budget, log, beat, ping }: RainDeps) {
  /** D3, as the rain's seed: the attempts of every forecast touched in the last 24 h (and hour), as made now. */
  async function seedNow(at: Date): Promise<void> {
    const t = at.getTime();
    const { rows } = await sql<{ day: string | null; hour: string | null }>`
      SELECT sum(attempt_count) AS day,
             sum(attempt_count) FILTER (WHERE updated_at > ${new Date(t - HOUR_MS)}) AS hour
      FROM forecast WHERE updated_at > ${new Date(t - DAY_MS)}`.execute(db);
    budget.seed(Number(rows[0]?.day ?? 0), Number(rows[0]?.hour ?? 0), 'forecast');
  }

  /** C1: a live forecast, due now, for each meeting in its window without one (mapped, not cancelled, ≤ 7 days). */
  async function openNow(at: Date): Promise<void> {
    const t = at.getTime();
    const meetings = await db
      .selectFrom('meeting')
      .innerJoin('session', 'session.meeting_key', 'meeting.meeting_key')
      .select(['meeting.meeting_key', 'meeting.circuit_short_name'])
      .select((eb) => [eb.fn.min('session.date_start').as('first'), eb.fn.max('session.date_end').as('last')])
      .where('meeting.is_cancelled', '=', false)
      .where('session.is_cancelled', '=', false)
      .where('meeting.circuit_short_name', 'in', MAPPED)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('forecast').select('meeting_key').whereRef('forecast.meeting_key', '=', 'meeting.meeting_key'),
          ),
        ),
      )
      .groupBy('meeting.meeting_key')
      // A window opens less than 7 days before the first start and closes at the last end.
      .having((eb) =>
        eb.and([
          eb(eb.fn.min('session.date_start'), '<', new Date(t + 7 * DAY_MS)),
          eb(eb.fn.max('session.date_end'), '>', at),
        ]),
      )
      .execute();
    for (const m of meetings) {
      const c = CIRCUITS[m.circuit_short_name ?? ''];
      if (!c || m.last.getTime() - m.first.getTime() > MAX_MEETING_MS || opensAt(m.first).getTime() > t) continue;
      await db
        .insertInto('forecast')
        .values({
          meeting_key: m.meeting_key,
          source: 'open-meteo',
          map_id: c.id,
          lat: c.lat,
          lon: c.lon,
          state: 'live',
          next_fetch_at: at,
          updated_at: at,
        })
        .onConflict((oc) => oc.column('meeting_key').doNothing())
        .execute();
    }
  }

  // `seed` (once, retried on a later run after a fault) and `open` never reject: a fault of the forecast's own tables
  // is logged as a code and must not stop the rain step.
  let seeded = false;
  async function seed(at: Date): Promise<void> {
    if (seeded) return;
    try {
      await seedNow(at);
      seeded = true;
    } catch (err) {
      log.error({ cause: codeOf(err) }, 'forecast failed'); // the code only
    }
  }
  async function open(at: Date): Promise<void> {
    try {
      await openNow(at);
    } catch (err) {
      log.error({ cause: codeOf(err) }, 'forecast failed');
    }
  }

  /** C5: a cancelled meeting, one without sessions or past its close becomes final, with no request. */
  async function close(key: number, at: Date): Promise<void> {
    const started = performance.now();
    await db
      .updateTable('forecast')
      .set({ state: 'final', next_fetch_at: null, updated_at: at })
      .where('meeting_key', '=', key)
      .where('state', '=', 'live')
      .execute();
    const ms = Math.round(performance.now() - started);
    log.info({ meeting_key: key, state: 'final', hours: 0, ms, last_error: null }, 'forecast');
  }

  /** A short locked write; one that makes a live forecast failed pings `f1-ingest/fail`. Never throws. */
  async function fail(
    key: number,
    at: Date,
    code: RainCode,
    end: Date,
  ): Promise<{ state: string; unrecorded?: string }> {
    try {
      const done = await db.transaction().execute(async (trx) => {
        const row = await countAttempt(trx, key, at);
        if (row?.state !== 'live') return { state: row?.state ?? 'gone', newly: false };
        const next = afterForecastFailure(row, at, code, end);
        await trx.updateTable('forecast').set(next).where('meeting_key', '=', key).execute();
        return { state: next.state, newly: next.state === 'failed' };
      });
      if (done.newly) await ping?.('f1-ingest/fail', `forecast_failed ${code}`);
      return { state: done.state };
    } catch (err) {
      return { state: 'unchanged', unrecorded: codeOf(err) };
    }
  }

  /**
   * One fetch, then one transaction: lock the forecast and count the attempt, replace its hours, set its state and
   * fetched_at. Never throws; one log line.
   */
  async function fetchOne(f: Due & { first: Date; last: Date }, at: Date): Promise<void> {
    const started = performance.now();
    const key = f.meeting_key;
    let code: RainCode | undefined;
    let cause: string | undefined;
    let done: { state: string; hours: number; unrecorded?: string } | undefined;
    try {
      const from = floorHour(f.first.getTime());
      const to = ceilHour(f.last.getTime());
      const fetched = await client.forecast(forecastQuery(f.lat, f.lon, from, to), { from, to });
      if (!fetched.ok) code = rainErrorCode(fetched.error);
      else {
        const h = fetched.value;
        const hours = h.time.map((t, i) => ({
          meeting_key: key,
          date: new Date(t * 1000),
          precipitation_probability: h.precipitation_probability[i] ?? null,
          precipitation: h.precipitation[i] ?? null,
          temperature_2m: h.temperature_2m[i] ?? null,
          wind_speed_10m: h.wind_speed_10m[i] ?? null,
        }));
        try {
          done = await db.transaction().execute(async (trx) => {
            const row = await countAttempt(trx, key, at);
            if (row?.state !== 'live') return { state: row?.state ?? 'gone', hours: 0 }; // changed meanwhile
            await trx.deleteFrom('forecast_hour').where('meeting_key', '=', key).execute();
            await trx.insertInto('forecast_hour').values(hours).execute(); // at least one (parseForecast)
            const next = afterForecastSuccess(row, at, f.last);
            await trx
              .updateTable('forecast')
              .set({ ...next, fetched_at: at })
              .where('meeting_key', '=', key)
              .execute();
            return { state: next.state, hours: hours.length };
          });
        } catch (err) {
          code = 'db';
          cause = codeOf(err);
        }
      }
    } catch (err) {
      code = 'unknown'; // a bug must not stop the step at this forecast for good
      cause = codeOf(err);
    }
    if (code) done = { ...(await fail(key, at, code, f.last)), hours: 0 };
    const line = {
      meeting_key: key,
      ...done,
      ms: Math.round(performance.now() - started),
      last_error: code ?? null,
      cause,
    };
    if (code) log.error(line, 'forecast');
    else log.info(line, 'forecast');
    beat();
  }

  /**
   * C4, C5: the due forecast with the oldest next_fetch_at. True only if it made a request; a refusal of the share
   * (or nothing due) lets the backfill have the run. Never rejects.
   */
  async function run(at: Date, take: Take): Promise<boolean> {
    try {
      const due = await dueForecast(db, at);
      if (!due) return false;
      const { first, last } = due;
      if (
        due.is_cancelled ||
        first === null ||
        last === null ||
        at >= last ||
        last.getTime() - first.getTime() > MAX_MEETING_MS
      ) {
        await close(due.meeting_key, at);
        return false;
      }
      if (!take('forecast', 1)) return false;
      await fetchOne({ ...due, first, last }, at);
      return true;
    } catch (err) {
      log.error({ cause: codeOf(err) }, 'forecast failed'); // the code only
      return false;
    }
  }

  return { seed, open, run };
}
