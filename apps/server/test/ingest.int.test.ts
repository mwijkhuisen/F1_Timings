import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import {
  backfill,
  type Deps,
  processSession,
  SYNC_RETRY_MS,
  scheduleSync,
  syncSchedule,
  tick,
} from '../src/ingest/ingest.ts';
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
const EMPTY = 11465; // 2026 testing, day 1: served the *-empty fixtures (OpenF1's 404 "No results found.")
// The 10 sessions sessions-year marks is_cancelled (Bahrain and Saudi Arabia, April 2026).
const CANCELLED = [11254, 11255, 11256, 11257, 11261, 11262, 11263, 11264, 11265, 11269];
const TABLES = ['driver', 'lap', 'stint', 'pit', 'race_control', 'result', 'raw_response'] as const;

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
  });
  afterAll(async () => {
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
    expect(beats - before).toBe(94 * 6 + 2 + 95 + 1); // after each OpenF1 call (11388 fails at its 2nd), each session, the tick
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
      stint: 0,
      pit: 0,
      race_control: 0,
      result: 0,
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
      stint: 9,
      pit: 5,
      race_control: 155,
      result: 22,
      raw_response: 6,
    });
    expect(await rowCounts(11392)).toEqual({
      driver: 4,
      lap: 50,
      stint: 16,
      pit: 16,
      race_control: 39,
      result: 22,
      raw_response: 6,
    });
    expect(await rowCounts(11383)).toEqual({
      driver: 4,
      lap: 57,
      stint: 14,
      pit: 10,
      race_control: 159,
      result: 22,
      raw_response: 6,
    });
    expect(await rowCounts(EMPTY)).toEqual({
      driver: 0,
      lap: 0,
      stint: 0,
      pit: 0,
      race_control: 0,
      result: 0,
      raw_response: 6,
    });
    expect(await session(EMPTY)).toMatchObject({ ingest_state: 'final', fetch_count: 2 });
    expect(await countWhere('raw_response', EMPTY, "http_status = 404 AND body = '[]'")).toBe(6);

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
    expect(await rowCounts(11388)).toMatchObject({ lap: 60, raw_response: 6 });
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

  it('last_error takes every D5 code through the CHECK; the 9th failure in a row marks the session failed', async () => {
    const set = (code: string) =>
      sql`UPDATE session SET last_error = ${code} WHERE session_key = ${EMPTY}`.execute(db).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    for (const code of ['http_401', 'http_500', ...ERROR_CODES]) expect(await set(code)).toBe('ok');
    for (const code of ['http_5000', 'boom', 'live_session']) expect(await set(code)).toBe('23514');

    await db.updateTable('session').set({ fail_count: 8, last_error: null }).where('session_key', '=', EMPTY).execute();
    openf1((endpoint, key) =>
      endpoint === 'laps' && key === EMPTY ? new HttpResponse(null, { status: 500 }) : undefined,
    );
    expect(await processSession(deps, EMPTY)).toEqual({ ok: false, error: 'http_500' });
    expect(await session(EMPTY)).toMatchObject({
      ingest_state: 'failed',
      next_fetch_at: null,
      fail_count: 9,
      last_error: 'http_500',
    });
    openf1();
    expect(await processSession(deps, EMPTY, true)).toEqual({ ok: true, value: 'final' }); // a refetch recovers it
    expect(await session(EMPTY)).toMatchObject({ ingest_state: 'final', fail_count: 0, last_error: null });
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

  it('logs one line per session with fixed codes: no URL, password or response body', () => {
    const text = lines.join('');
    expect(text).not.toMatch(/openf1\.org|https?:|TRACK LIMITS|No results/);
    expect(text).not.toContain(new URL(testDb.urls.f1_ingest).password);
    const failure = lines.map((l) => JSON.parse(l)).find((l) => l.session_key === 11388 && l.last_error === 'http_500');
    expect(failure).toMatchObject({ msg: 'session', state: 'due', last_error: 'http_500' });
    expect(CANCELLED.map(requested)).toEqual(CANCELLED.map(() => 0)); // over the whole file
  });
});
