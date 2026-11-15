import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { pingHealthchecks } from '../src/healthchecks.ts';
import { run } from '../src/main.ts';
import type { Clock } from '../src/openf1/client.ts';
import { createBudget, createRainClient, FORECAST, HISTORICAL } from '../src/rain/client.ts';
import { createRainStep } from '../src/rain/job.ts';
import { createTestDb, type TestDb } from './db.ts';

// The weekend forecast (#120, A§8) as a part of the rain step, against a real PostgreSQL 18, logged in as f1_ingest,
// on a virtual clock. Las Vegas 2026 (meeting 1300): FP1 Fri 20 Nov 00:30 UTC to the race's end Sun 22 Nov 06:00 UTC.
// Both Open-Meteo hosts are msw: a forecast query gets an answer built on its asked hours, a rain query one built on
// its asked steps. Every expected date is a literal.

const HOUR = 3_600_000;
const LV = 1300;
const MC = 1; // Monte Carlo, for a backfill candidate
const SESSIONS = [
  [11413, 'Practice 1', '2026-11-20T00:30:00Z', '2026-11-20T01:30:00Z'],
  [11414, 'Practice 2', '2026-11-20T04:00:00Z', '2026-11-20T05:00:00Z'],
  [11415, 'Practice 3', '2026-11-21T00:30:00Z', '2026-11-21T01:30:00Z'],
  [11416, 'Qualifying', '2026-11-21T04:00:00Z', '2026-11-21T05:00:00Z'],
  [11420, 'Race', '2026-11-22T04:00:00Z', '2026-11-22T06:00:00Z'],
] as const;
/** What the job asks for Las Vegas: CIRCUITS['Las Vegas'] over [floorHour(FP1 start), ceilHour(race end)]. */
const VEGAS_QUERY = {
  latitude: '36.1167',
  longitude: '-115.1666',
  hourly: 'precipitation_probability,precipitation,temperature_2m,wind_speed_10m',
  start_hour: '2026-11-20T00:00',
  end_hour: '2026-11-22T06:00',
  timeformat: 'unixtime',
  timezone: 'GMT',
  wind_speed_unit: 'ms',
  cell_selection: 'land',
};
// The owner-recorded answer to VEGAS_QUERY (forecast-vegas, #120): served while `recorded` is set.
const FIXTURES = join(import.meta.dirname, '../src/rain/fixtures');
const RECORDED = JSON.parse(readFileSync(join(FIXTURES, 'forecast-vegas.meta.json'), 'utf8')) as {
  query: Record<string, string>;
};
const RECORDED_RAW = readFileSync(join(FIXTURES, 'forecast-vegas.raw'), 'utf8');
const RECORDED_HOURLY = (
  JSON.parse(RECORDED_RAW) as {
    hourly: {
      precipitation_probability: number[];
      precipitation: number[];
      temperature_2m: number[];
      wind_speed_10m: number[];
    };
  }
).hourly;
const canon = (q: object) => JSON.stringify(Object.entries(q).sort());

type Seen = { kind: 'forecast' | 'rain'; host: 'forecast' | 'historical'; query: Record<string, string>; at: string };
const seen: Seen[] = [];
let reply: () => Response | undefined;
let chance: number;
let recorded: boolean;

const steps = (from: string | undefined, to: string | undefined, s: number) => {
  const time: number[] = [];
  for (let t = Date.parse(`${from}Z`) / 1000; t <= Date.parse(`${to}Z`) / 1000; t += s) time.push(t);
  return time;
};
/** A one-point answer on the asked hours: the first hour's chance null, then `chance` %. */
function builtForecast(query: Record<string, string>) {
  const time = steps(query.start_hour, query.end_hour, 3600);
  return {
    latitude: 36.12,
    longitude: -115.17,
    elevation: 610,
    hourly: {
      time,
      precipitation_probability: time.map((_, i) => (i === 0 ? null : chance)),
      precipitation: time.map(() => 0.1),
      temperature_2m: time.map(() => 18.5),
      wind_speed_10m: time.map(() => 3.2),
    },
  };
}
function builtRain(query: Record<string, string>) {
  const time = steps(query.start_minutely_15, query.end_minutely_15, 900);
  return (query.latitude ?? '').split(',').map(() => ({
    latitude: 0,
    longitude: 0,
    minutely_15: { time, precipitation: time.map(() => 0) },
  }));
}
const host = (name: Seen['host'], url: string) =>
  http.get(url, ({ request }) => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const kind = 'hourly' in query ? 'forecast' : 'rain';
    seen.push({ kind, host: name, query, at: at.toISOString() });
    const override = kind === 'forecast' ? reply() : undefined;
    if (override) return override;
    if (kind === 'forecast' && recorded && canon(query) === canon(VEGAS_QUERY))
      return new HttpResponse(RECORDED_RAW, { headers: { 'content-type': 'application/json' } });
    return HttpResponse.json(kind === 'forecast' ? builtForecast(query) : builtRain(query));
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
const d = (iso: string) => new Date(iso);
const lines: Record<string, unknown>[] = [];
const logged = (msg: string) => lines.filter((l) => l.msg === msg);
const log = pino({ base: null }, { write: (line: string) => void lines.push(JSON.parse(line)) });

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;

const meeting = (meeting_key: number, circuit_short_name: string | null, is_cancelled = false) =>
  admin
    .insertInto('meeting')
    .values({ meeting_key, source: 'openf1', year: 2026, circuit_short_name, is_cancelled })
    .execute();
const session = (key: number, meeting_key: number, name: string, date_start: string, date_end: string, extra = {}) =>
  admin
    .insertInto('session')
    .values({ session_key: key, source: 'openf1', meeting_key, type: name, name, date_start, date_end, ...extra })
    .execute();
async function vegas(): Promise<void> {
  await meeting(LV, 'Las Vegas');
  for (const [key, name, start, end] of SESSIONS) await session(key, LV, name, start, end);
}
/** Final rain grids keep the rain out of a run: no live grid, no backfill. */
async function finalGrids(keys: readonly number[] = SESSIONS.map(([key]) => key)): Promise<void> {
  for (const session_key of keys)
    await admin
      .insertInto('rain_grid')
      .values({
        session_key,
        source: 'open-meteo',
        map_id: 'us-2023',
        centre_lat: 36.1167,
        centre_lon: -115.1666,
        size: 7,
        step_m: 1500,
        state: 'final',
        updated_at: '2026-11-01T00:00:00Z',
      })
      .execute();
}
const row = (key: number) => admin.selectFrom('forecast').selectAll().where('meeting_key', '=', key).executeTakeFirst();
const hours = (key: number) =>
  admin.selectFrom('forecast_hour').selectAll().where('meeting_key', '=', key).orderBy('date').execute();
const LINE_KEYS = ['hours', 'last_error', 'level', 'meeting_key', 'ms', 'msg', 'state', 'time'].sort();

// The real healthchecks.io ping, with a key in a temp secrets directory; msw records every ping.
let secrets: string;
const pings: string[] = [];
const ping = (slug: string, body?: string) => pingHealthchecks(slug, log, { secretsDir: secrets, body });

/** A fresh daemon process's rain step: its own client, budget (on the test's `at`), seed and log memory. */
function daemon(budget = createBudget({ now: () => at.getTime() })) {
  const client = createRainClient({ clock });
  const step = createRainStep({ db, client, budget, now: () => at, log, beat: () => {}, ping });
  return { run: () => step(() => false), budget };
}

/** Never a URL, a coordinate or a body in a log line. */
const expectClean = () => {
  const text = JSON.stringify(lines);
  for (const bad of ['://', 'open-meteo', '36.1', '115.1', 'reason', 'body-text']) expect(text).not.toContain(bad);
};

describe('weekend forecast (Open-Meteo through msw, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
    secrets = mkdtempSync(join(tmpdir(), 'f1-hc-'));
    writeFileSync(join(secrets, 'hc_ping_key'), 'AbCdEfGhIjKlMnOpQrStUv\n');
  });
  afterAll(async () => {
    rmSync(secrets, { recursive: true, force: true });
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });
  beforeEach(async () => {
    await admin.deleteFrom('meeting').execute(); // cascades to session, rain_grid, forecast and their rows
    seen.length = 0;
    lines.length = 0;
    pings.length = 0;
    reply = () => undefined;
    recorded = false;
    chance = 40;
    server.use(
      host('forecast', FORECAST),
      host('historical', HISTORICAL),
      http.all('https://hc-ping.com/*', async ({ request }) => {
        pings.push(
          `${request.method} ${new URL(request.url).pathname.split('/').slice(2).join('/')} ${await request.text()}`,
        );
        return new HttpResponse('OK');
      }),
    );
  });

  it('none on Tue 23:59; Wed 00:00 opens one and fetches the hours; none at +1 h; +3 h refreshes them', async () => {
    expect(RECORDED.query).toEqual(VEGAS_QUERY);
    recorded = true;
    await vegas();
    await finalGrids();
    const p = daemon();
    at = d('2026-11-17T23:59:00Z');
    await p.run();
    expect(await row(LV)).toBeUndefined();
    expect(seen).toEqual([]);

    at = d('2026-11-18T00:00:00Z');
    await p.run();
    expect(seen.map((s) => [s.kind, s.host])).toEqual([['forecast', 'forecast']]);
    expect(seen[0]?.query).toEqual(VEGAS_QUERY);
    expect(await row(LV)).toEqual({
      meeting_key: LV,
      source: 'open-meteo',
      map_id: 'us-2023',
      lat: 36.1167,
      lon: -115.1666,
      state: 'live',
      next_fetch_at: d('2026-11-18T03:00:00Z'),
      fetched_at: d('2026-11-18T00:00:00Z'),
      fetch_count: 1,
      fail_count: 0,
      attempt_count: 1,
      last_error: null,
      updated_at: d('2026-11-18T00:00:00Z'),
    });
    let rows = await hours(LV);
    expect(rows).toHaveLength(55); // Fri 00:00 to Sun 06:00, both included
    expect(rows[0]).toEqual({
      meeting_key: LV,
      date: d('2026-11-20T00:00:00Z'),
      precipitation_probability: RECORDED_HOURLY.precipitation_probability[0],
      precipitation: RECORDED_HOURLY.precipitation[0],
      temperature_2m: RECORDED_HOURLY.temperature_2m[0],
      wind_speed_10m: RECORDED_HOURLY.wind_speed_10m[0],
    });
    expect(rows[1]?.precipitation_probability).toBe(RECORDED_HOURLY.precipitation_probability[1]);
    expect(rows.at(-1)).toEqual({
      meeting_key: LV,
      date: d('2026-11-22T06:00:00Z'),
      precipitation_probability: RECORDED_HOURLY.precipitation_probability.at(-1),
      precipitation: RECORDED_HOURLY.precipitation.at(-1),
      temperature_2m: RECORDED_HOURLY.temperature_2m.at(-1),
      wind_speed_10m: RECORDED_HOURLY.wind_speed_10m.at(-1),
    });
    const [line] = logged('forecast');
    expect(Object.keys(line ?? {}).sort()).toEqual(LINE_KEYS);
    expect(line).toMatchObject({ level: 30, meeting_key: LV, state: 'live', hours: 55, last_error: null });

    for (const time of ['01:00', '02:59']) {
      at = d(`2026-11-18T${time}:00Z`);
      await p.run();
    }
    expect(seen).toHaveLength(1);

    recorded = false; // the refresh checks the built answer
    chance = 70;
    at = d('2026-11-18T03:00:00Z');
    await p.run();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.query).toEqual(VEGAS_QUERY);
    rows = await hours(LV);
    expect(rows).toHaveLength(55);
    expect(rows.slice(1).every((h) => h.precipitation_probability === 70)).toBe(true);
    expect(await row(LV)).toMatchObject({
      state: 'live',
      next_fetch_at: d('2026-11-18T06:00:00Z'),
      fetched_at: d('2026-11-18T03:00:00Z'),
      fetch_count: 2,
      attempt_count: 2,
    });
    expect(p.budget.used()).toEqual({ hour: 1, day: 2, forecast: 2 });
    expectClean();
  });

  it('hour by hour from Tuesday to Monday: 34 requests 3 h apart, the last Sun 03:00, then final and no more', async () => {
    await vegas();
    await finalGrids();
    const p = daemon();
    for (let t = Date.parse('2026-11-17T00:00:00Z'); t <= Date.parse('2026-11-23T00:00:00Z'); t += HOUR) {
      at = new Date(t);
      await p.run();
    }
    expect(seen.every((s) => s.kind === 'forecast' && s.host === 'forecast')).toBe(true);
    expect(seen).toHaveLength(34);
    expect(seen[0]?.at).toBe('2026-11-18T00:00:00.000Z');
    expect(seen.at(-1)?.at).toBe('2026-11-22T03:00:00.000Z');
    const times = seen.map((s) => Date.parse(s.at));
    expect(times.every((t, i) => i === 0 || t - (times[i - 1] ?? 0) === 3 * HOUR)).toBe(true);
    expect(await row(LV)).toMatchObject({
      state: 'final',
      next_fetch_at: null,
      fetched_at: d('2026-11-22T03:00:00Z'),
      fetch_count: 34,
      attempt_count: 34,
      last_error: null,
    });
    expect(await hours(LV)).toHaveLength(55);
    expect(logged('forecast')).toHaveLength(34);
    expect(logged('forecast').at(-1)).toMatchObject({ state: 'final', hours: 55 });
    expectClean();
  });

  it('a share of 3 refuses the 4th, logged once; the refused run goes to the backfill; the day slides', async () => {
    await vegas();
    await finalGrids();
    const p = daemon(createBudget({ now: () => at.getTime() }, { forecastDay: 3 }));
    for (const time of ['00:00', '03:00', '06:00']) {
      at = d(`2026-11-18T${time}:00Z`);
      await p.run();
    }
    expect(seen).toHaveLength(3);
    // A backfill candidate from here on.
    await meeting(MC, 'Monte Carlo');
    await session(9094, MC, 'Race', '2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z');

    at = d('2026-11-18T09:00:00Z');
    await p.run();
    expect(seen.map((s) => [s.kind, s.host])).toEqual([
      ['forecast', 'forecast'],
      ['forecast', 'forecast'],
      ['forecast', 'forecast'],
      ['rain', 'historical'],
    ]);
    expect(logged('rain_budget')).toEqual([
      expect.objectContaining({ kind: 'forecast', used: { hour: 0, day: 3, forecast: 3 } }),
    ]);
    expect(await row(LV)).toMatchObject({ state: 'live', next_fetch_at: d('2026-11-18T09:00:00Z'), attempt_count: 3 });

    at = d('2026-11-18T10:00:00Z');
    await p.run();
    expect(seen).toHaveLength(4);
    expect(logged('rain_budget')).toHaveLength(1);

    at = d('2026-11-19T00:00:00Z'); // Wednesday 00:00's call leaves the 24 h
    await p.run();
    expect(seen.map((s) => s.kind).at(-1)).toBe('forecast');
    expect(seen).toHaveLength(5);
    expect(await row(LV)).toMatchObject({ fetch_count: 4, next_fetch_at: d('2026-11-19T03:00:00Z') });
  });

  it('a due rain grid wins the run; the forecast goes at the next', async () => {
    await vegas();
    await finalGrids([11414, 11415, 11416, 11420]); // FP1's live window opens Fri 00:00
    const p = daemon();
    at = d('2026-11-20T00:00:00Z');
    await p.run();
    expect(seen.map((s) => [s.kind, s.host])).toEqual([['rain', 'forecast']]);
    expect(await row(LV)).toMatchObject({ state: 'live', next_fetch_at: at, attempt_count: 0 });

    at = d('2026-11-20T00:01:00Z');
    await p.run();
    expect(seen.map((s) => s.kind)).toEqual(['rain', 'forecast']);
    expect(await row(LV)).toMatchObject({ fetch_count: 1, next_fetch_at: d('2026-11-20T03:01:00Z') });

    at = d('2026-11-20T00:15:00Z');
    await p.run();
    expect(seen.map((s) => s.kind)).toEqual(['rain', 'forecast', 'rain']);
    expect(p.budget.used()).toEqual({ hour: 99, day: 99, forecast: 1 });
  });

  it('a failure backs off 5 min · 2^(n−1) with a fixed code; the 9th marks it failed and pings /fail', async () => {
    reply = () => HttpResponse.json({ error: true, reason: 'body-text' }, { status: 500 });
    await vegas();
    await finalGrids();
    const p = daemon();
    at = d('2026-11-18T00:00:00Z');
    await p.run();
    expect(await row(LV)).toMatchObject({
      state: 'live',
      fetch_count: 0,
      fail_count: 1,
      attempt_count: 1,
      last_error: 'http_500',
      next_fetch_at: d('2026-11-18T00:05:00Z'),
      fetched_at: null,
    });
    expect(await hours(LV)).toEqual([]);
    const [line] = logged('forecast');
    expect(Object.keys(line ?? {}).sort()).toEqual(LINE_KEYS);
    expect(line).toMatchObject({ level: 50, meeting_key: LV, state: 'live', hours: 0, last_error: 'http_500' });

    const delays: number[] = [];
    for (let n = 2; n <= 9; n++) {
      const f = await row(LV);
      delays.push(((f?.next_fetch_at?.getTime() ?? 0) - at.getTime()) / 60_000);
      at = f?.next_fetch_at ?? at;
      await p.run();
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(await row(LV)).toMatchObject({ state: 'failed', next_fetch_at: null, fail_count: 9, attempt_count: 9 });
    expect(pings).toEqual(['POST f1-ingest/fail forecast_failed http_500']);
    expect(seen).toHaveLength(9);
    at = d('2026-11-21T00:00:00Z');
    await p.run();
    expect(seen).toHaveLength(9);
    expect(pings).toHaveLength(1);
    expectClean();
  });

  it('no forecast for an unmapped, cancelled or over-long meeting; a cancelled or closed one becomes final unasked', async () => {
    await meeting(2, 'Nowhere');
    await session(201, 2, 'Race', '2026-11-20T04:00:00Z', '2026-11-20T06:00:00Z');
    await meeting(3, 'Lusail', true);
    await session(301, 3, 'Race', '2026-11-20T04:00:00Z', '2026-11-20T06:00:00Z');
    await meeting(4, 'Monte Carlo');
    await session(401, 4, 'Race', '2026-11-20T04:00:00Z', '2026-11-20T06:00:00Z', { is_cancelled: true });
    await meeting(5, 'Singapore');
    await session(501, 5, 'Practice 1', '2026-11-20T04:00:00Z', '2026-11-20T05:00:00Z');
    await session(502, 5, 'Race', '2026-11-27T04:00:00Z', '2026-11-27T06:00:00Z'); // 7 days and 2 h
    await vegas();
    await finalGrids();
    const p = daemon();
    at = d('2026-11-18T00:00:00Z');
    await p.run();
    expect(seen).toHaveLength(1);
    expect(await admin.selectFrom('forecast').select('meeting_key').execute()).toEqual([{ meeting_key: LV }]);

    await admin.updateTable('meeting').set({ is_cancelled: true }).where('meeting_key', '=', LV).execute();
    at = d('2026-11-18T03:00:00Z');
    await p.run();
    expect(seen).toHaveLength(1);
    expect(await row(LV)).toMatchObject({ state: 'final', next_fetch_at: null, fetch_count: 1, attempt_count: 1 });
    expect(await hours(LV)).toHaveLength(55); // the last forecast stays
    expect(logged('forecast').at(-1)).toMatchObject({ meeting_key: LV, state: 'final', hours: 0, last_error: null });

    // A daemon down past the close: the due forecast becomes final with no request.
    await admin.deleteFrom('meeting').execute();
    await vegas();
    await finalGrids();
    await admin
      .insertInto('forecast')
      .values({
        meeting_key: LV,
        source: 'open-meteo',
        map_id: 'us-2023',
        lat: 36.1167,
        lon: -115.1666,
        state: 'live',
        next_fetch_at: '2026-11-18T00:00:00Z',
        updated_at: '2026-11-18T00:00:00Z',
      })
      .execute();
    at = d('2026-11-22T06:00:00Z');
    await daemon().run();
    expect(seen).toHaveLength(1);
    expect(await row(LV)).toMatchObject({ state: 'final', next_fetch_at: null, attempt_count: 0 });
  });

  it('a restart seeds the forecast share from the attempts of the forecasts touched in the last day and hour, once', async () => {
    at = d('2026-11-18T12:00:00Z');
    const rows: [number, number, number][] = [
      // [meeting_key, attempt_count, minutes before at]
      [LV, 4, 30],
      [1301, 2, 5 * 60],
      [1299, 5, 25 * 60],
    ];
    for (const [meeting_key, attempt_count, ago] of rows) {
      await meeting(meeting_key, 'Las Vegas');
      await admin
        .insertInto('forecast')
        .values({
          meeting_key,
          source: 'open-meteo',
          map_id: 'us-2023',
          lat: 36.1167,
          lon: -115.1666,
          state: 'final',
          attempt_count,
          updated_at: new Date(at.getTime() - ago * 60_000),
        })
        .execute();
    }
    const p = daemon();
    await p.run();
    expect(p.budget.used()).toEqual({ hour: 4, day: 6, forecast: 6 });
    await p.run();
    expect(p.budget.used()).toEqual({ hour: 4, day: 6, forecast: 6 });
    expect(seen).toEqual([]);
  });
});
