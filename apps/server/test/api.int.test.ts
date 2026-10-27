import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Laps, Pits, RaceControl, Season, Seasons, SessionDetail, Status, Stints } from '@f1/contracts';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { HttpResponse, http, passthrough } from 'msw';
import pino from 'pino';
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
  ['/api/v1/status', 'Status', Status],
] as const;

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
    apiDb = createDb(testDb.urls.f1_api);
    app = createApp({ db: apiDb, access: access({ team: TEAM, aud: AUD }, log), log });
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
      const broken = createApp({ db: down, access: access({ team: TEAM, aud: AUD }, log), log });
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

  it('Cache-Control: private, max-age=86400 for a final session, no-store otherwise and on every error', async () => {
    const cacheOf = async (path: string, method = 'GET') => (await get(path, method)).headers.get('cache-control');
    for (const tail of ['', '/laps', '/stints', '/pits', '/race-control']) {
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
      ['/api/v1/seasons/26', 400, 'bad request'],
      ['/api/v1/seasons/20266', 400, 'bad request'],
      ['/api/v1/sessions/999999', 404, 'not found'],
      ['/api/v1/sessions/999999/laps', 404, 'not found'],
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
    });
  });

  it('the api role on @hono/node-server: a taken port exits 1; it listens, answers and exits 0 on SIGTERM', async () => {
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, DATABASE_URL: testDb.urls.f1_api };
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
    expect(process.listenerCount('SIGTERM')).toBe(signals + 1);
    process.emit('SIGTERM', 'SIGTERM'); // the listener only: no real signal reaches the worker
    expect(await exit).toBe(0);
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual([signals, interrupts]);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it('logs no token, header or password', () => {
    const text = lines.join('');
    expect(text).not.toMatch(/eyJ|cf-access|cloudflareaccess/i);
    expect(text).not.toContain(new URL(testDb.urls.f1_api).password);
  });
});
