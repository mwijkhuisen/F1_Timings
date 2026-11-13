import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Laps, Pits, RaceControl, Rain, Season, Seasons, SessionDetail, Status, Stints, Weather } from '@f1/contracts';
import type { Hono } from 'hono';
import { type Kysely, sql } from 'kysely';
import { HttpResponse, http, passthrough } from 'msw';
import pino from 'pino';
import { Agent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { server } from '../../../test/msw.setup.ts';
import { access } from '../src/api/access.ts';
import { createApp } from '../src/api/app.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { processSession, syncSchedule } from '../src/ingest/ingest.ts';
import { run } from '../src/main.ts';
import { type Clock, createClient, OPENF1 } from '../src/openf1/client.ts';
import { createTestDb, type TestDb } from './db.ts';
import { AUD, jwt, rsaKey, serveCerts, TEAM } from './jwt.ts';

// The api against a real PostgreSQL 18, logged in as f1_api (read-only), behind the real Access
// middleware with test keys. Seeded by the ingest pipeline from the P1a/P1c fixtures (msw).

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const read = (name: string): unknown[] => JSON.parse(readFileSync(join(FIXTURES, `${name}.raw`), 'utf8'));
const CASES: Record<number, string> = { 11388: 'normal', 11392: 'quali', 11383: 'sprint' };
const RACE = 11388; // left non-final
const QUALI = 11392; // final
const SPRINT = 11383; // final
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const FAILING = 11397; // Mexico City practice 1, set retrying by hand
// The race's fastest lap (car 16, lap 60, 1:36.628) is deleted by one synthetic message.
const SYNTHETIC = {
  session_key: RACE,
  date: '2026-10-11T13:43:00+00:00',
  category: 'Other',
  flag: null,
  scope: null,
  sector: null,
  driver_number: null,
  lap_number: 60,
  qualifying_phase: null,
  message: 'CAR 16 (LEC) LAP DELETED - SYNTHETIC TEST REASON LAP 60 13:42:33',
};

const openf1 = () =>
  server.use(
    http.get(`${OPENF1}/:endpoint`, ({ params, request }) => {
      const query = new URL(request.url).searchParams;
      const endpoint = String(params.endpoint);
      if (query.has('year')) return HttpResponse.json(read(`${endpoint}-year`));
      const key = Number(query.get('session_key'));
      const rows = read(`${endpoint}-${CASES[key]}`);
      // The quali session also gets the cars whose laps race_control-quali deletes.
      if (endpoint === 'laps' && key === QUALI) rows.push(...read('laps-deleted'));
      if (endpoint === 'race_control' && key === RACE) rows.push(SYNTHETIC);
      return HttpResponse.json(rows);
    }),
  );

// The client's rate limiter sleeps on this clock: virtual, so seeding takes no real time.
let virtual = 0;
const clock: Clock = {
  now: () => virtual,
  sleep: async (ms) => {
    virtual += ms;
  },
};
const lines: string[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });

let testDb: TestDb;
let admin: Kysely<DB>;
let apiDb: Kysely<DB>;
let app: Hono;
let token: string;
let key: Awaited<ReturnType<typeof rsaKey>>;

const ROUTES = [
  ['/api/v1/seasons', 'Seasons', Seasons],
  ['/api/v1/seasons/2026', 'Season', Season],
  [`/api/v1/sessions/${QUALI}`, 'SessionDetail', SessionDetail],
  [`/api/v1/sessions/${QUALI}/laps`, 'Laps', Laps],
  [`/api/v1/sessions/${QUALI}/stints`, 'Stints', Stints],
  [`/api/v1/sessions/${QUALI}/pits`, 'Pits', Pits],
  [`/api/v1/sessions/${QUALI}/race-control`, 'RaceControl', RaceControl],
  [`/api/v1/sessions/${QUALI}/weather`, 'Weather', Weather],
  [`/api/v1/sessions/${QUALI}/rain`, 'Rain', Rain],
  ['/api/v1/status', 'Status', Status],
] as const;

// 49 grid points (7 x 7), element 3 null. The generated type says number[] for real[], which cannot show a null.
const mm = (base: number) =>
  Array.from({ length: 49 }, (_, i) => (i === 3 ? null : base + i / 100)) as unknown as number[];
const FRAME_1 = '2026-10-10T10:00:00.000Z';
const FRAME_2 = '2026-10-10T10:15:00.000Z';

const get = (path: string, method = 'GET') =>
  app.request(path, { method, headers: { 'cf-access-jwt-assertion': token } });
const body = async <T extends z.ZodType>(path: string, contract: T): Promise<z.infer<T>> => {
  const res = await get(path);
  expect(res.status, path).toBe(200);
  return contract.parse(await res.json());
};

describe('api (f1_api login, Access JWT)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    const ingestDb = createDb(testDb.urls.f1_ingest);
    try {
      openf1();
      const deps = {
        db: ingestDb,
        client: createClient({ clock }),
        now: () => new Date('2026-10-26T00:00:00Z'),
        log: pino({ level: 'silent' }),
        beat: () => {},
      };
      expect(await syncSchedule(deps, [2026])).toBe(true);
      for (const session of [RACE, QUALI, SPRINT])
        expect(await processSession(deps, session)).toEqual({ ok: true, value: 'final' });
    } finally {
      await ingestDb.destroy();
    }
    admin = createDb(testDb.urls.admin);
    await admin.updateTable('session').set({ ingest_state: 'fetched' }).where('session_key', '=', RACE).execute();
    await admin
      .updateTable('session')
      .set({
        ingest_state: 'due',
        fail_count: 2,
        last_error: 'timeout',
        next_fetch_at: new Date('2026-10-30T20:25:00Z'),
      })
      .where('session_key', '=', FAILING)
      .execute();
    // A grid per session: final for the final quali and the non-final race, live for the final sprint; none for FAILING.
    for (const [session, state] of [
      [QUALI, 'final'],
      [RACE, 'final'],
      [SPRINT, 'live'],
    ] as const)
      await admin
        .insertInto('rain_grid')
        .values({
          session_key: session,
          source: 'open-meteo',
          map_id: 'test-circuit',
          centre_lat: 25.49,
          centre_lon: -80.12,
          size: 7,
          step_m: 1000,
          state,
          updated_at: new Date('2026-10-26T00:00:00Z'),
        })
        .execute();
    // QUALI's frames go in out of date order.
    await admin
      .insertInto('rain_frame')
      .values([
        { session_key: QUALI, date: FRAME_2, mm: mm(1) },
        { session_key: QUALI, date: FRAME_1, mm: mm(0) },
        { session_key: RACE, date: FRAME_1, mm: mm(0) },
        { session_key: SPRINT, date: FRAME_1, mm: mm(0) },
      ])
      .execute();
    apiDb = createDb(testDb.urls.f1_api);
    app = createApp({
      db: apiDb,
      access: access({ team: TEAM, aud: AUD }, log),
      log,
      liveDir: '/nonexistent',
      revision: SHA,
    });
    key = await rsaKey('test-kid');
    token = await jwt(key.priv);
  });
  beforeEach(() => {
    serveCerts([key.pub]);
  });
  afterAll(async () => {
    await apiDb?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it.each(ROUTES)('%s parses against %s', async (path, _, contract) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    contract.parse(await res.json()); // strict: an extra or a missing field throws
  });

  it('every route without a JWT, by GET, HEAD or OPTIONS, and odd spellings of /api: 401 or 404, never data', async () => {
    const odd = [
      '//api/v1/seasons',
      '/API/v1/seasons',
      '/Api/v1/status',
      '/api/v1/seasons/',
      '/api/v1%2Fseasons',
      '/api/v1/../v1/seasons',
      '/api/%2e%2e/api/v1/seasons',
      '/api/v1/unknown',
      '/api',
      '/api/',
      '/v1/seasons',
    ];
    for (const path of [...ROUTES.map(([p]) => p), ...odd]) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE']) {
        const res = await app.request(path, { method });
        expect([401, 404], `${method} ${path}`).toContain(res.status);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const text = await res.text();
        if (method !== 'HEAD') expect(text).toMatch(/^\{"error":"(unauthorized|not found)"\}$/);
      }
    }
    for (const [path] of ROUTES) expect((await app.request(path)).status).toBe(401);
  });

  it('/healthz needs no JWT and answers exactly {"ok":true}, or 503 without the database', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"ok":true}');
    expect((await app.request('/healthz', { method: 'HEAD' })).status).toBe(200);
    const down = createDb('postgres://f1_api@127.0.0.1:1/f1?sslmode=disable');
    try {
      const broken = createApp({
        db: down,
        access: access({ team: TEAM, aud: AUD }, log),
        log,
        liveDir: '/nonexistent',
      });
      const dead = await broken.request('/healthz');
      expect(dead.status).toBe(503);
      expect(await dead.text()).toBe('{"ok":false}');
      // Any other failure is a fixed 500, logged as a code.
      lines.length = 0;
      const failed = await broken.request('/api/v1/seasons', { headers: { 'cf-access-jwt-assertion': token } });
      expect(failed.status).toBe(500);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      expect(await failed.text()).toBe('{"error":"internal"}');
      expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ cause: 'ECONNREFUSED', msg: 'api' })]);
    } finally {
      await down.destroy();
    }
  });

  const TAILS = ['', '/laps', '/stints', '/pits', '/race-control', '/weather', '/rain'];

  it('?v=<the api revision> changes nothing: status, body, cache-control and f1-revision', async () => {
    for (const session of [QUALI, RACE])
      for (const tail of TAILS) {
        const path = `/api/v1/sessions/${session}${tail}`;
        const [plain, versioned] = [await get(path), await get(`${path}?v=${SHA}`)];
        expect(versioned.status, path).toBe(plain.status);
        expect(await versioned.text(), path).toBe(await plain.text());
        expect(versioned.headers.get('cache-control'), path).toBe(plain.headers.get('cache-control'));
        expect(versioned.headers.get('f1-revision'), path).toBe(SHA);
        expect(plain.headers.get('f1-revision'), path).toBe(SHA);
      }
  });

  it('?v=<another revision> gets the same body but no-store, so it is never cached under the new key', async () => {
    for (const tail of TAILS) {
      const path = `/api/v1/sessions/${QUALI}${tail}`;
      const plain = await (await get(path)).text();
      for (const v of [SHA2, 'dev']) {
        const res = await get(`${path}?v=${v}`);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toBe(plain);
        expect(res.headers.get('cache-control'), path).toBe('no-store');
        expect(res.headers.get('f1-revision'), path).toBe(SHA);
      }
    }
  });

  it('a malformed or repeated v is the fixed 400, never echoed', async () => {
    const bad = [
      'v=',
      'v',
      'v=abc',
      `v=${'a'.repeat(41)}`,
      `v=${'A'.repeat(40)}`,
      'v=DEV',
      `v=${SHA}&v=${SHA}`,
      'v=%3Cscript%3E',
      `v=${'a'.repeat(5000)}`,
    ];
    for (const q of bad)
      for (const tail of ['', '/laps', '/rain']) {
        const res = await get(`/api/v1/sessions/${QUALI}${tail}?${q}`);
        expect(res.status, q).toBe(400);
        expect(res.headers.get('cache-control'), q).toBe('no-store');
        expect(await res.text(), q).toBe('{"error":"bad request"}');
      }
  });

  it('Cache-Control: private, max-age=86400 for a final session, no-store otherwise and on every error', async () => {
    const cacheOf = async (path: string, method = 'GET') => (await get(path, method)).headers.get('cache-control');
    for (const tail of ['', '/laps', '/stints', '/pits', '/race-control', '/weather', '/rain']) {
      expect(await cacheOf(`/api/v1/sessions/${QUALI}${tail}`)).toBe('private, max-age=86400');
      expect(await cacheOf(`/api/v1/sessions/${QUALI}${tail}`, 'HEAD')).toBe('private, max-age=86400');
      expect(await cacheOf(`/api/v1/sessions/${RACE}${tail}`)).toBe('no-store');
    }
    for (const path of ['/api/v1/seasons', '/api/v1/seasons/2026', '/api/v1/status'])
      expect(await cacheOf(path)).toBe('no-store');
    const errors = [
      ['/api/v1/sessions/abc', 400, 'bad request'],
      ['/api/v1/sessions/1234567890', 400, 'bad request'],
      ['/api/v1/sessions/-1/laps', 400, 'bad request'],
      ['/api/v1/sessions/11388x/pits', 400, 'bad request'],
      ['/api/v1/sessions/-1/weather', 400, 'bad request'],
      ['/api/v1/sessions/1234567890/weather', 400, 'bad request'],
      ['/api/v1/seasons/26', 400, 'bad request'],
      ['/api/v1/seasons/20266', 400, 'bad request'],
      ['/api/v1/sessions/999999', 404, 'not found'],
      ['/api/v1/sessions/999999/laps', 404, 'not found'],
      ['/api/v1/sessions/999999/weather', 404, 'not found'],
      ['/api/v1/sessions/-1/rain', 400, 'bad request'],
      ['/api/v1/sessions/1234567890/rain', 400, 'bad request'],
      ['/api/v1/sessions/999999/rain', 404, 'not found'],
      ['/api/v1/seasons/2025', 404, 'not found'],
      ['/api/v1/nothing', 404, 'not found'],
    ] as const;
    for (const [path, status, error] of errors) {
      const res = await get(path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe(JSON.stringify({ error }));
    }
  });

  it('laps: the deleted lap keeps its values and reason, is never purple or green, and changes no best', async () => {
    const laps = await body(`/api/v1/sessions/${RACE}/laps`, Laps);
    expect(laps).toHaveLength(62);
    const deleted = laps.filter((l) => l.deleted);
    expect(deleted).toEqual([
      expect.objectContaining({
        driver_number: 16,
        lap_number: 60,
        lap_ms: 96_628,
        deleted_reason: 'SYNTHETIC TEST REASON',
        colour: { lap: 'yellow', s1: 'yellow', s2: 'yellow', s3: 'yellow' },
      }),
      // The fixture's own `CAR 23 (ALB) LAP DELETED - TRACK LIMITS AT TURN 2 LAP 37 21:04:50 (PIT)`.
      expect.objectContaining({ driver_number: 23, lap_number: 37, deleted_reason: 'TRACK LIMITS AT TURN 2' }),
    ]);
    // The next fastest lap holds purple.
    expect(laps.filter((l) => l.colour.lap === 'purple')).toEqual([
      expect.objectContaining({ driver_number: 1, lap_number: 38, lap_ms: 96_634 }),
    ]);
    for (const field of ['lap', 's1', 's2', 's3'] as const)
      expect(laps.filter((l) => l.colour[field] === 'purple')).toHaveLength(1);
    for (const l of laps.filter((x) => x.is_pit_out || x.is_pit_in))
      expect(Object.values(l.colour).filter((c) => c === 'purple' || c === 'green')).toEqual([]);
    expect(laps.filter((l) => l.compound !== null).length).toBeGreaterThan(0);
    const order = laps.map((l) => l.driver_number * 1000 + l.lap_number); // by (driver, lap)
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('laps of a qualifying session: real deletions and Q phases from the ingest', async () => {
    const laps = await body(`/api/v1/sessions/${QUALI}/laps`, Laps);
    expect(laps.filter((l) => l.deleted).map((l) => [l.driver_number, l.lap_number, l.deleted_reason])).toEqual([
      [1, 14, 'TRACK LIMITS AT TURN 19'],
      [3, 11, 'TRACK LIMITS AT TURN 19'],
      [6, 11, 'TRACK LIMITS AT TURN 19'],
      [10, 2, 'TRACK LIMITS AT TURN 9'],
      [55, 8, 'TRACK LIMITS AT TURN 19'],
      [87, 14, 'TRACK LIMITS AT TURN 11'],
    ]);
    expect(new Set(laps.map((l) => l.quali_phase))).toEqual(new Set([1, 2, 3, null]));
  });

  it('weather: every sample in date order with the A§7 column names; the sprint was wet for 20 of them', async () => {
    const rows = await body(`/api/v1/sessions/${SPRINT}/weather`, Weather);
    expect(rows).toHaveLength(127);
    const dates = rows.map((r) => Date.parse(r.date));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    expect(rows.filter((r) => r.rainfall === 1)).toHaveLength(20);
    const [first] = read('weather-sprint') as Record<string, unknown>[];
    const { session_key: _, meeting_key: __, date, ...values } = first ?? {};
    expect(rows[0]).toEqual({ date: new Date(String(date)).toISOString(), ...values });
    expect(await body(`/api/v1/sessions/${RACE}/weather`, Weather)).toHaveLength(160);
  });

  it('rain: the grid, and its frames in date order with numbers and null kept', async () => {
    const rain = await body(`/api/v1/sessions/${QUALI}/rain`, Rain);
    expect(rain.grid).toEqual({
      map_id: 'test-circuit',
      centre_lat: 25.49,
      centre_lon: -80.12,
      size: 7,
      step_m: 1000,
      state: 'final',
    });
    expect(rain.frames.map((f) => f.date)).toEqual([FRAME_1, FRAME_2]);
    for (const f of rain.frames) {
      expect(f.mm).toHaveLength(49);
      expect(f.mm[3]).toBeNull();
      expect(typeof f.mm[4]).toBe('number');
    }
    expect(rain.frames[1]?.mm[0]).toBeCloseTo(1, 5); // a real column: float4 rounding only
  });

  it('rain: a session without a grid answers a null grid and no frames, no-store', async () => {
    const res = await get(`/api/v1/sessions/${FAILING}/rain`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ grid: null, frames: [] });
  });

  it('rain: private for 24 h only when the session and the grid are both final', async () => {
    const cacheOf = async (session: number, method = 'GET') =>
      (await get(`/api/v1/sessions/${session}/rain`, method)).headers.get('cache-control');
    for (const method of ['GET', 'HEAD']) {
      expect(await cacheOf(QUALI, method)).toBe('private, max-age=86400'); // both final
      expect(await cacheOf(SPRINT, method)).toBe('no-store'); // final session, live grid
      expect(await cacheOf(RACE, method)).toBe('no-store'); // final grid, session not final
    }
  });

  it('seasons, a season, a session and the status', async () => {
    expect(await body('/api/v1/seasons', Seasons)).toEqual([{ year: 2026, meetings: 25, sessions: 121 }]);
    const season = await body('/api/v1/seasons/2026', Season);
    expect(season).toHaveLength(27);
    expect(season.filter((m) => m.is_cancelled)).toHaveLength(2);
    expect(season.flatMap((m) => m.sessions)).toHaveLength(131);
    const dates = season.map((m) => m.date_start ?? '');
    expect(dates).toEqual(dates.toSorted());
    const meeting = season.find((m) => m.sessions.some((s) => s.session_key === QUALI));
    expect(meeting?.sessions.find((s) => s.session_key === QUALI)).toMatchObject({
      type: 'Qualifying',
      ingest_state: 'final',
    });

    const detail = await body(`/api/v1/sessions/${QUALI}`, SessionDetail);
    expect(detail.session).toMatchObject({ session_key: QUALI, ingest_state: 'final', is_cancelled: false });
    expect(detail.meeting).toMatchObject({ meeting_key: 1297, year: 2026 });
    expect(detail.drivers.map((d) => d.driver_number)).toEqual(
      detail.drivers.map((d) => d.driver_number).toSorted((a, b) => a - b),
    );
    expect(detail.results).toHaveLength(22);
    expect(detail.results[0]).toMatchObject({ position: 1 });

    expect(await body('/api/v1/status', Status)).toEqual({
      revision: SHA,
      states: { scheduled: 117, due: 1, fetched: 1, final: 2, failed: 0 },
      cancelled: 10,
      failed: [
        {
          session_key: FAILING,
          year: 2026,
          meeting_name: expect.any(String),
          session_name: 'Practice 1',
          fail_count: 2,
          last_error: 'timeout',
          next_fetch_at: '2026-10-30T20:25:00.000Z',
        },
      ],
      recorder: null,
      ingest: null,
      rain: { states: { live: 1, final: 2, failed: 0 }, failed: [] },
      // The sprint is a Race-type session: its real FORMATION LAP(S) BEHIND SAFETY CAR and SAFETY CAR LIGHTS OFF are ignored (D4).
      rc_unmatched: [],
    });
  });

  it('the status carries the ingest row (stale after 5 minutes), the rain counts and failed grids, and the races with unmatched wording', async () => {
    const status = async () => body('/api/v1/status', Status);
    const rc = (session_key: number, message: string, flag: string | null = null) => ({
      session_key,
      source: 'openf1',
      date: new Date('2026-10-11T13:00:00Z'),
      category: 'Other',
      flag,
      message,
    });
    try {
      await admin
        .insertInto('ingest_status')
        .values({ last_sync_at: new Date('2026-10-26T03:00:00Z'), live_wait: false, last_tick_at: new Date() })
        .execute();
      expect((await status()).ingest).toEqual({
        last_sync_at: '2026-10-26T03:00:00.000Z',
        live_wait: false,
        last_tick_at: expect.any(String),
        stale: false,
      });
      await admin
        .updateTable('ingest_status')
        .set({ last_tick_at: new Date(Date.now() - 6 * 60_000), live_wait: true })
        .execute();
      expect((await status()).ingest).toMatchObject({ live_wait: true, stale: true });

      // The failed grid is FAILING's: the other three states are the seeded grids.
      await admin
        .insertInto('rain_grid')
        .values({
          session_key: FAILING,
          source: 'open-meteo',
          map_id: 'test-circuit',
          centre_lat: 25.49,
          centre_lon: -80.12,
          size: 7,
          step_m: 1000,
          state: 'failed',
          fail_count: 3,
          last_error: 'http_429',
          next_fetch_at: new Date('2026-10-30T20:25:00Z'),
          updated_at: new Date('2026-10-26T00:00:00Z'),
        })
        .execute();
      // RACE is a Race, FAILING a practice. Only the race's period-like row with no form and no note is listed.
      await admin
        .insertInto('race_control')
        .values([
          rc(RACE, 'SAFETY CAR IN'),
          rc(RACE, 'STEWARDS: UNDER SAFETY CAR INCIDENT NOTED'),
          rc(RACE, 'SAFETY CAR DEPLOYED'),
          rc(RACE, 'RED FLAG - SESSION SUSPENDED'),
          rc(FAILING, 'SAFETY CAR IN'),
        ])
        .execute();
      const got = await status();
      expect(got.rain).toEqual({
        states: { live: 1, final: 2, failed: 1 },
        failed: [
          {
            session_key: FAILING,
            year: 2026,
            meeting_name: expect.any(String),
            session_name: 'Practice 1',
            fail_count: 3,
            last_error: 'http_429',
            next_fetch_at: '2026-10-30T20:25:00.000Z',
          },
        ],
      });
      // Our one row of the race; the sprint's real rows are ignored procedure (D4).
      expect(got.rc_unmatched).toEqual([
        { session_key: RACE, year: 2026, meeting_name: expect.any(String), session_name: 'Race', rows: 1 },
      ]);
    } finally {
      await admin.deleteFrom('ingest_status').execute();
      await admin.deleteFrom('rain_grid').where('session_key', '=', FAILING).execute();
      await admin
        .deleteFrom('race_control')
        .where('source', '=', 'openf1')
        .where('date', '=', new Date('2026-10-11T13:00:00Z'))
        .execute();
    }
  });

  it('the api role reads ingest_status and cannot write it; f1_ingest cannot delete it', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    const ingestDb = createDb(testDb.urls.f1_ingest);
    try {
      expect(await code(sql`SELECT * FROM ingest_status`.execute(apiDb))).toBe('ok');
      for (const stmt of [
        sql`INSERT INTO ingest_status (live_wait, last_tick_at) VALUES (false, now())`,
        sql`UPDATE ingest_status SET live_wait = true`,
        sql`DELETE FROM ingest_status`,
      ])
        expect(await code(stmt.execute(apiDb))).toBe('42501');
      expect(await code(sql`DELETE FROM ingest_status`.execute(ingestDb))).toBe('42501');
    } finally {
      await ingestDb.destroy();
    }
  });

  it('the status carries the recorder row: names, and stale after 5 minutes', async () => {
    const row = {
      state: 'recording',
      session_key: FAILING,
      token_expires_at: new Date('2026-11-02T00:00:00Z'),
      last_error: 'disk_low',
      warning: 'disk_low',
    };
    const recorder = async () => (await body('/api/v1/status', Status)).recorder;
    try {
      await admin
        .insertInto('recorder_status')
        .values({ ...row, updated_at: new Date(Date.now() - 10_000) })
        .execute();
      expect(await recorder()).toEqual({
        state: 'recording',
        session_key: FAILING,
        meeting_name: expect.any(String),
        session_name: 'Practice 1',
        token_expires_at: '2026-11-02T00:00:00.000Z',
        last_error: 'disk_low',
        warning: 'disk_low',
        stale: false,
        updated_at: expect.any(String),
      });
      await admin
        .updateTable('recorder_status')
        .set({ updated_at: new Date(Date.now() - 6 * 60_000) })
        .execute();
      expect(await recorder()).toMatchObject({ stale: true });
      await admin.updateTable('recorder_status').set({ state: 'idle', session_key: null }).execute();
      expect(await recorder()).toMatchObject({ meeting_name: null, session_name: null });
    } finally {
      await admin.deleteFrom('recorder_status').execute();
    }
  });

  it('the api role on @hono/node-server: a taken port exits 1; it listens, answers and exits 0 on SIGTERM', async () => {
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, DATABASE_URL: testDb.urls.f1_api, F1_REVISION: SHA2 };
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, '0.0.0.0', () => resolve((blocker.address() as { port: number }).port)),
    );
    expect(await run(['api'], env, () => {}, port)).toBe(1); // EADDRINUSE
    await new Promise((resolve) => blocker.close(resolve));

    const base = `http://127.0.0.1:${port}`;
    server.use(http.all(`${base}/*`, () => passthrough())); // the real server, not msw
    const signals = process.listenerCount('SIGTERM');
    const interrupts = process.listenerCount('SIGINT');
    // A connection pooled by an earlier test's msw-answered certs fetch makes the role's own fetch resolve the real
    // host (a lookup, then 503): start from a fresh pool.
    setGlobalDispatcher(new Agent());
    const exit = run(['api'], env, () => {}, port);
    let health: Response | undefined;
    for (let i = 0; i < 100 && !health; i++)
      health = await fetch(`${base}/healthz`).catch(
        () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 50)),
      );
    expect(health?.status).toBe(200);
    expect(await health?.text()).toBe('{"ok":true}');
    const seasons = await fetch(`${base}/api/v1/seasons`);
    expect(seasons.status).toBe(401);
    expect(await seasons.text()).toBe('{"error":"unauthorized"}');
    expect(seasons.headers.get('f1-revision')).toBeNull(); // a 401 carries no header
    const status = await fetch(`${base}/api/v1/status`, { headers: { 'cf-access-jwt-assertion': token } });
    expect(status.status).toBe(200);
    expect(status.headers.get('f1-revision')).toBe(SHA2); // the role reads F1_REVISION
    expect(((await status.json()) as { revision: string }).revision).toBe(SHA2);
    expect(process.listenerCount('SIGTERM')).toBe(signals + 1);
    process.emit('SIGTERM', 'SIGTERM'); // the listener only: no real signal reaches the worker
    expect(await exit).toBe(0);
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual([signals, interrupts]);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it('a malformed F1_REVISION exits 78 before listening and logs only the name', async () => {
    const out: string[] = [];
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, DATABASE_URL: testDb.urls.f1_api, F1_REVISION: 'bad-rev' };
    expect(await run(['api'], env, (l) => out.push(l))).toBe(78);
    expect(out).toEqual(['api: F1_REVISION is malformed']);
  });

  it('logs no token, header or password', () => {
    const text = lines.join('');
    expect(text).not.toMatch(/%3Cscript|bad-rev|a{41}/);
    expect(text).not.toMatch(/eyJ|cf-access|cloudflareaccess/i);
    expect(text).not.toContain(new URL(testDb.urls.f1_api).password);
  });
});
