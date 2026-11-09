import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { tick } from '../src/ingest/ingest.ts';
import { run } from '../src/main.ts';
import { type Clock, createClient, OPENF1 } from '../src/openf1/client.ts';
import { createBudget, createRainClient, FORECAST, HISTORICAL, MAX_PAUSE_MS } from '../src/rain/client.ts';
import { createRainStep } from '../src/rain/job.ts';
import { createTestDb, type TestDb } from './db.ts';

// The rain job (P5c, A§8) against a real PostgreSQL 18, logged in as f1_ingest, with both Open-Meteo hosts
// replaced by msw: the central-wet fixture (Monaco 2023 race 9094) where the job asks exactly its query, else an
// answer built on the asked steps (location 0 null, the others `wet` mm). Every expected date is a literal.

const FIXTURES = join(import.meta.dirname, '../src/rain/fixtures');
const WET_QUERY = (JSON.parse(readFileSync(join(FIXTURES, 'central-wet.meta.json'), 'utf8')) as { query: object })
  .query;
const WET_RAW = readFileSync(join(FIXTURES, 'central-wet.raw'), 'utf8');
const canon = (q: object) => JSON.stringify(Object.entries(q).sort());

type Seen = { host: 'forecast' | 'historical'; query: Record<string, string> };
const seen: Seen[] = [];
let reply: () => Response | undefined;
let wet: number;

function built(query: Record<string, string>): unknown[] {
  const from = Date.parse(`${query.start_minutely_15}Z`) / 1000;
  const to = Date.parse(`${query.end_minutely_15}Z`) / 1000;
  const time: number[] = [];
  for (let t = from; t <= to; t += 900) time.push(t);
  const lons = (query.longitude ?? '').split(',');
  return (query.latitude ?? '').split(',').map((lat, k) => ({
    latitude: Number(lat),
    longitude: Number(lons[k]),
    minutely_15: { time, precipitation: time.map(() => (k === 0 ? null : wet)) },
  }));
}
const host = (name: Seen['host'], url: string) =>
  http.get(url, ({ request }) => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    seen.push({ host: name, query });
    const override = reply();
    if (override) return override;
    if (name === 'historical' && canon(query) === canon(WET_QUERY))
      return new HttpResponse(WET_RAW, { headers: { 'content-type': 'application/json' } });
    return HttpResponse.json(built(query));
  });

// The client's limiter sleeps on this clock: virtual, so the test never waits.
let virtual = 0;
const clock: Clock = {
  now: () => virtual,
  sleep: async (ms) => {
    virtual += ms;
  },
};
let at = new Date(0);
let beats = 0;
const lines: Record<string, unknown>[] = [];
const logged = (msg: string) => lines.filter((l) => l.msg === msg);
const log = pino({ base: null }, { write: (line: string) => void lines.push(JSON.parse(line)) });

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;

const MC = 1; // Monte Carlo
const LIVE = ['2026-11-15T13:00:00Z', '2026-11-15T15:00:00Z'] as const;
const meeting = (meeting_key: number, circuit_short_name: string | null) =>
  admin.insertInto('meeting').values({ meeting_key, source: 'openf1', year: 2026, circuit_short_name }).execute();
const session = (key: number, meeting_key: number, [date_start, date_end]: readonly [string, string], extra = {}) =>
  admin
    .insertInto('session')
    .values({
      session_key: key,
      source: 'openf1',
      meeting_key,
      type: 'Race',
      name: 'Race',
      date_start,
      date_end,
      ...extra,
    })
    .execute();
const grid = (key: number) =>
  admin.selectFrom('rain_grid').selectAll().where('session_key', '=', key).executeTakeFirst();
const frames = (key: number) =>
  admin.selectFrom('rain_frame').selectAll().where('session_key', '=', key).orderBy('date').execute();
const dates = (rows: { date: Date }[]) => rows.map((r) => r.date.toISOString().slice(11, 16));

/** A fresh daemon process's rain step: its own client, budget (on the test's `at`), seed and log memory. */
function daemon(budget = createBudget({ now: () => at.getTime() })) {
  const client = createRainClient({ clock });
  const step = createRainStep({ db, client, budget, now: () => at, log, beat: () => void beats++ });
  return { run: () => step(() => false), budget, client };
}

/** Never a URL, a coordinate or a body in a log line. */
const expectClean = () => {
  const text = JSON.stringify(lines);
  for (const bad of ['://', 'open-meteo', '43.7', '7.42', 'reason']) expect(text).not.toContain(bad);
};

describe('rain job (Open-Meteo through msw, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });
  beforeEach(async () => {
    await admin.deleteFrom('meeting').execute(); // cascades to session, rain_grid and rain_frame
    seen.length = 0;
    lines.length = 0;
    reply = () => undefined;
    wet = 0.1;
    server.use(host('forecast', FORECAST), host('historical', HISTORICAL));
  });

  it('a session in its live window gets a grid, fetched every 15 min up to now; a refetch replaces the frames', async () => {
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    const p = daemon();
    at = new Date('2026-11-15T13:07:00Z');
    let before = beats;
    await p.run();
    expect(beats - before).toBe(3); // start, after the grid, end
    expect(seen.map((s) => s.host)).toEqual(['forecast']);
    expect(seen[0]?.query).toMatchObject({
      minutely_15: 'precipitation',
      start_minutely_15: '2026-11-15T12:00',
      end_minutely_15: '2026-11-15T13:00',
    });
    expect(seen[0]?.query.latitude?.split(',')).toHaveLength(49);
    expect(seen[0]?.query.latitude?.split(',')[24]).toBe('43.7367');
    expect(await grid(100)).toEqual({
      session_key: 100,
      source: 'open-meteo',
      map_id: 'mc-1929',
      centre_lat: 43.7367,
      centre_lon: 7.4258,
      size: 7,
      step_m: 1500,
      state: 'live',
      next_fetch_at: new Date('2026-11-15T13:22:00Z'),
      fetch_count: 1,
      fail_count: 0,
      attempt_count: 1,
      last_error: null,
      updated_at: new Date('2026-11-15T13:07:00Z'),
    });
    let rows = await frames(100);
    expect(dates(rows)).toEqual(['12:00', '12:15', '12:30', '12:45', '13:00']);
    expect(rows[0]?.mm).toHaveLength(49);
    expect(rows[0]?.mm[0]).toBeNull();
    expect(rows[0]?.mm[1]).toBe(0.1);
    const [line] = logged('rain');
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['api', 'frames', 'last_error', 'level', 'ms', 'msg', 'points', 'session_key', 'state', 'time'].sort(),
    );
    expect(line).toMatchObject({
      session_key: 100,
      api: 'forecast',
      state: 'live',
      frames: 5,
      points: 49,
      last_error: null,
    });

    at = new Date('2026-11-15T13:12:00Z');
    before = beats;
    await p.run();
    expect(seen).toHaveLength(1);
    expect(beats - before).toBe(2);

    wet = 0.4;
    at = new Date('2026-11-15T13:22:00Z');
    await p.run();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.query).toMatchObject({
      start_minutely_15: '2026-11-15T12:00',
      end_minutely_15: '2026-11-15T13:15',
    });
    rows = await frames(100);
    expect(dates(rows)).toEqual(['12:00', '12:15', '12:30', '12:45', '13:00', '13:15']);
    expect(rows.every((r) => r.mm[0] === null && r.mm[48] === 0.4)).toBe(true);
    expect(await grid(100)).toMatchObject({ next_fetch_at: new Date('2026-11-15T13:37:00Z'), fetch_count: 2 });
    expectClean();
  });

  it('after the live window a grid waits until date_end + 24 h; then one historical fetch makes it final', async () => {
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    const p = daemon();
    at = new Date('2026-11-15T15:20:00Z'); // the window's last minutes: at + 15 min is past end + 30 min
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['forecast']);
    expect(seen[0]?.query).toMatchObject({ end_minutely_15: '2026-11-15T15:15' });
    expect(await grid(100)).toMatchObject({
      state: 'live',
      next_fetch_at: new Date('2026-11-16T15:00:00Z'),
      fetch_count: 1,
    });

    at = new Date('2026-11-16T14:59:00Z');
    await p.run();
    expect(seen).toHaveLength(1);

    at = new Date('2026-11-16T15:00:00Z');
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['forecast', 'historical']);
    expect(seen[1]?.query).toMatchObject({
      start_minutely_15: '2026-11-15T12:00',
      end_minutely_15: '2026-11-15T15:30',
    });
    expect(await grid(100)).toMatchObject({ state: 'final', next_fetch_at: null, fetch_count: 2, last_error: null });
    const rows = await frames(100);
    expect(rows).toHaveLength(15);
    expect(dates(rows).at(-1)).toBe('15:30');
    expect(logged('rain').at(-1)).toMatchObject({ api: 'historical', state: 'final', frames: 15 });

    at = new Date('2026-11-17T15:00:00Z');
    await p.run();
    expect(seen).toHaveLength(2);
  });

  it('a failure backs off 5 min · 2^(n−1) with a fixed code; the 9th in a row marks the grid failed', async () => {
    reply = () => HttpResponse.json({ error: true, reason: 'body-text' }, { status: 500 });
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    const p = daemon();
    at = new Date('2026-11-15T13:07:00Z');
    await p.run();
    expect(await grid(100)).toMatchObject({
      state: 'live',
      fetch_count: 0,
      fail_count: 1,
      last_error: 'http_500',
      next_fetch_at: new Date('2026-11-15T13:12:00Z'),
      updated_at: at,
    });
    expect(await frames(100)).toEqual([]);
    const [line] = logged('rain');
    expect(line).toMatchObject({ level: 50, session_key: 100, state: 'live', frames: 0, last_error: 'http_500' });
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['api', 'frames', 'last_error', 'level', 'ms', 'msg', 'points', 'session_key', 'state', 'time'].sort(),
    );

    const delays: number[] = [];
    for (let n = 2; n <= 9; n++) {
      const g = await grid(100);
      delays.push(((g?.next_fetch_at?.getTime() ?? 0) - at.getTime()) / 60_000);
      at = g?.next_fetch_at ?? at;
      await p.run();
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(await grid(100)).toMatchObject({ state: 'failed', next_fetch_at: null, fail_count: 9, attempt_count: 9 });
    expect(seen).toHaveLength(9);
    expect(seen.every((s) => s.host === 'forecast')).toBe(true);
    at = new Date('2026-11-18T00:00:00Z');
    await p.run();
    expect(seen).toHaveLength(9);
    expectClean();
  });

  it('a 429 is rate_limited', async () => {
    reply = () => new HttpResponse(null, { status: 429 });
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    at = new Date('2026-11-15T13:07:00Z');
    await daemon().run();
    expect(await grid(100)).toMatchObject({ state: 'live', fail_count: 1, last_error: 'rate_limited' });
  });

  it('a 429 of Retry-After 86400 pauses the job for 5 min: no request, budget, failure or wait meanwhile', async () => {
    let requests = 0;
    reply = () =>
      requests++ === 0 ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '86400' } }) : undefined;
    await meeting(MC, 'Monte Carlo');
    await session(9094, MC, ['2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z']);
    await session(9093, MC, ['2023-05-27T14:00:00Z', '2023-05-27T15:00:00Z']); // a backfill candidate throughout
    const p = daemon();
    at = new Date('2026-11-09T12:00:00Z');
    await p.run();
    expect(await grid(9094)).toMatchObject({ fail_count: 1, attempt_count: 1, last_error: 'rate_limited' });
    expect(p.client.pausedFor()).toBe(MAX_PAUSE_MS);
    const before = { virtual, used: p.budget.used() };

    for (const minute of ['12:01', '12:02']) {
      at = new Date(`2026-11-09T${minute}:00Z`);
      await p.run();
    }
    expect(seen).toHaveLength(1);
    expect(virtual).toBe(before.virtual); // the limiter never slept: nothing waited on the pause
    expect(p.budget.used()).toEqual(before.used);
    expect(await grid(9093)).toBeUndefined();
    expect(await grid(9094)).toMatchObject({ fail_count: 1, attempt_count: 1 });
    expect(logged('rain_paused')).toEqual([expect.objectContaining({ ms: MAX_PAUSE_MS })]);
    expect(logged('rain_budget')).toEqual([]);

    virtual += MAX_PAUSE_MS; // the client's clock passes the pause
    at = new Date('2026-11-09T12:03:00Z');
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['historical', 'historical']);
    expect(await grid(9093)).toMatchObject({ state: 'final', attempt_count: 1 });
    expect(logged('rain_paused')).toHaveLength(1);
  });

  it('one Open-Meteo request per step: the newest due grid, then the next, then one backfill session', async () => {
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    await session(101, MC, ['2026-11-15T13:00:00Z', '2026-11-15T14:00:00Z']); // live too, ends earlier
    await session(9094, MC, ['2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z']);
    const p = daemon();
    for (const minute of ['13:07', '13:08', '13:09']) {
      at = new Date(`2026-11-15T${minute}:00Z`);
      const before = seen.length;
      await p.run();
      expect(seen.length - before).toBe(1);
      if (minute === '13:07') expect(await grid(101)).toMatchObject({ state: 'live', attempt_count: 0 }); // due, waits
    }
    expect(logged('rain').map((l) => [l.session_key, l.api])).toEqual([
      [100, 'forecast'],
      [101, 'forecast'],
      [9094, 'historical'],
    ]);
    expect(p.budget.used().hour).toBe(3 * 49);
  });

  it('a due grid budget kind: a backfill grid that never succeeded retries as backfill, a final fetch as live', async () => {
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    await session(9094, MC, ['2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z']);
    const due = (session_key: number, fetch_count: number, next_fetch_at: string) =>
      admin
        .insertInto('rain_grid')
        .values({
          session_key,
          source: 'open-meteo',
          map_id: 'mc-1929',
          centre_lat: 43.7367,
          centre_lon: 7.4258,
          size: 7,
          step_m: 1500,
          state: 'live',
          next_fetch_at,
          fetch_count,
          fail_count: fetch_count === 0 ? 1 : 0,
          updated_at: '2026-11-15T15:20:00Z',
        })
        .execute();
    await due(100, 1, '2026-11-16T15:00:00Z'); // the final fetch after a live refresh
    await due(9094, 0, '2026-11-15T15:25:00Z'); // a failed backfill, due again
    // No backfill share at all: only a live take can pass.
    const p = daemon(createBudget({ now: () => at.getTime() }, { hour: 4000, day: 8000, backfillDay: 0 }));
    at = new Date('2026-11-16T15:00:00Z');
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['historical']);
    expect(await grid(100)).toMatchObject({ state: 'final', fetch_count: 2 });
    at = new Date('2026-11-16T15:01:00Z');
    await p.run();
    expect(seen).toHaveLength(1);
    expect(await grid(9094)).toMatchObject({ state: 'live', fail_count: 1, attempt_count: 0 });
    expect(logged('rain_budget')).toEqual([expect.objectContaining({ kind: 'backfill' })]);
  });

  it('an answer without steps is schema: the grid does not become final with 0 frames', async () => {
    const none = { time: [], precipitation: [] };
    reply = () =>
      HttpResponse.json(Array.from({ length: 49 }, () => ({ latitude: 0, longitude: 0, minutely_15: none })));
    await meeting(MC, 'Monte Carlo');
    await session(9093, MC, ['2023-05-27T14:00:00Z', '2023-05-27T15:00:00Z']);
    at = new Date('2026-11-09T12:00:00Z');
    await daemon().run();
    expect(seen).toHaveLength(1);
    expect(await grid(9093)).toMatchObject({ state: 'live', fetch_count: 0, fail_count: 1, last_error: 'schema' });
    expect(await frames(9093)).toEqual([]);
  });

  it('a precipitation below real range (1e-50) is stored as null, not a db failure', async () => {
    wet = 1e-50;
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    at = new Date('2026-11-15T13:07:00Z');
    await daemon().run();
    expect(await grid(100)).toMatchObject({ state: 'live', fetch_count: 1, last_error: null });
    const rows = await frames(100);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.mm.every((mm) => mm === null))).toBe(true);
  });

  it('the backfill takes one past mapped session per step, newest first; an unmapped one never gets a grid', async () => {
    await meeting(MC, 'Monte Carlo');
    await meeting(2, 'Nowhere');
    await meeting(3, null);
    await session(9094, MC, ['2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z']); // the central-wet fixture's race
    await session(9093, MC, ['2023-05-27T14:00:00Z', '2023-05-27T15:00:00Z']);
    await session(9092, MC, ['2023-05-27T10:30:00Z', '2023-05-27T11:30:00Z']);
    await session(9300, MC, ['2023-06-11T13:00:00Z', '2023-06-11T15:00:00Z'], { is_cancelled: true });
    await session(9200, 2, ['2023-06-04T13:00:00Z', '2023-06-04T15:00:00Z']); // newer, unmapped
    await session(9201, 3, ['2023-06-03T13:00:00Z', '2023-06-03T15:00:00Z']);
    const p = daemon();
    at = new Date('2026-11-09T12:00:00Z');

    await p.run();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.host).toBe('historical');
    expect(canon(seen[0]?.query ?? {})).toBe(canon(WET_QUERY)); // the recorder's query, built by the job
    expect(await grid(9094)).toMatchObject({ state: 'final', fetch_count: 1, next_fetch_at: null });
    const rows = await frames(9094);
    expect(rows).toHaveLength(15);
    const fixture = JSON.parse(WET_RAW) as { minutely_15: { precipitation: (number | null)[] } }[];
    for (const i of [0, 7, 14]) expect(rows[i]?.mm).toEqual(fixture.map((l) => l.minutely_15.precipitation[i]));

    await p.run();
    expect(seen).toHaveLength(2);
    expect(await grid(9093)).toMatchObject({ state: 'final' });
    expect(seen[1]?.query).toMatchObject({
      start_minutely_15: '2023-05-27T13:00',
      end_minutely_15: '2023-05-27T15:30',
    });
    await p.run();
    expect(await grid(9092)).toMatchObject({ state: 'final' });
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['historical', 'historical', 'historical']);
    for (const key of [9200, 9201, 9300]) expect(await grid(key)).toBeUndefined();
    expect(logged('rain_unmapped')).toEqual([expect.objectContaining({ count: 2 })]);
    expect(logged('rain').map((l) => [l.session_key, l.api, l.state])).toEqual([
      [9094, 'historical', 'final'],
      [9093, 'historical', 'final'],
      [9092, 'historical', 'final'],
    ]);
  });

  it('a budget refusal ends the step, logged once per streak; live grids still get their share', async () => {
    await meeting(MC, 'Monte Carlo');
    await session(9094, MC, ['2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z']);
    await session(9093, MC, ['2023-05-27T14:00:00Z', '2023-05-27T15:00:00Z']);
    await session(100, MC, LIVE); // its window opens at 12:30
    const p = daemon(createBudget({ now: () => at.getTime() }, { hour: 4000, day: 8000, backfillDay: 49 }));
    at = new Date('2026-11-15T12:00:00Z');
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['historical']);
    at = new Date('2026-11-15T12:01:00Z');
    await p.run();
    expect(seen).toHaveLength(1);
    expect(logged('rain_budget')).toEqual([expect.objectContaining({ kind: 'backfill', used: { hour: 49, day: 49 } })]);
    at = new Date('2026-11-15T12:30:00Z');
    await p.run();
    expect(seen.map((s) => s.host)).toEqual(['historical', 'forecast']);
    expect(await grid(100)).toMatchObject({ state: 'live', fetch_count: 1 });
    expect(await grid(9093)).toBeUndefined();
    expect(logged('rain_budget')).toHaveLength(1);
  });

  it('a restart seeds the budget from the attempts of the grids touched in the last day and hour, once', async () => {
    await meeting(MC, 'Monte Carlo');
    at = new Date('2026-11-15T12:00:00Z');
    const rows: [number, number, number, number, number][] = [
      // [key, fetch_count, fail_count, attempt_count, minutes before at]
      [9094, 3, 0, 4, 30], // 4 × 49 = 196 in the hour and the day (fail_count was reset by a success)
      [9093, 2, 0, 2, 5 * 60], // 98 in the day
      [9092, 5, 0, 5, 25 * 60], // outside both
    ];
    for (const [key, fetch_count, fail_count, attempt_count, ago] of rows) {
      await session(key, MC, ['2023-05-27T10:00:00Z', '2023-05-27T11:00:00Z']);
      await admin
        .insertInto('rain_grid')
        .values({
          session_key: key,
          source: 'open-meteo',
          map_id: 'mc-1929',
          centre_lat: 43.7367,
          centre_lon: 7.4258,
          size: 7,
          step_m: 1500,
          state: 'final',
          fetch_count,
          fail_count,
          attempt_count,
          updated_at: new Date(at.getTime() - ago * 60_000),
        })
        .execute();
    }
    const p = daemon();
    await p.run();
    expect(p.budget.used()).toEqual({ hour: 196, day: 294 });
    await p.run();
    expect(p.budget.used()).toEqual({ hour: 196, day: 294 });
    expect(seen).toEqual([]);
  });

  it('a grid that failed and then succeeded seeds both attempts after a restart', async () => {
    let requests = 0;
    reply = () => (requests++ === 0 ? HttpResponse.json({ error: true }, { status: 500 }) : undefined);
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    at = new Date('2026-11-15T13:07:00Z');
    const first = daemon();
    await first.run();
    at = new Date('2026-11-15T13:12:00Z');
    await first.run();
    expect(await grid(100)).toMatchObject({ fetch_count: 1, fail_count: 0, attempt_count: 2 });
    expect(first.budget.used()).toEqual({ hour: 98, day: 98 });

    at = new Date('2026-11-15T13:13:00Z'); // a restart: nothing is due (the grid's next fetch is 13:27)
    const restarted = daemon();
    await restarted.run();
    expect(seen).toHaveLength(2);
    expect(restarted.budget.used()).toEqual({ hour: 98, day: 98 }); // (fetch_count + fail_count) × 49 would be 49
  });

  it('runs during a live window while the OpenF1 tick waits: no OpenF1 request, one Open-Meteo fetch', async () => {
    let openf1 = 0;
    server.use(
      http.get(`${OPENF1}/:endpoint`, () => {
        openf1++;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    await meeting(MC, 'Monte Carlo');
    await session(100, MC, LIVE);
    // A past session that is due for OpenF1: the tick would fetch it outside a live window.
    await session(101, MC, ['2026-11-14T13:00:00Z', '2026-11-14T15:00:00Z'], {
      ingest_state: 'due',
      next_fetch_at: '2026-11-14T15:35:00Z',
    });
    at = new Date('2026-11-15T13:07:00Z');
    const deps = { db, client: createClient({ clock }), now: () => at, log, beat: () => void beats++ };
    expect(await tick(deps)).toBe(0);
    await daemon().run();
    expect(openf1).toBe(0);
    expect(logged('live session: waiting')).toHaveLength(1);
    expect(seen.map((s) => s.host)).toEqual(['forecast']);
    expect(await grid(100)).toMatchObject({ state: 'live', fetch_count: 1 });
  });
});
