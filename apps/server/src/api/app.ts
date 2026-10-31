import type { Seasons, Status, Stints } from '@f1/contracts';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import { colours } from '../timing/colours.ts';

// The api role's routes (A§10). JSON uses the A§7 column names; answers match the zod contracts in
// packages/contracts. No body or log echoes input, a header, the token or a database message.

const NO_STORE = { 'Cache-Control': 'no-store' };
const FINAL = { 'Cache-Control': 'private, max-age=86400' };
const STALE_MS = 5 * 60_000; // the recorder reports every few seconds
const STATES = ['scheduled', 'due', 'fetched', 'final', 'failed'] as const;

const badRequest = (c: Context) => c.json({ error: 'bad request' }, 400, NO_STORE);
const notFound = (c: Context) => c.json({ error: 'not found' }, 404, NO_STORE);

/** A§10: a final session's data no longer changes. */
const cache = (state: string) => (state === 'final' ? FINAL : NO_STORE);
const sessionKey = (c: Context) => {
  const key = c.req.param('key') ?? '';
  return /^\d{1,9}$/.test(key) ? Number(key) : undefined;
};

export function createApp({
  db,
  access,
  log,
}: {
  db: Kysely<DB>;
  access: MiddlewareHandler;
  log: Pick<Logger, 'error'>;
}) {
  /** The session of a per-session route: its key and state, or the 400/404 answer. */
  const lookup = async (c: Context): Promise<{ key: number; state: string } | Response> => {
    const key = sessionKey(c);
    if (key === undefined) return badRequest(c);
    const row = await db.selectFrom('session').select('ingest_state').where('session_key', '=', key).executeTakeFirst();
    return row ? { key, state: row.ingest_state } : notFound(c);
  };
  const app = new Hono();

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
      .select(['driver_number', 'position', 'laps', 'dnf', 'dns', 'dsq', 'durations_ms', 'gaps_ms'])
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
    return c.json(body, 200, cache(row.ingest_state));
  });

  api.get('/sessions/:key/laps', async (c) => {
    const session = await lookup(c);
    if (session instanceof Response) return session;
    const laps = await db
      .selectFrom('lap as l')
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
    return c.json(body, 200, cache(session.state));
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
    return c.json(body, 200, cache(session.state));
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
    return c.json(body, 200, cache(session.state));
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
    return c.json(body, 200, cache(session.state));
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
    const body = { states, cancelled, failed, recorder: recorder ?? null };
    return c.json(body, 200, NO_STORE);
  });

  app.route('/api/v1', api);

  app.notFound(notFound);
  app.onError((err, c) => {
    log.error({ cause: codeOf(err) }, 'api'); // the code only: a message could quote a value
    return c.json({ error: 'internal' }, 500, NO_STORE);
  });
  return app;
}
