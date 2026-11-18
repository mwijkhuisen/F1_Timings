import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CIRCUITS,
  type Forecast,
  isUnmatched,
  PERIOD_LIKE,
  type Rain,
  REVISION,
  type Seasons,
  type Standings,
  type Status,
  type Stints,
  type Telemetry,
} from '@f1/contracts';
import type { HttpBindings } from '@hono/node-server';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import { createFrames } from '../live/fit.ts';
import { OUTLINES } from '../live/outlines.ts';
import { playback } from '../live/playback.ts';
import { AFTER_MS } from '../live/recorder.ts';
import { zCounts } from '../live/telemetry.ts';
import { unpackCar, unpackPos } from '../telemetry/pack.ts';
import { colours } from '../timing/colours.ts';
import { counted, type StandingsSeason, standings, standingsMismatches } from '../timing/standings.ts';

// The api role's routes (A§10). JSON uses the A§7 column names; answers match the zod contracts in
// packages/contracts. No body or log echoes input, a header, the token or a database message.

const NO_STORE = { 'Cache-Control': 'no-store' };
const FINAL = { 'Cache-Control': 'private, max-age=86400' };
const STALE_MS = 5 * 60_000; // the recorder reports every few seconds
const WRITE_TIMEOUT_MS = 60_000; // one SSE write (or ping) that takes longer ends the stream (a stalled client)
const MAX_STREAMS = 8; // per process: each holds a file handle, a state and a timer
const SPEEDS = [1, 2, 4, 8, 16];
const STATES = ['scheduled', 'due', 'fetched', 'final', 'failed'] as const;

const badRequest = (c: Context) => c.json({ error: 'bad request' }, 400, NO_STORE);
const notFound = (c: Context) => c.json({ error: 'not found' }, 404, NO_STORE);

const sessionKey = (c: Context) => {
  const key = c.req.param('key') ?? '';
  return /^\d{1,9}$/.test(key) ? Number(key) : undefined;
};

export function createApp({
  db,
  access,
  log,
  liveDir,
  revision = 'dev',
  writeTimeoutMs = WRITE_TIMEOUT_MS,
}: {
  db: Kysely<DB>;
  access: MiddlewareHandler;
  /** `info` is the request line (#108) and the playback open line (#101): fixed fields, never input or feed text. */
  log: Pick<Logger, 'error' | 'info'>;
  /** The recordings' root (A§11.2), read-only here. */
  liveDir: string;
  /** The release's git commit or `dev` (A§10): the `F1-Revision` header and the check of a request's `v`. */
  revision?: string;
  /** For tests only. */
  writeTimeoutMs?: number;
}) {
  let streams = 0;
  const frames = createFrames(log); // the map frames by recording (P7a, D2)
  /** A§10: the web's `?v=<revision>` is a cache key. null when absent; else exactly one REVISION value, or the 400. */
  const version = (c: Context): string | null | Response => {
    const v = c.req.queries('v');
    if (v === undefined) return null;
    return v.length === 1 && REVISION.test(v[0] as string) ? (v[0] as string) : badRequest(c);
  };
  /** A§10: a final session's data no longer changes, unless it answers a request made for another revision. */
  const cache = (state: string, v: string | null) =>
    state === 'final' && (v === null || v === revision) ? FINAL : NO_STORE;
  /** The session of a per-session route: its key, state and `v`, or the 400/404 answer. */
  const lookup = async (c: Context): Promise<{ key: number; state: string; v: string | null } | Response> => {
    const key = sessionKey(c);
    if (key === undefined) return badRequest(c);
    const v = version(c);
    if (v instanceof Response) return v;
    const row = await db.selectFrom('session').select('ingest_state').where('session_key', '=', key).executeTakeFirst();
    return row ? { key, state: row.ingest_state, v } : notFound(c);
  };
  const app = new Hono();

  // One line per request (#108, A§14.5), a 401 included: the matched route's pattern (from the code),
  // never the URL, a query, a header or a body. The method is one of Node's parser's fixed list.
  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start); // for the stream: until its headers
    log.info({ method: c.req.method, route: routePath(c, -1), status: c.res.status, ms }, 'request');
  });

  // The only route without the JWT check (the update smoke test); through the tunnel it is behind Access.
  app.get('/healthz', async (c) => {
    try {
      await sql`select 1`.execute(db);
      return c.json({ ok: true }, 200, NO_STORE);
    } catch {
      return c.json({ ok: false }, 503, NO_STORE);
    }
  });

  // Every method and every path under /api, unknown ones included.
  app.use('/api/*', access);

  const api = new Hono();
  api.use('*', async (c, next) => {
    c.header('F1-Revision', revision);
    await next();
  });

  api.get('/seasons', async (c) => {
    const rows: Seasons = await db
      .selectFrom('meeting as m')
      .leftJoin('session as s', (join) =>
        join.onRef('s.meeting_key', '=', 'm.meeting_key').on('s.is_cancelled', '=', false),
      )
      .where('m.is_cancelled', '=', false)
      .select([
        'm.year',
        sql<number>`count(distinct m.meeting_key)::int`.as('meetings'),
        sql<number>`count(s.session_key)::int`.as('sessions'),
      ])
      .groupBy('m.year')
      .orderBy('m.year', 'desc')
      .execute();
    return c.json(rows, 200, NO_STORE);
  });

  api.get('/seasons/:year', async (c) => {
    const year = c.req.param('year');
    if (!/^\d{4}$/.test(year)) return badRequest(c);
    const meetings = await db
      .selectFrom('meeting')
      .select([
        'meeting_key',
        'name',
        'official_name',
        'location',
        'country_code',
        'circuit_short_name',
        'gmt_offset',
        'date_start',
        'date_end',
        'is_cancelled',
      ])
      .where('year', '=', Number(year))
      .orderBy('date_start')
      .orderBy('meeting_key')
      .execute();
    if (meetings.length === 0) return notFound(c);
    const sessions = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.meeting_key',
        's.session_key',
        's.type',
        's.name',
        's.date_start',
        's.date_end',
        's.ingest_state',
        's.is_cancelled',
      ])
      .where('m.year', '=', Number(year))
      .orderBy('s.date_start')
      .orderBy('s.session_key')
      .execute();
    const body = meetings.map((m) => ({
      ...m,
      sessions: sessions.filter((s) => s.meeting_key === m.meeting_key).map(({ meeting_key: _, ...s }) => s),
    }));
    return c.json(body, 200, NO_STORE);
  });

  api.get('/sessions/:key', async (c) => {
    const key = sessionKey(c);
    if (key === undefined) return badRequest(c);
    const v = version(c);
    if (v instanceof Response) return v;
    const row = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        's.type',
        's.name',
        's.date_start',
        's.date_end',
        's.ingest_state',
        's.is_cancelled',
        's.meeting_key',
        's.source',
        's.fetch_count',
        's.fail_count',
        's.last_error',
        's.next_fetch_at',
        'm.name as m_name',
        'm.official_name',
        'm.location',
        'm.country_code',
        'm.circuit_short_name',
        'm.gmt_offset',
        'm.date_start as m_date_start',
        'm.date_end as m_date_end',
        'm.is_cancelled as m_is_cancelled',
        'm.year',
      ])
      .where('s.session_key', '=', key)
      .executeTakeFirst();
    if (!row) return notFound(c);
    const drivers = await db
      .selectFrom('driver')
      .select(['driver_number', 'acronym', 'full_name', 'team_name', 'team_colour'])
      .where('session_key', '=', key)
      .orderBy('driver_number')
      .execute();
    const results = await db
      .selectFrom('result')
      .select(['driver_number', 'position', 'laps', 'grid', 'dnf', 'dns', 'dsq', 'durations_ms', 'gaps_ms'])
      .where('session_key', '=', key)
      .orderBy(sql`position nulls last`)
      .orderBy('driver_number')
      .execute();
    const body = {
      session: {
        session_key: row.session_key,
        type: row.type,
        name: row.name,
        date_start: row.date_start,
        date_end: row.date_end,
        ingest_state: row.ingest_state,
        is_cancelled: row.is_cancelled,
        meeting_key: row.meeting_key,
        source: row.source,
        fetch_count: row.fetch_count,
        fail_count: row.fail_count,
        last_error: row.last_error,
        next_fetch_at: row.next_fetch_at,
      },
      meeting: {
        meeting_key: row.meeting_key,
        name: row.m_name,
        official_name: row.official_name,
        location: row.location,
        country_code: row.country_code,
        circuit_short_name: row.circuit_short_name,
        gmt_offset: row.gmt_offset,
        date_start: row.m_date_start,
        date_end: row.m_date_end,
        is_cancelled: row.m_is_cancelled,
        year: row.year,
      },
      drivers,
      results,
    };
    return c.json(body, 200, cache(row.ingest_state, v));
  });

  api.get('/sessions/:key/laps', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const laps = await db
      .selectFrom('lap as l')
      // P7b: only the two figures of telemetry_lap, never its bytea columns (nothing is detoasted).
      .leftJoin('telemetry_lap as tl', (join) =>
        join
          .onRef('tl.session_key', '=', 'l.session_key')
          .onRef('tl.driver_number', '=', 'l.driver_number')
          .onRef('tl.lap_number', '=', 'l.lap_number'),
      )
      .select((eb) => [
        'l.driver_number',
        'l.lap_number',
        'l.date_start',
        'l.lap_ms',
        'l.s1_ms',
        'l.s2_ms',
        'l.s3_ms',
        'l.i1_kph',
        'l.i2_kph',
        'l.st_kph',
        'tl.top_kph',
        'tl.full_throttle',
        'l.is_pit_out',
        'l.is_pit_in',
        'l.seg1',
        'l.seg2',
        'l.seg3',
        'l.deleted',
        'l.deleted_reason',
        'l.quali_phase',
        // The stint covering the lap; when two do, the later one.
        eb
          .selectFrom('stint as st')
          .select('st.compound')
          .whereRef('st.session_key', '=', 'l.session_key')
          .whereRef('st.driver_number', '=', 'l.driver_number')
          .whereRef('st.lap_start', '<=', 'l.lap_number')
          .whereRef('st.lap_end', '>=', 'l.lap_number')
          .orderBy('st.stint_number', 'desc')
          .limit(1)
          .as('compound'),
      ])
      .where('l.session_key', '=', session.key)
      .orderBy('l.driver_number')
      .orderBy('l.lap_number')
      .execute();
    const colour = colours(laps);
    const body = laps.map((l, i) => ({ ...l, colour: colour[i] }));
    return c.json(body, 200, cache(session.state, session.v));
  });

  api.get('/sessions/:key/stints', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const body: Stints = await db
      .selectFrom('stint')
      .select(['driver_number', 'stint_number', 'lap_start', 'lap_end', 'compound', 'tyre_age_at_start'])
      .where('session_key', '=', session.key)
      .orderBy('driver_number')
      .orderBy('stint_number')
      .execute();
    return c.json(body, 200, cache(session.state, session.v));
  });

  api.get('/sessions/:key/pits', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const body = await db
      .selectFrom('pit')
      .select(['driver_number', 'lap_number', 'date', 'pit_ms', 'lane_ms', 'stop_ms'])
      .where('session_key', '=', session.key)
      .orderBy('date')
      .orderBy('driver_number')
      .orderBy('lap_number')
      .execute();
    return c.json(body, 200, cache(session.state, session.v));
  });

  api.get('/sessions/:key/race-control', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const body = await db
      .selectFrom('race_control')
      .select([
        'date',
        'category',
        'flag',
        'scope',
        'sector',
        'driver_number',
        'lap_number',
        'qualifying_phase',
        'message',
      ])
      .where('session_key', '=', session.key)
      .orderBy('date')
      .orderBy('id')
      .execute();
    return c.json(body, 200, cache(session.state, session.v));
  });

  // #236: the places gained per move, as fill stored them from the F1 feed; [] for a session without the topic.
  api.get('/sessions/:key/overtakes', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const body = await db
      .selectFrom('overtake')
      .select(['driver_number', 'date', 'places'])
      .where('session_key', '=', session.key)
      .orderBy('date')
      .orderBy('driver_number')
      .orderBy('id')
      .execute();
    return c.json(body, 200, cache(session.state, session.v));
  });

  api.get('/sessions/:key/weather', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const body = await db
      .selectFrom('weather')
      .select([
        'date',
        'air_temperature',
        'track_temperature',
        'humidity',
        'pressure',
        'rainfall',
        'wind_direction',
        'wind_speed',
      ])
      .where('session_key', '=', session.key)
      .orderBy('date')
      .execute();
    return c.json(body, 200, cache(session.state, session.v));
  });

  api.get('/sessions/:key/rain', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const grid = await db
      .selectFrom('rain_grid')
      .select(['map_id', 'centre_lat', 'centre_lon', 'size', 'step_m', 'state'])
      .where('session_key', '=', session.key)
      .executeTakeFirst();
    const frames = grid
      ? await db
          .selectFrom('rain_frame')
          .select(['date', 'mm'])
          .where('session_key', '=', session.key)
          .orderBy('date')
          .execute()
      : [];
    const body: Rain = {
      grid: grid ? { ...grid, state: grid.state as 'live' | 'final' | 'failed' } : null,
      frames: frames.map((f) => ({ date: f.date.toISOString(), mm: f.mm })),
    };
    // Immutable only when the grid will never change: its own state, not just the session's.
    return c.json(body, 200, cache(grid?.state === 'final' ? session.state : 'live', session.v));
  });

  // P7b (A§10): one driver-lap, at most TELEMETRY_MAX_SAMPLES samples a topic (the DDL CHECK, and unpack again here).
  // driver and lap are each given once; a malformed row throws into the 500 `internal`, nothing echoed.
  api.get('/sessions/:key/telemetry', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const [driver, lap] = ['driver', 'lap'].map((name) => {
      const all = c.req.queries(name);
      return all?.length === 1 && /^\d{1,4}$/.test(all[0] as string) ? Number(all[0]) : null;
    });
    if (driver === null || lap === null) return badRequest(c);
    const row = await db
      .selectFrom('telemetry_lap')
      .select(['source', 'date_start', 'car', 'pos', 'top_kph', 'full_throttle'])
      .where('session_key', '=', session.key)
      .where('driver_number', '=', driver as number)
      .where('lap_number', '=', lap as number)
      .executeTakeFirst();
    if (!row) return notFound(c);
    const body: Telemetry = {
      source: row.source as Telemetry['source'],
      date_start: row.date_start.toISOString(),
      top_kph: row.top_kph,
      full_throttle: row.full_throttle,
      car: unpackCar(row.car),
      pos: unpackPos(row.pos),
    };
    return c.json(body, 200, cache(session.state, session.v));
  });

  // P8 (A§9, A§10): the championship standings after S, computed from S's season only and, of the sessions after S,
  // nothing but the next counted session's points_start (no later result, no points_current). Not a counted
  // session: empty arrays. Immutable only when every counted session up to S is final and the standing is no fallback.
  api.get('/sessions/:key/standings', async (c) => {
    const key = sessionKey(c);
    if (key === undefined) return badRequest(c);
    const v = version(c);
    if (v instanceof Response) return v;
    const row = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select(['s.ingest_state', 'm.year'])
      .where('s.session_key', '=', key)
      .executeTakeFirst();
    if (!row) return notFound(c);
    const sessions = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        's.source',
        's.type',
        's.name',
        's.date_start',
        's.is_cancelled',
        's.ingest_state',
        'm.name as meeting_name',
      ])
      .where('m.year', '=', row.year)
      .execute();
    const all = counted({ year: row.year, sessions });
    const i = all.findIndex((s) => s.session_key === key);
    if (i < 0) {
      const body: Standings = standings(
        { year: row.year, sessions, drivers: [], results: [], championship_drivers: [], championship_teams: [] },
        key,
      );
      return c.json(body, 200, cache(row.ingest_state, v));
    }
    const upTo = all.slice(0, i + 1).map((s) => s.session_key);
    const withNext = all.slice(0, i + 2).map((s) => s.session_key); // N's points_start is the only later row read
    const season: StandingsSeason = {
      year: row.year,
      sessions,
      // Identity only (a number's person and team), any session of the season.
      drivers: await db
        .selectFrom('driver')
        .select(['session_key', 'driver_number', 'full_name', 'acronym', 'team_name', 'team_colour'])
        .where(
          'session_key',
          'in',
          sessions.map((s) => s.session_key),
        )
        .execute(),
      results: await db
        .selectFrom('result')
        .select(['session_key', 'driver_number', 'position', 'points'])
        .where('session_key', 'in', upTo)
        .execute(),
      championship_drivers: await db
        .selectFrom('championship_driver')
        .select(['session_key', 'driver_number', 'points_start'])
        .where('session_key', 'in', withNext)
        .execute(),
      championship_teams: await db
        .selectFrom('championship_team')
        .select(['session_key', 'team_name', 'points_start'])
        .where('session_key', 'in', withNext)
        .execute(),
    };
    const body: Standings = standings(season, key);
    const settled = !body.provisional && all.slice(0, i + 1).every((s) => s.ingest_state === 'final');
    return c.json(body, 200, cache(settled ? 'final' : 'live', v));
  });

  // #120 (D1): a meeting's weekend forecast, null until its first success. Always no-store: it changes every 3 h.
  api.get('/meetings/:key/forecast', async (c) => {
    const key = sessionKey(c); // the same 1-9 digits
    if (key === undefined) return badRequest(c);
    const forecast = await db
      .selectFrom('meeting')
      .leftJoin('forecast', 'forecast.meeting_key', 'meeting.meeting_key')
      .select(['forecast.map_id', 'forecast.fetched_at'])
      .where('meeting.meeting_key', '=', key)
      .executeTakeFirst();
    if (!forecast) return notFound(c);
    if (forecast.map_id === null || forecast.fetched_at === null) return c.json(null, 200, NO_STORE);
    const hours = await db
      .selectFrom('forecast_hour')
      .select(['date', 'precipitation_probability', 'precipitation', 'temperature_2m', 'wind_speed_10m'])
      .where('meeting_key', '=', key)
      .orderBy('date')
      .execute();
    const body: Forecast = {
      map_id: forecast.map_id,
      fetched_at: forecast.fetched_at.toISOString(),
      hours: hours.map((h) => ({ ...h, date: h.date.toISOString() })),
    };
    return c.json(body, 200, NO_STORE);
  });

  api.get('/status', async (c) => {
    const counts = await db
      .selectFrom('session')
      .select(['ingest_state', 'is_cancelled', sql<number>`count(*)::int`.as('n')])
      .groupBy(['ingest_state', 'is_cancelled'])
      .execute();
    // Every session whose last attempt failed: retrying (with next_fetch_at) or `failed` for good.
    const failed = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        'm.year',
        'm.name as meeting_name',
        's.name as session_name',
        's.fail_count',
        's.last_error',
        's.next_fetch_at',
      ])
      .where('s.fail_count', '>', 0)
      .orderBy('s.date_start', 'desc')
      .orderBy('s.session_key')
      .execute();
    const states = Object.fromEntries(STATES.map((state) => [state, 0])) as Status['states'];
    let cancelled = 0;
    for (const { ingest_state, is_cancelled, n } of counts) {
      if (is_cancelled) cancelled += n;
      else if (ingest_state in states) states[ingest_state as keyof Status['states']] += n;
    }
    const row = await db
      .selectFrom('recorder_status as r')
      .leftJoin('session as s', 's.session_key', 'r.session_key')
      .leftJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        'r.state',
        'r.session_key',
        'm.name as meeting_name',
        's.name as session_name',
        'r.token_expires_at',
        'r.last_error',
        'r.warning',
        'r.updated_at',
      ])
      .executeTakeFirst();
    const recorder = row && { ...row, stale: Date.now() - row.updated_at.getTime() > STALE_MS };
    const ingestRow = await db.selectFrom('ingest_status').selectAll().executeTakeFirst();
    const ingest = ingestRow && {
      last_sync_at: ingestRow.last_sync_at,
      live_wait: ingestRow.live_wait,
      last_tick_at: ingestRow.last_tick_at,
      // A tick stamped more than a minute ahead of this clock is no sign of life either.
      stale:
        Date.now() - ingestRow.last_tick_at.getTime() > STALE_MS ||
        ingestRow.last_tick_at.getTime() - Date.now() > 60_000,
    };
    const rainStates: Status['rain']['states'] = { live: 0, final: 0, failed: 0 };
    const rainCounts = await db
      .selectFrom('rain_grid')
      .select(['state', sql<number>`count(*)::int`.as('n')])
      .groupBy('state')
      .execute();
    for (const { state, n } of rainCounts) if (state in rainStates) rainStates[state as keyof typeof rainStates] = n;
    const rainFailed = await db
      .selectFrom('rain_grid as g')
      .innerJoin('session as s', 's.session_key', 'g.session_key')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        'm.year',
        'm.name as meeting_name',
        's.name as session_name',
        'g.fail_count',
        'g.last_error',
        'g.next_fetch_at',
      ])
      .where('g.fail_count', '>', 0)
      .orderBy('s.date_start', 'desc')
      .orderBy('s.session_key')
      .execute();
    // Computed on read (A§6.1): the period-like rows of races, narrowed in SQL, then the forms in TS.
    const period = await db
      .selectFrom('race_control as r')
      .innerJoin('session as s', 's.session_key', 'r.session_key')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        'm.year',
        'm.name as meeting_name',
        's.name as session_name',
        's.date_start',
        'r.message',
        'r.flag',
      ])
      .where('s.type', '=', 'Race')
      .where('s.is_cancelled', '=', false)
      .where('r.message', '~', PERIOD_LIKE.source)
      .execute();
    const unmatched = new Map<number, Status['rc_unmatched'][number] & { date_start: Date }>();
    for (const { date_start, message, flag, ...session } of period) {
      if (!isUnmatched({ message, flag })) continue;
      const found = unmatched.get(session.session_key);
      if (found) found.rows++;
      else unmatched.set(session.session_key, { ...session, rows: 1, date_start });
    }
    const rc_unmatched = [...unmatched.values()]
      .sort((a, b) => b.date_start.getTime() - a.date_start.getTime() || a.session_key - b.session_key)
      .map(({ date_start, ...item }) => item);
    // Computed on read like rc_unmatched (A§10): every season from 2023 on, one query per table, grouped by year here,
    // only the columns standingsMismatches reads (drivers only: no team rows).
    const seasonKeys = (raceOnly: boolean) => {
      const q = db
        .selectFrom('session as s')
        .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
        .where('m.year', '>=', 2023)
        .select('s.session_key');
      return raceOnly ? q.where('s.type', '=', 'Race') : q;
    };
    const seasons = await db
      .selectFrom('session as s')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        's.session_key',
        's.source',
        's.type',
        's.name',
        's.date_start',
        's.is_cancelled',
        'm.name as meeting_name',
        'm.year',
      ])
      .where('m.year', '>=', 2023)
      .execute();
    const drivers = await db
      .selectFrom('driver')
      .select(['session_key', 'driver_number', 'full_name', 'team_name']) // what standingsMismatches reads
      .where('session_key', 'in', seasonKeys(false))
      .execute();
    const results = await db
      .selectFrom('result')
      .select(['session_key', 'driver_number', 'position', 'points'])
      .where('session_key', 'in', seasonKeys(true))
      .execute();
    const championshipDrivers = await db
      .selectFrom('championship_driver')
      .select(['session_key', 'driver_number', 'points_start'])
      .where('session_key', 'in', seasonKeys(true))
      .execute();
    const yearOf = new Map(seasons.map((s) => [s.session_key, s.year]));
    const standings_mismatch = [...new Set(yearOf.values())]
      .sort((a, b) => b - a)
      .flatMap((year) => {
        const of = <R extends { session_key: number }>(rows: R[]) =>
          rows.filter((r) => yearOf.get(r.session_key) === year);
        return standingsMismatches({
          year,
          sessions: seasons.filter((s) => s.year === year),
          drivers: of(drivers),
          results: of(results),
          championship_drivers: of(championshipDrivers),
        });
      });
    const body = {
      revision,
      states,
      cancelled,
      failed,
      recorder: recorder ?? null,
      ingest: ingest ?? null,
      rain: { states: rainStates, failed: rainFailed },
      rc_unmatched,
      standings_mismatch,
    };
    return c.json(body, 200, NO_STORE);
  });

  // The open recording and its session; else the next session (the recorder's notion) with its latest recording.
  api.get('/live', async (c) => {
    const columns = ['id', 'session_key', 'started_at', 'ended_at', 'complete'] as const;
    const latest = () => db.selectFrom('recording').select(columns).orderBy('started_at', 'desc').orderBy('id', 'desc');
    let recording = await latest().where('ended_at', 'is', null).limit(1).executeTakeFirst();
    const key =
      recording?.session_key ??
      (
        await db
          .selectFrom('session')
          .select('session_key')
          .where('is_cancelled', '=', false)
          .where('date_end', '>', new Date(Date.now() - AFTER_MS))
          .orderBy('date_start')
          .orderBy('session_key')
          .limit(1)
          .executeTakeFirst()
      )?.session_key;
    const session =
      key === undefined
        ? undefined
        : await db
            .selectFrom('session as s')
            .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
            .select(['s.session_key', 'm.name as meeting_name', 's.name as session_name', 's.date_start', 's.date_end'])
            .where('s.session_key', '=', key)
            .executeTakeFirst();
    if (session)
      recording ??= await latest().where('session_key', '=', session.session_key).limit(1).executeTakeFirst();
    const body = {
      session: session ?? null,
      recording: recording
        ? {
            id: Number(recording.id), // bigint comes back as a string
            started_at: recording.started_at,
            ended_at: recording.ended_at,
            complete: recording.complete,
          }
        : null,
    };
    return c.json(body, 200, NO_STORE);
  });

  // Every recording, newest first: the replay list.
  api.get('/recordings', async (c) => {
    const rows = await db
      .selectFrom('recording as r')
      .innerJoin('session as s', 's.session_key', 'r.session_key')
      .innerJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select([
        'r.id',
        'r.session_key',
        'm.year',
        'm.name as meeting_name',
        's.name as session_name',
        's.type as session_type',
        's.date_start',
        'r.started_at',
        'r.ended_at',
        'r.complete',
      ])
      .orderBy('r.started_at', 'desc')
      .orderBy('r.id', 'desc')
      .execute();
    const body = rows.map((r) => ({ ...r, id: Number(r.id) })); // bigint comes back as a string
    return c.json(body, 200, NO_STORE);
  });

  // State at T over SSE (A§10, A§11.3). Parameters are checked before any lookup, and nothing from the URL reaches a path.
  api.get('/playback/:recording/stream', async (c) => {
    const id = c.req.param('recording');
    const param = (name: string) => {
      const all = c.req.queries(name);
      return all && all.length > 1 ? null : all?.[0]; // a repeated parameter is ambiguous
    };
    const [at, delay, speed, still, pos] = [param('at'), param('delay'), param('speed'), param('still'), param('pos')];
    const live = at === 'live';
    const num = (v: string | null | undefined, re: RegExp, dflt: number) =>
      v === undefined ? dflt : v !== null && re.test(v) ? Number(v) : Number.NaN;
    const delayS = num(delay, /^\d{1,3}$/, 0);
    const speedX = num(speed, /^\d{1,2}$/, 1);
    if (
      !/^\d{1,9}$/.test(id) ||
      !(live || /^\d{1,15}$/.test(at ?? '')) ||
      (delay !== undefined && !live) ||
      !(delayS <= 120) ||
      !SPEEDS.includes(speedX) ||
      (live && speedX !== 1) ||
      // A paused seek's still frame (A§13): for the open log only, so a replay at T, never live.
      (still !== undefined && (still !== '1' || live)) ||
      // The car positions (P7a, A§11.3): `pos` events and the snapshot's `pos`.
      (pos !== undefined && pos !== '1')
    )
      return badRequest(c);
    const mode = live ? 'live' : still ? 'still' : 'replay'; // `still` is '1' or absent by now
    const row = await db
      .selectFrom('recording as r')
      .leftJoin('session as s', 's.session_key', 'r.session_key')
      .leftJoin('meeting as m', 'm.meeting_key', 's.meeting_key')
      .select(['r.path', 'r.session_key', 'r.started_at', 'r.ended_at', 'm.circuit_short_name'])
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) return notFound(c);
    const from = live ? 'live' : Number(at);
    if (from !== 'live' && (from < row.started_at.getTime() || from > (row.ended_at?.getTime() ?? Date.now())))
      return badRequest(c);
    if (!/^\d+-\d+$/.test(row.path)) return notFound(c); // the column's CHECK says so; this path is not built from less
    const dir = join(liveDir, row.path);
    const found = await stat(dir).catch((err: unknown) => {
      if (codeOf(err) !== 'ENOENT') throw err;
      log.error({ cause: 'ENOENT' }, 'playback');
    });
    if (!found?.isDirectory()) return notFound(c);
    // hono runs this handler for HEAD and drops the body without cancelling it: a generator would stay open for good.
    if (c.req.method === 'HEAD')
      return new Response(null, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store, no-transform',
          'F1-Revision': revision,
        },
      });
    if (streams >= MAX_STREAMS) return c.json({ error: 'unavailable' }, 503, NO_STORE);

    streams++; // no await since the check above
    const res = streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // A transient database error is not the end of the recording.
      const ended = () =>
        db
          .selectFrom('recording')
          .select('ended_at')
          .where('id', '=', id)
          .executeTakeFirst()
          .then((r) => r?.ended_at != null)
          .catch((err: unknown) => {
            log.error({ cause: codeOf(err) }, 'playback');
            return false;
          });
      // A write that does not complete (a client that stopped reading) ends the stream and frees the slot.
      const within = async (write: Promise<unknown>) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            write,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Object.assign(new Error('write timeout'), { code: 'write_timeout' })),
                writeTimeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      let seek: { ms: number; lines: number } | undefined; // set by the seek, logged with the first snapshot
      // pos=1: the session's P5c outline by its meeting's circuit (own keys only: the name is database text), and what
      // the `pos` events cost (P7a, A§11.3).
      const name = row.circuit_short_name;
      const circuit = name !== null && Object.hasOwn(CIRCUITS, name) ? CIRCUITS[name] : undefined;
      const outline = circuit && OUTLINES[circuit.id];
      const counts = zCounts();
      const sent = { events: 0, bytes: 0, first: 0, last: 0 };
      try {
        const events = playback({
          dir,
          sessionKey: row.session_key,
          at: from,
          delay: delayS,
          speed: speedX,
          now: Date.now,
          sleep: (ms, signal) => sleep(ms, undefined, { signal }),
          ended,
          signal: abort.signal,
          onOpen: (s) => {
            seek = s;
          },
          ...(pos === '1' && {
            pos: {
              frame: () =>
                outline
                  ? frames.get({
                      id: String(Number(id)), // one cache key per recording, leading zeros or not
                      dir,
                      sessionKey: row.session_key,
                      outline,
                      ended: row.ended_at !== null,
                    })
                  : Promise.resolve(undefined),
              counts,
            },
          }),
        });
        for await (const ev of events) {
          // The snapshot's state is the stream's own: serialized before the generator moves on.
          const data = JSON.stringify(ev.data);
          if (seek) {
            // What an open costs (#101, A§11.3): fixed fields only, never the URL, an id, a time or feed text.
            const { ms, lines } = seek;
            seek = undefined;
            log.info({ mode, scan_ms: ms, lines, snapshot_bytes: Buffer.byteLength(data) }, 'playback open');
          }
          await within(stream.writeSSE({ event: ev.event, data }));
          if (ev.event === 'pos') {
            if (sent.events++ === 0) sent.first = ev.data.t;
            [sent.bytes, sent.last] = [sent.bytes + Buffer.byteLength(data), ev.data.t];
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) log.error({ cause: codeOf(err) }, 'playback'); // never the message to the client
        if (codeOf(err) === 'write_timeout') {
          stream.abort();
          // abort() alone leaves the socket and its buffer open under @hono/node-server (#109); `close` cancels its reader.
          (c.env as HttpBindings | undefined)?.outgoing?.destroy(); // undefined under app.request()
        }
      } finally {
        abort.abort();
        streams--;
        // What the positions cost (P7a, A§11.3): counts and ms only, as the open line.
        if (pos === '1') {
          log.info(
            { events: sent.events, bytes: sent.bytes, span_ms: sent.last - sent.first, ...counts },
            'playback pos',
          );
        }
      }
    });
    res.headers.set('Cache-Control', 'no-store, no-transform'); // streamSSE says no-cache
    return res;
  });

  app.route('/api/v1', api);

  app.notFound(notFound);
  app.onError((err, c) => {
    log.error({ cause: codeOf(err) }, 'api'); // the code only: a message could quote a value
    return c.json({ error: 'internal' }, 500, NO_STORE);
  });
  return app;
}
