import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Kysely, sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { pingHealthchecks } from '../src/healthchecks.ts';
import {
  BACKLOG_MS,
  backfill,
  type Deps,
  daemon,
  INGEST_LOCK,
  ingestHealth,
  ingestLock,
  processSession,
  SYNC_RETRY_MS,
  scheduleSync,
  syncSchedule,
  tick,
} from '../src/ingest/ingest.ts';
import { acceptEmpty, rederive, refetch } from '../src/ingest/recovery.ts';
import { ERROR_CODES } from '../src/ingest/state.ts';
import { run } from '../src/main.ts';
import { type Clock, createClient, OPENF1 } from '../src/openf1/client.ts';
import type { Lap, Session } from '../src/openf1/schemas.ts';
import { createTestDb, type TestDb } from './db.ts';

// The ingest pipeline against a real PostgreSQL 18, logged in as f1_ingest (the grants),
// with OpenF1 replaced by the P1a fixtures (msw). Expected counts are literals read off
// the fixture files, not computed by the code under test.

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const CASES: Record<number, string> = { 11388: 'normal', 11392: 'quali', 11383: 'sprint' };
// #115: the grid is served by the qualifying's key (race 11388 → 11384, sprint 11383 → 11379); every other key is empty.
const GRID: Record<number, string> = { 11384: 'normal', 11379: 'sprint' };
const EMPTY = 11465; // 2026 testing, day 1: served the *-empty fixtures (OpenF1's 404 "No results found.")
// The 10 sessions sessions-year marks is_cancelled (Bahrain and Saudi Arabia, April 2026).
const CANCELLED = [11254, 11255, 11256, 11257, 11261, 11262, 11263, 11264, 11265, 11269];
const TABLES = [
  'driver',
  'lap',
  'lap_source',
  'stint',
  'pit',
  'race_control',
  'result',
  'weather',
  'raw_response',
] as const;

const raw = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.raw`), 'utf8'));
function fixture(name: string): Response {
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), 'utf8')) as { status: number };
  if (meta.status === 404) return HttpResponse.json({ detail: 'No results found.' }, { status: 404 });
  return new HttpResponse(readFileSync(join(FIXTURES, `${name}.raw`), 'utf8'), {
    headers: { 'content-type': 'application/json' },
  });
}

/** Every request, as `endpoint?query`. */
const requests: string[] = [];
const requested = (key: number) => requests.filter((r) => r.includes(`session_key=${key}`)).length;

/** Serves every endpoint from the fixtures; `override` may answer a request first (key is NaN for a year). */
const openf1 = (override: (endpoint: string, key: number) => Response | undefined = () => undefined) =>
  server.use(
    http.get(`${OPENF1}/:endpoint`, ({ params, request }) => {
      const query = new URL(request.url).searchParams;
      const endpoint = String(params.endpoint);
      requests.push(`${endpoint}?${query}`);
      const key = Number(query.get('session_key') ?? Number.NaN);
      const answer = override(endpoint, key);
      if (answer) return answer;
      if (query.has('year')) return fixture(`${endpoint}-${query.get('year') === '2026' ? 'year' : 'empty'}`);
      if (endpoint === 'starting_grid') return fixture(`starting_grid-${GRID[key] ?? 'empty'}`);
      return fixture(`${endpoint}-${CASES[key] ?? 'empty'}`);
    }),
  );
const status500 = (endpoint: string, key: number) =>
  endpoint === 'laps' && key === 11388 ? new HttpResponse(null, { status: 500 }) : undefined;

// The client's limiter and retries sleep on this clock: virtual, so the test runs in seconds.
let virtual = 0;
const clock: Clock = {
  now: () => virtual,
  sleep: async (ms) => {
    virtual += ms;
  },
};
let at = new Date(0);
let beats = 0;
const lines: string[] = [];
const logged = (msg: string) => lines.filter((l) => l.includes(`"msg":"${msg}"`)).length;

let testDb: TestDb;
let db: Kysely<DB>;
let deps: Deps;

// The real healthchecks.io ping: `secrets` holds a valid key, `nokey` none. msw records each ping as
// `<method> <path after the key> <body>`.
let secrets: string;
let nokey: string;
const pinging = (dir = secrets): Deps => ({
  ...deps,
  ping: (slug, body) => pingHealthchecks(slug, deps.log, { secretsDir: dir, body }),
});
const hc = () => {
  const pings: string[] = [];
  server.use(
    http.all('https://hc-ping.com/*', async ({ request }) => {
      const path = new URL(request.url).pathname.split('/').slice(2).join('/');
      pings.push(`${request.method} ${path} ${await request.text()}`.trim());
      return new HttpResponse('OK');
    }),
  );
  return pings;
};

const session = (key: number) =>
  db.selectFrom('session').selectAll().where('session_key', '=', key).executeTakeFirstOrThrow();
const states = async () => {
  const rows = await db
    .selectFrom('session')
    .select(['ingest_state', (eb) => eb.fn.countAll<string>().as('n')])
    .groupBy('ingest_state')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.ingest_state, Number(r.n)]));
};
const count = async (table: string, where: string) => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(db);
  return Number(rows[0]?.n);
};
const countWhere = (table: string, key: number, where = 'true') => count(table, `session_key = ${key} AND ${where}`);
const rowCounts = async (key: number) =>
  Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await countWhere(table, key)])));
/** Per table: md5 over every row, minus what a re-run legitimately changes (identity, fetch time, counter). */
const hashes = async () => {
  const out: Record<string, string> = {};
  for (const table of ['meeting', 'session', ...TABLES]) {
    const { rows } = await sql<{ h: string }>`
      SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) AS h
      FROM (SELECT to_jsonb(t) - 'id' - 'fetched_at' - 'fetch_count' AS x FROM ${sql.table(table)} t) s`.execute(db);
    out[table] = rows[0]?.h ?? '';
  }
  return out;
};

describe('ingest (fixtures through msw, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    db = createDb(testDb.urls.f1_ingest);
    const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });
    deps = { db, client: createClient({ clock }), now: () => at, log, beat: () => void beats++ };
    secrets = mkdtempSync(join(tmpdir(), 'f1-hc-'));
    nokey = mkdtempSync(join(tmpdir(), 'f1-hc-'));
    writeFileSync(join(secrets, 'hc_ping_key'), 'AbCdEfGhIjKlMnOpQrStUv\n');
  });
  afterAll(async () => {
    for (const dir of [secrets, nokey]) if (dir) rmSync(dir, { recursive: true, force: true });
    await db?.destroy();
    await testDb?.drop();
  });

  it('syncs 2026: 27 meetings and 131 sessions, scheduled at date_end + 35 min; cancelled ones never', async () => {
    openf1();
    expect(await syncSchedule(deps, [2026])).toBe(true);
    expect(await count('meeting', 'true')).toBe(27);
    expect(await count('meeting', 'is_cancelled')).toBe(2);
    expect(await states()).toEqual({ scheduled: 131 });
    expect(await count('session', 'is_cancelled AND next_fetch_at IS NULL')).toBe(CANCELLED.length);
    expect(await count('session', `is_cancelled AND session_key IN (${CANCELLED})`)).toBe(10);
    expect(await session(11388)).toMatchObject({
      meeting_key: 1296,
      type: 'Race',
      name: 'Race',
      date_end: new Date('2026-10-11T14:00:00Z'),
      next_fetch_at: new Date('2026-10-11T14:35:00Z'),
      is_cancelled: false,
      source: 'openf1',
    });
  });

  it('a session is due at date_end + 35 min, not at + 34:59', async () => {
    openf1();
    at = new Date('2026-02-11T16:34:59Z'); // 11465 ends 16:00
    expect(await tick(deps)).toBe(0);
    at = new Date('2026-02-11T16:35:00Z');
    expect(await tick(deps)).toBe(1);
    expect(await session(EMPTY)).toMatchObject({
      ingest_state: 'fetched',
      next_fetch_at: new Date('2026-02-11T19:00:00Z'),
      fetch_count: 1,
    });
  });

  it('a tick and a refetch wait while any session is live (start − 30 min … end + 30 min, A§6.1)', async () => {
    openf1();
    const before = { beats, requests: requests.length };
    at = new Date('2026-10-24T21:30:00Z'); // 11392 qualifying, 21:00–22:00
    expect(await tick(deps)).toBe(0);
    at = new Date('2026-10-24T21:31:00Z');
    expect(await tick(deps)).toBe(0);
    expect(await states()).toEqual({ due: 94, scheduled: 37 });
    expect(beats - before.beats).toBe(2); // a waiting tick still proves the daemon alive
    expect(logged('live session: waiting')).toBe(1); // on the transition only
    const row = await session(11392);
    expect(await processSession(deps, 11392, true)).toEqual({ ok: false, error: 'live_session' });
    expect(await session(11392)).toEqual(row);
    expect(requests.length).toBe(before.requests);
  });

  it('a tick processes every due session; a 500 on laps leaves the session due with no rows', async () => {
    openf1(status500);
    const before = beats;
    at = new Date('2026-10-25T12:00:00Z');
    expect(await tick(deps)).toBe(95);
    // After each OpenF1 call (11388 fails at its 2nd; the 22 other past races and sprints add their grid), each session, the tick.
    expect(beats - before).toBe(94 * 7 + 22 + 2 + 95 + 1);
    expect(logged('live session: over')).toBe(1);
    expect(await states()).toEqual({ final: 92, fetched: 2, due: 1, scheduled: 36 });
    expect(await session(11388)).toMatchObject({
      ingest_state: 'due',
      next_fetch_at: new Date('2026-10-25T12:05:00Z'),
      fetch_count: 0,
      fail_count: 1,
      last_error: 'http_500',
    });
    expect(await rowCounts(11388)).toEqual({
      driver: 0,
      lap: 0,
      lap_source: 0,
      stint: 0,
      pit: 0,
      race_control: 0,
      result: 0,
      weather: 0,
      raw_response: 0,
    });
    expect(await session(11392)).toMatchObject({
      ingest_state: 'fetched',
      next_fetch_at: new Date('2026-10-25T22:00:00Z'),
    });
    // The cancelled sessions (April) were past: never due, never fetched, no rows.
    expect(CANCELLED.map(requested)).toEqual(CANCELLED.map(() => 0));
    expect(await count('session', "is_cancelled AND ingest_state = 'scheduled' AND fetch_count = 0")).toBe(10);
  });

  it('an empty laps reply where rows were stored fails with `empty` and keeps the rows', async () => {
    openf1((endpoint, key) => (endpoint === 'laps' && key === 11392 ? fixture('laps-empty') : undefined));
    at = new Date('2026-10-25T22:30:00Z'); // the Austin race's live window (20:00–22:00) has just ended
    expect(await tick(deps)).toBe(3); // 11388 (retry), 11392, 11391
    expect(await session(11388)).toMatchObject({
      ingest_state: 'final',
      fetch_count: 1,
      fail_count: 0,
      last_error: null,
    });
    expect(await session(11392)).toMatchObject({
      ingest_state: 'due',
      next_fetch_at: new Date('2026-10-25T22:35:00Z'),
      fetch_count: 1,
      fail_count: 1,
      last_error: 'empty',
    });
    expect((await rowCounts(11392)).lap).toBe(50);

    openf1();
    at = new Date('2026-10-25T22:35:00Z');
    expect(await tick(deps)).toBe(2); // 11392 and the Austin race 11396 (end + 35 min)
    expect(await session(11392)).toMatchObject({
      ingest_state: 'final',
      fetch_count: 2,
      fail_count: 0,
      last_error: null,
    });
    expect(await session(11396)).toMatchObject({
      ingest_state: 'fetched',
      next_fetch_at: new Date('2026-10-26T01:00:00Z'),
    });
    expect(await states()).toEqual({ final: 95, fetched: 1, scheduled: 35 });
  });

  it('fixtures → rows per table and session; nulls stay null', async () => {
    expect(await rowCounts(11388)).toEqual({
      driver: 4,
      lap: 62,
      lap_source: 62,
      stint: 9,
      pit: 5,
      race_control: 155,
      result: 22,
      weather: 160,
      raw_response: 8,
    });
    expect(await rowCounts(11392)).toEqual({
      driver: 4,
      lap: 50,
      lap_source: 50,
      stint: 16,
      pit: 16,
      race_control: 39,
      result: 22,
      weather: 77,
      raw_response: 7,
    });
    expect(await rowCounts(11383)).toEqual({
      driver: 4,
      lap: 57,
      lap_source: 57,
      stint: 14,
      pit: 10,
      race_control: 159,
      result: 22,
      weather: 127,
      raw_response: 8,
    });
    expect(await rowCounts(EMPTY)).toEqual({
      driver: 0,
      lap: 0,
      lap_source: 0,
      stint: 0,
      pit: 0,
      race_control: 0,
      result: 0,
      weather: 0,
      raw_response: 7,
    });
    expect(await session(EMPTY)).toMatchObject({ ingest_state: 'final', fetch_count: 2 });
    expect(await countWhere('raw_response', EMPTY, "http_status = 404 AND body = '[]'")).toBe(7);

    // [11388 race, 11392 quali, 11383 sprint]: the fixtures' own null counts.
    const per = async (table: string, where: string) =>
      Promise.all([11388, 11392, 11383].map((key) => countWhere(table, key, where)));
    expect(await per('lap', 's1_ms IS NULL')).toEqual([2, 16, 4]);
    expect(await per('lap', 'lap_ms IS NULL')).toEqual([2, 5, 4]);
    expect(await per('lap', 'i1_kph IS NULL')).toEqual([17, 0, 9]);
    expect(await per('lap', 'st_kph IS NULL')).toEqual([11, 0, 18]);
    expect(await per('lap', 'date_start IS NULL')).toEqual([0, 1, 0]);
    expect(await per('lap', 'seg1 IS NULL')).toEqual([0, 0, 2]);
    expect(await per('pit', 'stop_ms IS NULL')).toEqual([5, 16, 10]);
    expect(await per('pit', 'pit_ms IS NULL')).toEqual([0, 4, 0]);
    expect(await per('result', 'position IS NULL')).toEqual([3, 0, 8]);
    expect(await per('race_control', 'driver_number IS NULL')).toEqual([82, 36, 159]);
    // A§9 in/out laps: in = the same driver's next lap is an out-lap (quali: 4 out-laps are lap 1).
    expect(await per('lap', 'is_pit_out')).toEqual([5, 16, 10]);
    expect(await per('lap', 'is_pit_in')).toEqual([5, 12, 10]);
    // gap_to_leader: 8 strings ("+1 LAP" …) → {NULL}, 4 nulls stay null; qualifying → Q1–Q3.
    expect(await per('result', "gaps_ms = '{NULL}'")).toEqual([8, 0, 0]);
    expect(await per('result', 'gaps_ms IS NULL')).toEqual([4, 0, 9]);
    expect(await per('result', 'cardinality(durations_ms) = 3')).toEqual([0, 22, 0]);
    // #115: the race and the sprint take their qualifying's grid (22 cars each); the qualifying itself has none.
    expect(await per('result', 'grid IS NOT NULL')).toEqual([22, 0, 22]);
    expect(await per('raw_response', "endpoint = 'starting_grid' AND http_status = 200")).toEqual([1, 0, 1]);
    const grid = (key: number) =>
      db
        .selectFrom('result')
        .select(['driver_number', 'grid'])
        .where('session_key', '=', key)
        .where('grid', '<=', 3)
        .orderBy('grid')
        .execute();
    expect(await grid(11388)).toEqual([
      { driver_number: 3, grid: 1 },
      { driver_number: 16, grid: 2 },
      { driver_number: 44, grid: 3 },
    ]);
    expect(await grid(11383)).toEqual([
      { driver_number: 3, grid: 1 },
      { driver_number: 63, grid: 2 },
      { driver_number: 16, grid: 3 },
    ]);
    // P5a weather: the sprint was wet for 20 samples; the race and the qualifying were dry.
    expect(await per('weather', 'rainfall = 1')).toEqual([0, 0, 20]);
    expect(await per('weather', 'rainfall = 0')).toEqual([160, 77, 107]);
    expect(
      await db
        .selectFrom('weather')
        .selectAll()
        .where('session_key', '=', 11388)
        .orderBy('date')
        .limit(1)
        .executeTakeFirst(),
    ).toEqual({
      session_key: 11388,
      source: 'openf1',
      date: new Date('2026-10-11T11:07:56.727Z'),
      air_temperature: 30,
      track_temperature: 44,
      humidity: 69.6,
      pressure: 1008.9,
      rainfall: 0,
      wind_direction: 147,
      wind_speed: 1.5,
    });
    // The per-session log line counts the weather rows, never a value.
    const line = lines.map((l) => JSON.parse(l)).findLast((l) => l.session_key === 11388 && l.msg === 'session');
    expect(line?.rows).toMatchObject({ weather: 160 });
    expect(line?.grid).toEqual({ rows: 22, skipped: 0 });
    const quali = lines.map((l) => JSON.parse(l)).findLast((l) => l.session_key === 11392 && l.msg === 'session');
    expect(quali).not.toHaveProperty('grid'); // not a race

    expect(
      await db
        .selectFrom('lap')
        .selectAll()
        .where('session_key', '=', 11388)
        .where('driver_number', '=', 16)
        .where('lap_number', '=', 1)
        .executeTakeFirst(),
    ).toMatchObject({
      date_start: new Date('2026-10-11T12:03:39.077Z'),
      lap_ms: 103269,
      s1_ms: 33098,
      s2_ms: 42141,
      s3_ms: 28030,
      i1_kph: 294,
      i2_kph: 270,
      st_kph: 196,
      seg1: [null, 2049, 2049, 2049, 2049, 2051, 2051, 2049],
      is_pit_out: false,
      deleted: false,
      quali_phase: null,
    });
    const result = (key: number, driver: number) =>
      db
        .selectFrom('result')
        .select(['durations_ms', 'gaps_ms'])
        .where('session_key', '=', key)
        .where('driver_number', '=', driver)
        .executeTakeFirst();
    expect(await result(11388, 16)).toEqual({ durations_ms: [6128120], gaps_ms: [7335] });
    expect(await result(11392, 12)).toEqual({ durations_ms: [95390, 94278, 94035], gaps_ms: [361, 80, 0] });
  });

  it('processing the same sessions again gives identical rows (idempotent)', async () => {
    const before = await hashes();
    openf1();
    at = new Date('2026-10-26T00:00:00Z');
    expect(await syncSchedule(deps, [2026])).toBe(true);
    for (const key of [11388, 11392, 11383, EMPTY])
      expect(await processSession(deps, key, true)).toEqual({ ok: true, value: 'final' });
    expect(await hashes()).toEqual(before);
    expect(await states()).toEqual({ final: 95, fetched: 1, scheduled: 35 });
  });

  it('a re-ingest with changed data replaces the rows: fewer laps, a changed lap time', async () => {
    const laps = raw('laps-normal') as Lap[];
    const changed = [{ ...laps[0], lap_duration: 99.999 }, ...laps.slice(1, -2)];
    openf1((endpoint, key) => (endpoint === 'laps' && key === 11388 ? HttpResponse.json(changed) : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect(await rowCounts(11388)).toMatchObject({ lap: 60, raw_response: 8 });
    const lap = (driver: number, n: number) =>
      db
        .selectFrom('lap')
        .select('lap_ms')
        .where('session_key', '=', 11388)
        .where('driver_number', '=', driver)
        .where('lap_number', '=', n)
        .executeTakeFirst();
    const [first, gone] = [laps[0], laps.at(-1)];
    expect(await lap(first?.driver_number ?? 0, first?.lap_number ?? 0)).toEqual({ lap_ms: 99_999 });
    expect(await lap(gone?.driver_number ?? 0, gone?.lap_number ?? 0)).toBeUndefined();

    openf1();
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect((await rowCounts(11388)).lap).toBe(62);
  });

  it('weather: a duplicate date keeps the last row (skipped), an empty reply after rows is `empty` and keeps them', async () => {
    const weather = raw('weather-normal') as Record<string, unknown>[];
    const first = weather[0] as Record<string, unknown>;
    const FIRST = new Date('2026-10-11T11:07:56.727Z');
    const firstRow = () =>
      db
        .selectFrom('weather')
        .select(['air_temperature', 'rainfall'])
        .where('session_key', '=', 11388)
        .where('date', '=', FIRST)
        .execute();
    // The same instant again, spelt without the trailing zeros and with other values: the last row wins.
    const twice = [...weather, { ...first, date: '2026-10-11T11:07:56.727+00:00', air_temperature: 99.5, rainfall: 1 }];
    openf1((endpoint, key) => (endpoint === 'weather' && key === 11388 ? HttpResponse.json(twice) : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect(await rowCounts(11388)).toMatchObject({ weather: 160, raw_response: 8 });
    expect(await firstRow()).toEqual([{ air_temperature: 99.5, rainfall: 1 }]);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ session_key: 11388, rows: { weather: 160 }, skipped: 1 });

    // An empty weather reply where the stored raw had rows: a refetch changes nothing, the daemon records `empty`.
    const empty = (endpoint: string, key: number) =>
      endpoint === 'weather' && key === 11388 ? fixture('weather-empty') : undefined;
    openf1(empty);
    expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'empty' });
    expect(await rowCounts(11388)).toMatchObject({ weather: 160, raw_response: 8 });
    expect(await processSession(deps, 11388)).toEqual({ ok: false, error: 'empty' });
    expect(await session(11388)).toMatchObject({ ingest_state: 'due', fail_count: 1, last_error: 'empty' });
    expect(await rowCounts(11388)).toMatchObject({ weather: 160, raw_response: 8 });
    expect(await firstRow()).toEqual([{ air_temperature: 99.5, rainfall: 1 }]);

    // A weather schema failure fails the session's fetch like any endpoint: the path and code, never the value.
    const bad = [{ ...first, rainfall: 0.5 }, ...weather.slice(1)];
    openf1((endpoint, key) => (endpoint === 'weather' && key === 11388 ? HttpResponse.json(bad) : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'schema' });
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      state: 'unchanged',
      last_error: 'schema',
      endpoint: 'weather',
      issues: [{ path: '[0].rainfall', code: 'invalid_type' }],
    });

    openf1();
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect(await firstRow()).toEqual([{ air_temperature: 30, rainfall: 0 }]);
    expect(await session(11388)).toMatchObject({ ingest_state: 'final', fail_count: 0, last_error: null });
  });

  // #115, O1 (owner, 2026-11-13): the grid fails on its own. The session still succeeds and its other tables are
  // replaced; the stored grid raw row stays untouched and the stored grids carry over by driver; the log line says
  // why, as a fixed code (and zod's paths and codes for a schema failure).
  describe('the starting grid (O1)', () => {
    const gridRaw = () =>
      db
        .selectFrom('raw_response')
        .selectAll()
        .where('session_key', '=', 11388)
        .where('endpoint', '=', 'starting_grid')
        .executeTakeFirst();
    const grids = () =>
      db
        .selectFrom('result')
        .select(['driver_number', 'grid'])
        .where('session_key', '=', 11388)
        .orderBy('driver_number')
        .execute();
    const lastLine = () => JSON.parse(lines.at(-1) ?? '{}');
    const gridRequests = () => requests.filter((r) => r.startsWith('starting_grid?')).length;
    const laps = raw('laps-normal') as Lap[];
    const fewer = () => HttpResponse.json(laps.slice(0, -2));
    const grid = raw('starting_grid-normal') as Record<string, unknown>[];
    const down500 = () => new HttpResponse(null, { status: 500 });
    const gridAnswer = (answer: () => Response) => (endpoint: string) =>
      endpoint === 'starting_grid' ? answer() : undefined;
    const rename = (key: number, name: string, is_cancelled = false) =>
      db.updateTable('session').set({ name, is_cancelled }).where('session_key', '=', key).execute();
    const restore = async () => {
      openf1();
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect(lastLine().grid).toEqual({ rows: 22, skipped: 0 });
    };

    it.each([
      ['http_500', down500, { error: 'http_500', kept: 22 }],
      [
        'schema',
        () => HttpResponse.json([{ ...grid[0], position: 'P1' }, ...grid.slice(1)]),
        { error: 'schema', kept: 22, issues: [{ path: '[0].position', code: 'invalid_type' }] },
      ],
      [
        'schema (101 rows)',
        () => HttpResponse.json(Array.from({ length: 101 }, (_, i) => grid[i % grid.length])),
        { error: 'schema', kept: 22, issues: [{ path: '', code: 'too_big' }] },
      ],
      // A NUL in a field the schema strips passes parse, but jsonb refuses it: the savepoint keeps the session.
      [
        'schema (a NUL jsonb refuses)',
        () => HttpResponse.json([{ ...grid[0], note: '\u0000' }, ...grid.slice(1)]),
        { error: 'schema', kept: 22 },
      ],
      ['empty', () => fixture('starting_grid-empty'), { error: 'empty', kept: 22 }],
      [
        'empty (rows of another session)',
        () => HttpResponse.json(grid.map((r) => ({ ...r, session_key: 11379 }))),
        { error: 'empty', kept: 22 },
      ],
      [
        'empty (no positions)',
        () => HttpResponse.json(grid.map((r) => ({ ...r, position: null }))),
        { error: 'empty', kept: 22 },
      ],
    ])('a grid %s keeps the stored raw row untouched and the grids; the session succeeds', async (_, answer, log) => {
      const before = { raw: await gridRaw(), grids: await grids() };
      expect(before.raw).toMatchObject({ http_status: 200 });
      expect(before.grids.filter((r) => r.grid !== null)).toHaveLength(22);
      // A later clock: a keep that rewrote the raw row would change its fetched_at.
      at = new Date(at.getTime() + 3_600_000);
      expect(before.raw?.fetched_at.getTime()).toBeLessThan(at.getTime());
      await db
        .updateTable('session')
        .set({ ingest_state: 'due', fail_count: 1, last_error: 'timeout' })
        .where('session_key', '=', 11388)
        .execute();
      openf1((endpoint, key) =>
        endpoint === 'starting_grid' ? answer() : endpoint === 'laps' && key === 11388 ? fewer() : undefined,
      );
      expect(await processSession(deps, 11388)).toEqual({ ok: true, value: 'final' });
      expect(await session(11388)).toMatchObject({ ingest_state: 'final', fail_count: 0, last_error: null });
      expect(await rowCounts(11388)).toMatchObject({ lap: 60, result: 22, raw_response: 8 }); // the laps replaced
      const after = await gridRaw();
      expect(after).toEqual(before.raw);
      expect(after?.fetched_at).toEqual(before.raw?.fetched_at);
      expect(after?.http_status).toBe(before.raw?.http_status);
      expect(after?.body).toEqual(before.raw?.body);
      expect(await grids()).toEqual(before.grids);
      expect(lastLine()).toMatchObject({ session_key: 11388, state: 'final' });
      expect(lastLine().grid).toEqual(log); // a code, a count and paths, never a value
    });

    it('a keep carries the grids by driver: a driver new to the results gets none', async () => {
      await db.deleteFrom('result').where('session_key', '=', 11388).where('driver_number', '=', 3).execute();
      openf1(gridAnswer(down500));
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect((await grids()).find((r) => r.driver_number === 3)).toEqual({ driver_number: 3, grid: null });
      expect((await grids()).filter((r) => r.grid !== null)).toHaveLength(21);
      expect(lastLine().grid).toEqual({ error: 'http_500', kept: 21 });
      await restore();
    });

    it('a stored body that no longer parses, or a changed qualifying key, still keeps the grids', async () => {
      const before = await grids();
      const bad = [{ position: 'P1' }];
      await db
        .updateTable('raw_response')
        .set({ body: JSON.stringify(bad) })
        .where('session_key', '=', 11388)
        .where('endpoint', '=', 'starting_grid')
        .execute();
      openf1(gridAnswer(down500));
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect((await gridRaw())?.body).toEqual(bad);
      expect(await grids()).toEqual(before);
      expect(lastLine().grid).toEqual({ error: 'http_500', kept: 22 });
      await restore();

      // Practice 1 becomes the qualifying: its key has no grid (OpenF1's 404), and the stored grids stay.
      await rename(11384, 'Practice 1');
      await rename(11378, 'Qualifying');
      openf1();
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect(requests.at(-1)).toBe('starting_grid?session_key=11378');
      expect(await grids()).toEqual(before);
      expect(lastLine().grid).toEqual({ error: 'empty', kept: 22 });
      await rename(11378, 'Practice 1');
      await rename(11384, 'Qualifying');
      await restore();
    });

    it('without a stored grid, a failed grid fetch keeps none', async () => {
      await db
        .deleteFrom('raw_response')
        .where('session_key', '=', 11388)
        .where('endpoint', '=', 'starting_grid')
        .execute();
      await db.updateTable('result').set({ grid: null }).where('session_key', '=', 11388).execute();
      openf1(gridAnswer(down500));
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect(await rowCounts(11388)).toMatchObject({ lap: 62, raw_response: 7 });
      expect((await grids()).filter((r) => r.grid !== null)).toEqual([]);
      expect(lastLine().grid).toEqual({ error: 'http_500', kept: 0 });
    });

    it('a refetch replaces the grid and its raw row', async () => {
      const swapped = [{ ...grid[0], position: 2 }, { ...grid[1], position: 1 }, ...grid.slice(2)];
      openf1(gridAnswer(() => HttpResponse.json(swapped)));
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect((await grids()).filter((r) => r.grid !== null && r.grid <= 2)).toEqual([
        { driver_number: 3, grid: 2 },
        { driver_number: 16, grid: 1 },
      ]);
      expect((await gridRaw())?.body).toEqual(swapped);
      await restore();
      expect((await gridRaw())?.body).toEqual(grid);
      expect((await grids()).find((r) => r.driver_number === 3)).toEqual({ driver_number: 3, grid: 1 });
    });

    // Exactly one non-cancelled qualifying of the right name, else no request; a stored grid stays (no_quali).
    it('no_quali: a race whose qualifying is missing, doubled or cancelled', async () => {
      const expectNoQuali = async (key: number, stored: boolean) => {
        const sent = gridRequests();
        const storedRaw = () =>
          db
            .selectFrom('raw_response')
            .selectAll()
            .where('session_key', '=', key)
            .where('endpoint', '=', 'starting_grid')
            .executeTakeFirst();
        const before = await storedRaw();
        openf1();
        expect(await processSession(deps, key, true)).toEqual({ ok: true, value: 'final' });
        expect(gridRequests()).toBe(sent);
        expect(await countWhere('raw_response', key)).toBe(stored ? 8 : 7);
        expect(await countWhere('raw_response', key, "endpoint = 'starting_grid'")).toBe(stored ? 1 : 0);
        expect(await storedRaw()).toEqual(before); // untouched, or still none
        expect(await countWhere('result', key, 'grid IS NOT NULL')).toBe(stored ? 22 : 0);
        expect(lastLine()).toMatchObject({ session_key: key });
        expect(lastLine().grid).toEqual(stored ? { error: 'no_quali', kept: 22 } : 'no_quali');
      };
      // 11384 renamed: the race has no Qualifying, and the sprint has two (Sprint Qualifying and Sprint Shootout).
      await rename(11384, 'Sprint Shootout');
      await expectNoQuali(11388, true);
      await expectNoQuali(11383, true);
      await rename(11384, 'Qualifying', true); // cancelled
      await expectNoQuali(11388, true);
      // Nothing stored: no grid and no grid raw row.
      await db
        .deleteFrom('raw_response')
        .where('session_key', '=', 11388)
        .where('endpoint', '=', 'starting_grid')
        .execute();
      await db.updateTable('result').set({ grid: null }).where('session_key', '=', 11388).execute();
      await expectNoQuali(11388, false);
      await rename(11384, 'Qualifying');
      for (const key of [11388, 11383]) {
        expect(await processSession(deps, key, true)).toEqual({ ok: true, value: 'final' });
        expect(await countWhere('result', key, 'grid IS NOT NULL')).toBe(22);
        expect(await countWhere('raw_response', key)).toBe(8);
      }
    });
  });

  it('a sync moves next_fetch_at only while scheduled, and a cancelled session never gets one', async () => {
    const shift = (s: Session, hours: number) =>
      ({ ...s, date_end: new Date(Date.parse(s.date_end) + hours * 3_600_000).toISOString() }) as Session;
    const sessions = (raw('sessions-year') as Session[]).map((s) =>
      [11397, 11396, 11388].includes(s.session_key)
        ? shift(s, 1)
        : s.session_key === 11405
          ? { ...s, is_cancelled: true }
          : s,
    );
    const before = await session(11396);
    openf1((endpoint, key) => (endpoint === 'sessions' && Number.isNaN(key) ? HttpResponse.json(sessions) : undefined));
    expect(await syncSchedule(deps, [2026])).toBe(true);
    expect(await session(11397)).toMatchObject({
      ingest_state: 'scheduled',
      date_end: new Date('2026-10-30T20:30:00Z'),
      next_fetch_at: new Date('2026-10-30T21:05:00Z'),
    });
    expect(await session(11396)).toMatchObject({
      ingest_state: 'fetched',
      date_end: new Date('2026-10-25T23:00:00Z'),
      next_fetch_at: before.next_fetch_at,
    });
    expect(await session(11388)).toMatchObject({ ingest_state: 'final', next_fetch_at: null });
    expect(await session(11405)).toMatchObject({ ingest_state: 'scheduled', is_cancelled: true, next_fetch_at: null });

    openf1();
    expect(await syncSchedule(deps, [2026])).toBe(true);
    expect(await session(11397)).toMatchObject({ next_fetch_at: new Date('2026-10-30T20:05:00Z') });
    expect(await session(11405)).toMatchObject({
      is_cancelled: false,
      next_fetch_at: new Date('2026-11-06T17:05:00Z'),
    });
    expect(await session(11396)).toMatchObject({ date_end: new Date('2026-10-25T22:00:00Z') });
  });

  it('a sync skips and counts the sessions of a meeting OpenF1 left out', async () => {
    const meetings = (raw('meetings-year') as { meeting_key: number }[]).filter((m) => m.meeting_key !== 1296);
    const sessions = (raw('sessions-year') as Session[]).map((s) =>
      s.session_key === 11384 ? { ...s, date_end: '2026-10-11T00:00:00+00:00' } : s,
    );
    openf1((endpoint, key) =>
      Number.isNaN(key) ? HttpResponse.json(endpoint === 'meetings' ? meetings : sessions) : undefined,
    );
    const before = await session(11384);
    expect(await syncSchedule(deps, [2026])).toBe(true);
    // Marina Bay (1296): 11378, 11379, 11383, 11384 and 11388.
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      year: 2026,
      meetings: 26,
      sessions: 126,
      skipped: 5,
      msg: 'sync',
    });
    expect(await session(11384)).toEqual(before);
  });

  it('a sync never takes over an f1-archive meeting or session with the same key', async () => {
    const meeting = () =>
      db.selectFrom('meeting').selectAll().where('meeting_key', '=', 1296).executeTakeFirstOrThrow();
    const original = { meeting: await meeting(), session: await session(11388) };
    const archived = {
      source: 'f1-archive',
      name: 'Archive',
      date_start: new Date('2019-03-17T05:00:00Z'),
      date_end: new Date('2019-03-17T07:00:00Z'),
    } as const;
    await db.updateTable('meeting').set(archived).where('meeting_key', '=', 1296).execute();
    await db.updateTable('session').set(archived).where('session_key', '=', 11388).execute();
    const before = { meeting: await meeting(), session: await session(11388) };
    openf1();
    expect(await syncSchedule(deps, [2026])).toBe(true);
    expect({ meeting: await meeting(), session: await session(11388) }).toEqual(before);
    const { source, name, date_start, date_end } = original.meeting;
    await db
      .updateTable('meeting')
      .set({ source, name, date_start, date_end })
      .where('meeting_key', '=', 1296)
      .execute();
    const s = original.session;
    await db
      .updateTable('session')
      .set({ source: s.source, name: s.name, date_start: s.date_start, date_end: s.date_end })
      .where('session_key', '=', 11388)
      .execute();
    expect(await session(11388)).toEqual(original.session);
  });

  it('a failed refetch leaves a final session, its counters and its rows as they were', async () => {
    const before = await session(11388);
    openf1(status500);
    expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'http_500' });
    openf1((endpoint, key) => (endpoint === 'laps' && key === 11388 ? fixture('laps-empty') : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'empty' });
    // A schema failure names the endpoint and zod's paths and codes, never the value.
    const stints = raw('stints-normal') as Record<string, unknown>[];
    const bad = [{ ...stints[0], compound: 'SECRET-VALUE'.length }, ...stints.slice(1)];
    openf1((endpoint, key) => (endpoint === 'stints' && key === 11388 ? HttpResponse.json(bad) : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'schema' });
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      session_key: 11388,
      state: 'unchanged',
      last_error: 'schema',
      endpoint: 'stints',
      issues: [{ path: '[0].compound', code: 'invalid_type' }],
    });
    expect(await session(11388)).toEqual(before);
    expect((await rowCounts(11388)).lap).toBe(62);
    expect(await processSession(deps, 999_999, true)).toEqual({ ok: false, error: 'unknown_session' });
  });

  it('a Race logs rc_unmatched: the period-like rows that match no form (a 2027 wording); another type logs none', async () => {
    const drift = [
      ...(raw('race_control-normal') as Record<string, unknown>[]),
      // 2027-style: no form matches. A stewards' note and a known form are not counted.
      ...['SAFETY CAR IN', 'INCIDENT INVOLVING CAR 4 NOTED - UNDER SAFETY CAR', 'SAFETY CAR DEPLOYED'].map(
        (message) => ({
          ...(raw('race_control-normal') as Record<string, unknown>[])[0],
          flag: null,
          message,
        }),
      ),
    ];
    const lastLine = () => JSON.parse(lines.at(-1) ?? '{}');
    openf1((endpoint, key) => (endpoint === 'race_control' && key === 11388 ? HttpResponse.json(drift) : undefined));
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect(lastLine()).toMatchObject({ session_key: 11388, rc_unmatched: 1 });
    openf1((endpoint, key) => (endpoint === 'race_control' && key === 11392 ? HttpResponse.json(drift) : undefined));
    expect(await processSession(deps, 11392, true)).toEqual({ ok: true, value: 'final' });
    expect(lastLine()).toMatchObject({ session_key: 11392 });
    expect(lastLine()).not.toHaveProperty('rc_unmatched');
    openf1();
    expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
    expect(lastLine().rc_unmatched).toBe(0); // the fixture's own rows all match a form or a note
  });

  it('last_error takes every D5 code through the CHECK; the 9th failure in a row marks the session failed and pings /fail once', async () => {
    const set = (code: string) =>
      sql`UPDATE session SET last_error = ${code} WHERE session_key = ${EMPTY}`.execute(db).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    for (const code of ['http_401', 'http_500', ...ERROR_CODES]) expect(await set(code)).toBe('ok');
    for (const code of ['http_5000', 'boom', 'live_session']) expect(await set(code)).toBe('23514');

    await db.updateTable('session').set({ fail_count: 7, last_error: null }).where('session_key', '=', EMPTY).execute();
    openf1((endpoint, key) =>
      endpoint === 'laps' && key === EMPTY ? new HttpResponse(null, { status: 500 }) : undefined,
    );
    const pings = hc();
    expect(await processSession(pinging(), EMPTY)).toEqual({ ok: false, error: 'http_500' }); // the 8th
    expect(pings).toEqual([]);
    expect(await processSession(pinging(), EMPTY)).toEqual({ ok: false, error: 'http_500' });
    expect(pings).toEqual(['POST f1-ingest/fail session_failed http_500']);
    expect(await session(EMPTY)).toMatchObject({
      ingest_state: 'failed',
      next_fetch_at: null,
      fail_count: 9,
      last_error: 'http_500',
    });
    openf1();
    expect(await processSession(deps, EMPTY, true)).toEqual({ ok: true, value: 'final' }); // a refetch recovers it
    expect(await session(EMPTY)).toMatchObject({ ingest_state: 'final', fail_count: 0, last_error: null });

    // No key file: the same 9th failure sends no request at all.
    await db.updateTable('session').set({ fail_count: 8 }).where('session_key', '=', EMPTY).execute();
    openf1((endpoint, key) =>
      endpoint === 'laps' && key === EMPTY ? new HttpResponse(null, { status: 500 }) : undefined,
    );
    expect(await processSession(pinging(nokey), EMPTY)).toEqual({ ok: false, error: 'http_500' });
    expect(await session(EMPTY)).toMatchObject({ ingest_state: 'failed', fail_count: 9 });
    expect(pings).toHaveLength(1);
    openf1();
    expect(await processSession(deps, EMPTY, true)).toEqual({ ok: true, value: 'final' });
  });

  it('the 9th failure in a row on the empty guard pings /fail once with `session_failed empty`', async () => {
    const before = await session(11388);
    await db
      .updateTable('session')
      .set({ ingest_state: 'due', fail_count: 8 })
      .where('session_key', '=', 11388)
      .execute();
    openf1((endpoint, key) => (endpoint === 'laps' && key === 11388 ? fixture('laps-empty') : undefined));
    const pings = hc();
    expect(await processSession(pinging(), 11388)).toEqual({ ok: false, error: 'empty' });
    expect(await session(11388)).toMatchObject({ ingest_state: 'failed', fail_count: 9, last_error: 'empty' });
    expect(pings).toEqual(['POST f1-ingest/fail session_failed empty']);
    await db.updateTable('session').set(before).where('session_key', '=', 11388).execute(); // the rows were kept
  });

  it('the daemon sync skips a live window and retries every 15 min until it succeeds', async () => {
    openf1();
    const sync = scheduleSync(deps);
    const syncs = () => requests.filter((r) => r.includes('year=')).length;
    const before = syncs();
    at = new Date('2026-10-30T23:20:00Z'); // Mexico practice 2 (22:00–23:00) is live until 23:30
    await sync.run();
    expect(syncs()).toBe(before);
    expect(logged('sync: live session, retry in 15 min')).toBe(1);
    at = new Date(at.getTime() + SYNC_RETRY_MS - 1000);
    await sync.run();
    expect(syncs()).toBe(before);
    at = new Date('2026-10-30T23:35:00Z');
    await sync.run();
    expect(syncs()).toBe(before + 8); // 2023–2025 still have no meeting row: 4 years × 2 requests
    at = new Date('2026-10-31T00:00:00Z');
    await sync.run();
    expect(syncs()).toBe(before + 8); // synced: nothing until requested again (00:30 UTC)
    sync.request();
    await sync.run();
    expect(syncs()).toBe(before + 16);
  });

  it('backfill syncs 2023 onwards and processes each past session that is not final; a live window stops it', async () => {
    openf1();
    at = new Date('2026-10-26T12:00:00Z');
    expect(await backfill(deps)).toBe(true); // 2023–2025 answer 404 "No results found." here
    // The Austin race (ended 22:00) was due at 01:00; at end + 14 h it is next due at end + 24 h.
    expect(await session(11396)).toMatchObject({
      ingest_state: 'fetched',
      next_fetch_at: new Date('2026-10-26T22:00:00Z'),
      fetch_count: 2,
    });
    expect(await states()).toEqual({ final: 95, fetched: 1, scheduled: 35 });

    at = new Date('2026-10-30T22:30:00Z'); // Mexico practice 2 is live; practice 1 (11397) is past
    const sent = requests.length;
    expect(await backfill(deps)).toBe(false);
    expect(requests.length).toBe(sent);
    expect(await session(11397)).toMatchObject({ ingest_state: 'scheduled', fetch_count: 0 });
    expect(await session(11396)).toMatchObject({ ingest_state: 'fetched', fetch_count: 2 });
  });

  it('an f1-archive session is never fetched, written or marked due: processSession, refetch, tick, backfill', async () => {
    const KEY = 5001;
    await db
      .insertInto('meeting')
      .values({ meeting_key: KEY, source: 'f1-archive', year: 2019, name: 'Archive GP' })
      .execute();
    await db
      .insertInto('session')
      .values({
        session_key: KEY,
        source: 'f1-archive',
        meeting_key: KEY,
        type: 'Race',
        name: 'Race',
        date_start: new Date('2019-05-01T13:00:00Z'),
        date_end: new Date('2019-05-01T15:00:00Z'),
        ingest_state: 'fetched',
        next_fetch_at: new Date('2019-05-01T15:35:00Z'),
        fetch_count: 1,
      })
      .execute();
    await db
      .insertInto('lap')
      .values({ session_key: KEY, source: 'f1-archive', driver_number: 1, lap_number: 1, lap_ms: 90_000 })
      .execute();
    const before = { session: await session(KEY), rows: await rowCounts(KEY) };
    expect(before.rows.lap).toBe(1);
    const sent = requests.length;
    openf1(); // any OpenF1 request would be answered (and counted) here

    expect(await processSession(deps, KEY)).toEqual({ ok: false, error: 'not_openf1' });
    expect(await processSession(deps, KEY, true)).toEqual({ ok: false, error: 'not_openf1' });
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      session_key: KEY,
      state: 'unchanged',
      error: 'not_openf1',
    });
    expect(
      await run(['refetch', String(KEY)], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_ingest }, () => {}),
    ).toBe(1);

    at = new Date('2026-11-02T12:00:00Z'); // long after next_fetch_at, outside every live window
    await tick(deps);
    expect(await backfill(deps)).toBe(true); // a session the backfill took up would fail with not_openf1
    expect(requests.slice(sent).filter((r) => r.includes(`session_key=${KEY}`))).toEqual([]);
    expect({ session: await session(KEY), rows: await rowCounts(KEY) }).toEqual(before);
  });

  it('a good sync calls onSynced; only a requested (daily) one pings f1-ingest', async () => {
    openf1();
    const pings = hc();
    const synced: Date[] = [];
    const sync = scheduleSync(pinging(), (t) => void synced.push(t));
    at = new Date('2026-11-02T12:00:00Z'); // outside every live window
    await sync.run(); // the startup sync
    expect(synced).toEqual([at]);
    expect(pings).toEqual([]);
    sync.request();
    await sync.run();
    expect(synced).toEqual([at, at]);
    expect(pings).toEqual(['GET f1-ingest']);
  });

  it('a due backlog over 6 h pings /fail once, again after a good sync; never inside a live window', async () => {
    const pings = hc();
    const health = ingestHealth(pinging());
    const backlog = (t: Date, ms: number) =>
      db
        .updateTable('session')
        .set({ ingest_state: 'due', next_fetch_at: new Date(t.getTime() - ms) })
        .where('session_key', '=', EMPTY)
        .execute();

    at = new Date('2026-10-30T22:30:00Z'); // Mexico practice 2 is live
    await backlog(at, BACKLOG_MS + 60_000);
    await health.report();
    expect(pings).toEqual([]);

    at = new Date('2026-11-02T12:00:00Z');
    await backlog(at, BACKLOG_MS - 60_000); // not yet 6 h
    await health.report();
    expect(pings).toEqual([]);
    await backlog(at, BACKLOG_MS);
    await health.report();
    expect(pings).toEqual(['POST f1-ingest/fail due_backlog']);
    await health.report(); // the backlog stands: quiet
    expect(pings).toHaveLength(1);
    health.synced(at); // D3: re-armed
    await health.report();
    expect(pings).toEqual(['POST f1-ingest/fail due_backlog', 'POST f1-ingest/fail due_backlog']);
    await db
      .updateTable('session')
      .set({ ingest_state: 'final', next_fetch_at: null })
      .where('session_key', '=', EMPTY)
      .execute();
  });

  it('a backlog ping that failed is retried by the next report, and the latch is set once one got through', async () => {
    let status = 500;
    const posts: string[] = [];
    server.use(
      http.all('https://hc-ping.com/*', async ({ request }) => {
        posts.push(await request.text());
        return new HttpResponse(null, { status });
      }),
    );
    const health = ingestHealth(pinging());
    at = new Date('2026-11-02T12:00:00Z');
    await db
      .updateTable('session')
      .set({ ingest_state: 'due', next_fetch_at: new Date(at.getTime() - BACKLOG_MS) })
      .where('session_key', '=', EMPTY)
      .execute();
    await health.report();
    expect(posts).toEqual(['due_backlog']); // answered 500
    status = 200;
    await health.report(); // retried
    expect(posts).toEqual(['due_backlog', 'due_backlog']);
    await health.report(); // got through: quiet
    expect(posts).toHaveLength(2);
    await db
      .updateTable('session')
      .set({ ingest_state: 'final', next_fetch_at: null })
      .where('session_key', '=', EMPTY)
      .execute();
  });

  it('daemon(): the minute job wires a good sync to last_sync_at and the tick to the ingest_status row', async () => {
    openf1();
    at = new Date('2026-11-02T12:00:00Z');
    const job = daemon(deps, () => false);
    await job.sync();
    await job.tick();
    const row = await db.selectFrom('ingest_status').selectAll().executeTakeFirstOrThrow();
    expect(row).toEqual({ id: true, last_sync_at: at, live_wait: false, last_tick_at: at });
    expect(typeof job.request).toBe('function');
  });

  it('report() upserts the one ingest_status row as f1_ingest; a restart keeps last_sync_at; tick reports', async () => {
    const row = () => db.selectFrom('ingest_status').selectAll().executeTakeFirstOrThrow();
    const synced = new Date('2026-11-02T00:30:00Z');
    at = new Date('2026-11-02T12:00:00Z');
    const first = ingestHealth(deps);
    first.synced(synced);
    await first.report();
    expect(await row()).toEqual({ id: true, last_sync_at: synced, live_wait: false, last_tick_at: at });

    at = new Date('2026-10-30T22:30:00Z'); // a restart (no sync in memory), inside a live window
    await ingestHealth(deps).report();
    expect(await row()).toEqual({ id: true, last_sync_at: synced, live_wait: true, last_tick_at: at });
    expect(await count('ingest_status', 'true')).toBe(1);

    let reports = 0;
    at = new Date('2026-11-02T12:00:00Z');
    expect(await tick({ ...deps, report: async () => void reports++ })).toBe(0);
    expect(reports).toBe(1); // once at the end; once more after each processed session
    expect(logged('report failed')).toBe(0);
  });

  // #103: the recovery tools and the ingest lock, on the sessions above. Each test restores what it changes.
  describe('recovery (#103)', () => {
    const KEYS = [11388, 11392, 11383];
    const parsed = () => lines.map((l) => JSON.parse(l));
    const lastLine = () => JSON.parse(lines.at(-1) ?? '{}');
    const lastOf = (msg: string, key?: number) =>
      parsed().findLast((l) => l.msg === msg && (key === undefined || l.session_key === key));
    const keyOf = (r: string) => Number(new URLSearchParams(r.split('?')[1]).get('session_key'));
    const keysOf = (asked: string[]) => [...new Set(asked.map(keyOf))];
    const isGrid = (r: string) => r.startsWith('starting_grid?');
    const rawHashes = (key: number) =>
      db
        .selectFrom('raw_response')
        .select(['endpoint', sql<string>`md5(body::text)`.as('h')])
        .where('session_key', '=', key)
        .orderBy('endpoint')
        .execute();
    const setBody = (key: number, endpoint: string, body: unknown) =>
      db
        .updateTable('raw_response')
        .set({ body: JSON.stringify(body) })
        .where('session_key', '=', key)
        .where('endpoint', '=', endpoint)
        .execute();
    /** Per key: [deleted laps, laps with a qualifying phase], the rules' marks. */
    const marks = () =>
      Promise.all(
        KEYS.map(async (key) => [
          await countWhere('lap', key, 'deleted'),
          await countWhere('lap', key, 'quali_phase IS NOT NULL'),
        ]),
      );
    /** As an older rule or normaliser would have left the rows (the pre-P1c lap defaults). */
    const stale = async () => {
      await db
        .updateTable('lap')
        .set({ deleted: false, deleted_reason: null, quali_phase: null })
        .where('session_key', 'in', KEYS)
        .execute();
      await db.deleteFrom('pit').where('session_key', '=', 11388).execute();
      await db.updateTable('driver').set({ acronym: 'OLD' }).where('session_key', 'in', KEYS).execute();
    };
    // No client: rederive cannot reach OpenF1.
    const rederiving = () => ({ db, log: deps.log, beat: deps.beat });

    it('rederive derives the stored rows again from raw_response, with no OpenF1 request (A§2)', async () => {
      at = new Date('2026-11-02T12:00:00Z');
      openf1();
      for (const key of KEYS) expect(await processSession(deps, key, true)).toEqual({ ok: true, value: 'final' });
      const ingested = KEYS.map((key) => lastOf('session', key));
      const before = await hashes();
      const marked = await marks();
      // The race has one deleted lap, the qualifying 49 laps with a phase (the fixtures; the sprint has neither).
      expect(marked).toEqual([
        [1, 0],
        [0, 49],
        [0, 0],
      ]);
      await stale();
      expect(await marks()).toEqual(KEYS.map(() => [0, 0]));
      expect(await hashes()).not.toEqual(before);

      server.resetHandlers(); // any request would fail from here on
      const sent = { requests: requests.length, beats };
      expect(await rederive(rederiving(), KEYS)).toBe(true);
      expect(await hashes()).toEqual(before); // race_control.id aside (the helper drops every id)
      expect(await marks()).toEqual(marked);
      expect(requests.length).toBe(sent.requests);
      expect(beats - sent.beats).toBe(3); // after each session
      // D2: the race's grid comes over by driver from the stored results.
      expect(
        await db
          .selectFrom('result')
          .select(['driver_number', 'grid'])
          .where('session_key', '=', 11388)
          .where('grid', '<=', 2)
          .orderBy('grid')
          .execute(),
      ).toEqual([
        { driver_number: 3, grid: 1 },
        { driver_number: 16, grid: 2 },
      ]);
      // Each line counts what a fresh ingest counted.
      KEYS.forEach((key, i) => {
        const { rows, skipped, rules, merge } = ingested[i] ?? {};
        expect(lastOf('rederive', key)).toMatchObject({ level: 30, rows, skipped, rules, merge });
      });
      expect(lastLine()).toMatchObject({ msg: 'rederive_done', sessions: 3, rederived: 3, skipped: 0, failed: 0 });

      // --all: every OpenF1 session, newest first; those without raw rows (future, cancelled) are skipped.
      await stale();
      const { rows } = await sql<{ n: string; raw: string }>`
        SELECT count(*) AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM raw_response r WHERE r.session_key = s.session_key)) AS raw
        FROM session s WHERE source = 'openf1'`.execute(db);
      const [n, raw] = [Number(rows[0]?.n), Number(rows[0]?.raw)];
      expect(await rederive(rederiving(), 'all')).toBe(true);
      expect(await hashes()).toEqual(before);
      expect(requests.length).toBe(sent.requests);
      expect(lastLine()).toMatchObject({
        msg: 'rederive_done',
        sessions: n,
        rederived: raw,
        skipped: n - raw,
        failed: 0,
      });
      const all = parsed().slice(-n - 1, -1);
      expect(all.filter((l) => l.skipped === 'no_raw')).toHaveLength(n - raw);
      expect(all.find((l) => l.session_key === 5001)).toBeUndefined(); // the archive session is not OpenF1's
    });

    it('rederive skips a session without raw rows; a body that no longer parses, an archive or unknown key fails', async () => {
      server.resetHandlers();
      expect(await rederive(rederiving(), [11405])).toBe(true); // a future session: nothing fetched yet
      expect(lastOf('rederive')).toMatchObject({ level: 30, session_key: 11405, skipped: 'no_raw' });

      const pit = await db
        .selectFrom('raw_response')
        .selectAll()
        .where('session_key', '=', EMPTY)
        .where('endpoint', '=', 'pit')
        .executeTakeFirstOrThrow();
      await db.deleteFrom('raw_response').where('session_key', '=', EMPTY).where('endpoint', '=', 'pit').execute();
      expect(await rederive(rederiving(), [EMPTY])).toBe(true);
      expect(lastOf('rederive')).toMatchObject({ session_key: EMPTY, skipped: 'incomplete' });
      expect(lastLine()).toMatchObject({ msg: 'rederive_done', sessions: 1, rederived: 0, skipped: 1, failed: 0 });
      await db
        .insertInto('raw_response')
        .values({ ...pit, body: JSON.stringify(pit.body) })
        .execute();

      // A schema failure names the endpoint and zod's paths and codes, never the value, and writes nothing.
      const { body } = await db
        .selectFrom('raw_response')
        .select('body')
        .where('session_key', '=', 11392)
        .where('endpoint', '=', 'stints')
        .executeTakeFirstOrThrow();
      const stints = body as Record<string, unknown>[];
      await setBody(11392, 'stints', [{ ...stints[0], compound: 'SECRET-VALUE'.length }, ...stints.slice(1)]);
      const before = await hashes();
      expect(await rederive(rederiving(), [11392])).toBe(false);
      expect(await hashes()).toEqual(before);
      expect(lastOf('rederive')).toMatchObject({
        level: 50,
        session_key: 11392,
        error: 'schema',
        endpoint: 'stints',
        issues: [{ path: '[0].compound', code: 'invalid_type' }],
      });
      await setBody(11392, 'stints', stints);

      expect(await rederive(rederiving(), [5001, 999_999, 11405])).toBe(false);
      expect(parsed().slice(-4)).toMatchObject([
        { msg: 'rederive', session_key: 5001, error: 'not_openf1' },
        { msg: 'rederive', session_key: 999_999, error: 'unknown_session' },
        { msg: 'rederive', session_key: 11405, skipped: 'no_raw' },
        { msg: 'rederive_done', level: 50, sessions: 3, rederived: 0, skipped: 1, failed: 2 },
      ]);
    });

    it('refetch --failed takes the failed sessions, newest first, on one limiter: at most 25 requests in any 60 s', async () => {
      const failed = [11388, 11392, 11383, EMPTY];
      await db
        .updateTable('session')
        .set({ ingest_state: 'failed', next_fetch_at: null, fail_count: 9, last_error: 'http_500' })
        .where('session_key', 'in', failed)
        .execute();
      expect(await count('session', "ingest_state = 'failed'")).toBe(4);
      const starts: number[] = []; // the virtual clock at each request
      openf1(() => void starts.push(virtual));
      const sent = requests.length;
      expect(await refetch(deps, 'failed')).toBe(true);
      const asked = requests.slice(sent);
      expect(asked).toHaveLength(30); // 4 × 7, and the race's and the sprint's grid: above 25 a minute
      expect(keysOf(asked.filter((r) => !isGrid(r)))).toEqual([11392, 11388, 11383, EMPTY]);
      expect(keysOf(asked.filter(isGrid))).toEqual([11384, 11379]);
      for (const key of failed)
        expect(await session(key)).toMatchObject({ ingest_state: 'final', fail_count: 0, last_error: null });
      const inWindow = (t: number) => starts.filter((u) => u >= t && u < t + 60_000).length;
      expect(Math.max(...starts.map(inWindow))).toBeLessThanOrEqual(25);
      expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(60_000);
      expect(lastLine()).toMatchObject({ level: 30, msg: 'refetch_done', sessions: 4, done: 4, failed: 0 });

      expect(await refetch(deps, 'failed')).toBe(true); // none left
      expect(lastLine()).toMatchObject({ msg: 'refetch_done', sessions: 0, done: 0, failed: 0 });
      expect(requests.length).toBe(sent + 30);
    });

    it('refetch --meeting takes its ended, not cancelled sessions, and the race and sprint grids', async () => {
      // Marina Bay (1296): 11378 cancelled, 11379 ended 10 min ago (the backfill waits 35 min).
      const sprintQuali = await session(11379);
      await db.updateTable('session').set({ is_cancelled: true }).where('session_key', '=', 11378).execute();
      await db
        .updateTable('session')
        .set({ date_end: new Date(at.getTime() - 10 * 60_000) })
        .where('session_key', '=', 11379)
        .execute();
      openf1();
      const sent = requests.length;
      expect(await refetch(deps, { meeting: 1296 })).toBe(true);
      const asked = requests.slice(sent);
      expect(keysOf(asked.filter((r) => !isGrid(r)))).toEqual([11388, 11384, 11383]);
      expect(asked.filter(isGrid)).toEqual(['starting_grid?session_key=11384', 'starting_grid?session_key=11379']);
      expect(lastLine()).toMatchObject({ msg: 'refetch_done', sessions: 3, done: 3, failed: 0 });
      await db.updateTable('session').set({ is_cancelled: false }).where('session_key', '=', 11378).execute();
      await db
        .updateTable('session')
        .set({ date_end: sprintQuali.date_end })
        .where('session_key', '=', 11379)
        .execute();
      expect(await session(11379)).toEqual(sprintQuali);

      expect(await refetch(deps, { meeting: 999 })).toBe(false);
      expect(lastLine()).toMatchObject({ level: 50, msg: 'refetch_done', sessions: 0, error: 'no_sessions' });
      expect(requests.length).toBe(sent + asked.length);
    });

    it('accept-empty deletes only the emptied raw row, once OpenF1 answers [] now; the next fetch takes the []', async () => {
      const emptyPit = (endpoint: string, key: number) =>
        endpoint === 'pit' && key === 11388 ? fixture('pit-empty') : undefined;
      openf1(emptyPit);
      expect(await processSession(deps, 11388, true)).toEqual({ ok: false, error: 'empty' });
      expect(lastLine()).toMatchObject({
        msg: 'session',
        session_key: 11388,
        state: 'unchanged',
        last_error: 'empty',
        endpoints: ['pit'],
      });
      const before = await rawHashes(11388);
      const sent = requests.length;
      expect(await acceptEmpty(deps, 11388, 'pit')).toBe(true);
      expect(requests.slice(sent)).toEqual(['pit?session_key=11388']); // D4: one request
      expect(lastLine()).toMatchObject({
        level: 30,
        msg: 'accept_empty',
        session_key: 11388,
        endpoint: 'pit',
        rows: 5,
      });
      expect(await rawHashes(11388)).toEqual(before.filter((r) => r.endpoint !== 'pit'));
      expect((await rowCounts(11388)).pit).toBe(5); // the data rows stay until the next fetch
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect(await rowCounts(11388)).toMatchObject({ pit: 0, raw_response: 8 });

      openf1();
      expect(await processSession(deps, 11388, true)).toEqual({ ok: true, value: 'final' });
      expect(await rowCounts(11388)).toMatchObject({ pit: 5, raw_response: 8 });
    });

    it('accept-empty refuses while OpenF1 has rows, for a stored [] (no request), in a live window, off OpenF1', async () => {
      const before = { race: await rawHashes(11388), empty: await rawHashes(EMPTY) };
      openf1();
      let sent = requests.length;
      expect(await acceptEmpty(deps, 11388, 'pit')).toBe(false);
      expect(requests.length - sent).toBe(1);
      expect(lastLine()).toMatchObject({
        level: 50,
        msg: 'accept_empty',
        session_key: 11388,
        endpoint: 'pit',
        error: 'not_empty',
      });
      sent = requests.length;
      expect(await acceptEmpty(deps, EMPTY, 'pit')).toBe(false);
      expect(lastLine()).toMatchObject({ session_key: EMPTY, error: 'no_rows' });
      const saved = at;
      at = new Date('2026-10-30T22:30:00Z'); // Mexico practice 2 is live
      expect(await acceptEmpty(deps, 11388, 'pit')).toBe(false);
      expect(lastLine()).toMatchObject({ session_key: 11388, error: 'live_session' });
      at = saved;
      expect(await acceptEmpty(deps, 5001, 'pit')).toBe(false);
      expect(lastLine()).toMatchObject({ session_key: 5001, error: 'not_openf1' });
      expect(await acceptEmpty(deps, 999_999, 'pit')).toBe(false);
      expect(lastLine()).toMatchObject({ session_key: 999_999, error: 'unknown_session' });
      expect(requests.length).toBe(sent);
      expect({ race: await rawHashes(11388), empty: await rawHashes(EMPTY) }).toEqual(before);
    });

    it('the ingest lock: one holder; backfill refuses with daemon_running while it is held, refetch runs', async () => {
      const a = ingestLock(testDb.urls.f1_ingest, deps.log);
      const b = ingestLock(testDb.urls.f1_ingest, deps.log);
      const admin = createDb(testDb.urls.admin);
      const holder = async () =>
        (
          await sql<{ pid: number }>`
            SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${INGEST_LOCK}
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(admin)
        ).rows.map((r) => r.pid);
      try {
        expect(await a.held()).toBe(true);
        expect(await b.held()).toBe(false);
        expect(await a.held()).toBe(true);
        expect(await b.held()).toBe(false);
        // On transitions only: the error level when not held.
        expect(parsed().filter((l) => l.msg === 'ingest lock')).toMatchObject([
          { level: 30, held: true },
          { level: 50, held: false },
        ]);
        expect(await holder()).toHaveLength(1);

        openf1();
        const sent = requests.length;
        expect(await backfill(deps)).toBe(false);
        expect(requests.length).toBe(sent);
        expect(lastLine()).toMatchObject({ level: 50, msg: 'backfill', error: 'daemon_running' });
        expect(await refetch(deps, [11388])).toBe(true); // no lock: the row lock serialises it
        await a.release();
        expect(await holder()).toEqual([]);
        expect(await backfill(deps)).toBe(true);
        expect(lastLine()).toMatchObject({ level: 30, msg: 'backfill', failed: 0 });
        expect(await holder()).toEqual([]); // the backfill unlocked

        // A lost connection (a database restart) loses the lock; the next call takes it again.
        expect(await a.held()).toBe(true);
        const [pid] = await holder();
        await sql`SELECT pg_terminate_backend(${pid}, 5000)`.execute(admin);
        const lost = () => parsed().filter((l) => l.msg === 'ingest lock').length === 3;
        for (let i = 0; i < 100 && !lost(); i++) await sleep(20);
        expect(lastOf('ingest lock')).toMatchObject({ level: 50, held: false, cause: '57P01' });
        expect(await a.held()).toBe(true);
        expect(lastOf('ingest lock')).toMatchObject({ level: 30, held: true });
        const [again] = await holder();
        expect(again).toBeDefined();
        expect(again).not.toBe(pid);
        expect(await b.held()).toBe(false);
      } finally {
        await a.release();
        await b.release();
        await admin.destroy();
      }
    });
  });

  it('logs one line per session with fixed codes: no URL, password or response body', () => {
    const text = lines.join('');
    expect(text).not.toMatch(/openf1\.org|https?:|TRACK LIMITS|No results/);
    // Nor a team name from the fixtures (the driver rows), the recovery lines (#103) included.
    for (const c of ['normal', 'quali', 'sprint'])
      for (const d of raw(`drivers-${c}`) as { team_name: string }[]) expect(text).not.toContain(d.team_name);
    expect(lines.some((l) => l.includes('"msg":"rederive_done"'))).toBe(true);
    expect(text).not.toContain(new URL(testDb.urls.f1_ingest).password);
    const failure = lines.map((l) => JSON.parse(l)).find((l) => l.session_key === 11388 && l.last_error === 'http_500');
    expect(failure).toMatchObject({ msg: 'session', state: 'due', last_error: 'http_500' });
    expect(CANCELLED.map(requested)).toEqual(CANCELLED.map(() => 0)); // over the whole file
  });
});
