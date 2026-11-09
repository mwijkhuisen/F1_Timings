import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { type Deps, tick } from '../src/ingest/ingest.ts';
import { run } from '../src/main.ts';
import { type Clock, createClient, OPENF1 } from '../src/openf1/client.ts';
import { createTestDb, type TestDb } from './db.ts';

// P5a's migration (20261109000001_weather.sql) on a database that already holds sessions: the re-queue sends only
// the final, not cancelled ones back to `fetched` at date_end + 35 min (no SQL now()), the next tick fetches them
// with weather, and the down migration brings the old raw_response CHECK back with weather raw rows present.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const RACE = 11388; // served the *-normal fixtures; every other key gets *-empty

const fixture = (name: string): Response => {
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), 'utf8')) as { status: number };
  if (meta.status === 404) return HttpResponse.json({ detail: 'No results found.' }, { status: 404 });
  return new HttpResponse(readFileSync(join(FIXTURES, `${name}.raw`), 'utf8'), {
    headers: { 'content-type': 'application/json' },
  });
};
const requested: number[] = [];
const openf1 = () =>
  server.use(
    http.get(`${OPENF1}/:endpoint`, ({ params, request }) => {
      const key = Number(new URL(request.url).searchParams.get('session_key'));
      requested.push(key);
      return fixture(`${String(params.endpoint)}-${key === RACE ? 'normal' : 'empty'}`);
    }),
  );

let virtual = 0;
const clock: Clock = {
  now: () => virtual,
  sleep: async (ms) => {
    virtual += ms;
  },
};

// [key, state, cancelled, next_fetch_at, fail_count, last_error]: every state the re-queue must leave alone, and
// one it must take. The dates are October 2026, so no live window is open at the tick's clock (A§6.1).
const SESSIONS = [
  [RACE, 'final', false, null, 0, null],
  [900_001, 'final', true, null, 0, null], // a cancelled final row: never re-queued
  [900_002, 'scheduled', false, '2026-12-01T00:00:00Z', 0, null],
  [900_003, 'failed', false, null, 9, 'http_500'],
  [900_004, 'fetched', false, '2026-12-02T00:00:00Z', 0, null],
  [900_005, 'due', false, '2026-12-03T00:00:00Z', 1, 'timeout'],
  [900_006, 'scheduled', true, null, 0, null],
] as const;
const DATE_START = '2026-10-11T12:00:00Z';
const DATE_END = '2026-10-11T14:00:00Z';

let testDb: TestDb;
let admin: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
const snapshot = async () =>
  Object.fromEntries(
    (
      await sql<{ session_key: number; row: Record<string, unknown> }>`
        SELECT session_key, to_jsonb(s) AS row FROM session s ORDER BY session_key`.execute(admin)
    ).rows.map((r) => [r.session_key, r.row]),
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('the weather migration (20261109000001)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
    expect(await run(['migrate'], env, () => {})).toBe(0);
    expect(await dbmate('rollback')).toMatch(/Rolled back: 20261109000001_weather\.sql/);
    admin = createDb(testDb.urls.admin);
    await admin.insertInto('meeting').values({ meeting_key: 1296, source: 'openf1', year: 2026 }).execute();
    for (const [key, state, cancelled, next, fails, error] of SESSIONS)
      await admin
        .insertInto('session')
        .values({
          session_key: key,
          source: 'openf1',
          meeting_key: 1296,
          type: 'Race',
          name: 'Race',
          date_start: DATE_START,
          date_end: DATE_END,
          is_cancelled: cancelled,
          ingest_state: state,
          next_fetch_at: next,
          fetch_count: state === 'final' ? 1 : 0,
          fail_count: fails,
          last_error: error,
        })
        .execute();
  });
  afterAll(async () => {
    await admin?.destroy();
    await testDb?.drop();
  });

  it('re-queues only the final, not cancelled sessions, at date_end + 35 min; every other row is unchanged', async () => {
    const before = await snapshot();
    expect(await run(['migrate'], env, () => {})).toBe(0);
    const after = await snapshot();
    expect(after[RACE]).toEqual({
      ...before[RACE],
      ingest_state: 'fetched',
      next_fetch_at: '2026-10-11T14:35:00+00:00',
    });
    for (const [key] of SESSIONS.slice(1)) expect(after[key], String(key)).toEqual(before[key]);
  });

  it('the next tick fetches the re-queued session with its weather and makes it final again', async () => {
    openf1();
    const db = createDb(testDb.urls.f1_ingest);
    try {
      const deps: Deps = {
        db,
        client: createClient({ clock }),
        now: () => new Date('2026-11-09T12:00:00Z'),
        log: pino({ level: 'silent' }),
        beat: () => {},
      };
      expect(await tick(deps)).toBe(1);
    } finally {
      await db.destroy();
    }
    expect(new Set(requested)).toEqual(new Set([RACE])); // seven requests, one session
    expect(requested).toHaveLength(7);
    expect(
      await admin
        .selectFrom('session')
        .select(['ingest_state', 'next_fetch_at', 'fetch_count', 'fail_count'])
        .where('session_key', '=', RACE)
        .executeTakeFirst(),
    ).toEqual({ ingest_state: 'final', next_fetch_at: null, fetch_count: 2, fail_count: 0 });
    const counts = await sql<{ weather: number; raw: number }>`
      SELECT (SELECT count(*)::int FROM weather WHERE session_key = ${RACE}) AS weather,
             (SELECT count(*)::int FROM raw_response WHERE session_key = ${RACE}) AS raw`.execute(admin);
    expect(counts.rows[0]).toEqual({ weather: 160, raw: 7 });
  });

  it('rolls back with weather raw rows present, and the old CHECK refuses weather again', async () => {
    expect(await dbmate('rollback')).toMatch(/Rolled back: 20261109000001_weather\.sql/);
    const endpoints = await admin
      .selectFrom('raw_response')
      .select('endpoint')
      .where('session_key', '=', RACE)
      .execute();
    expect(endpoints.map((r) => r.endpoint).sort()).toEqual([
      'drivers',
      'laps',
      'pit',
      'race_control',
      'session_result',
      'stints',
    ]);
    expect(
      await code(sql`INSERT INTO raw_response VALUES (${RACE}, 'openf1', 'weather', now(), 200, '[]')`.execute(admin)),
    ).toBe('23514');
    expect(await code(sql`SELECT 1 FROM weather`.execute(admin))).toBe('42P01');
    // The down migration does not undo the re-queue: the session stays where the tick left it.
    expect(
      await admin.selectFrom('session').select('ingest_state').where('session_key', '=', RACE).executeTakeFirst(),
    ).toEqual({ ingest_state: 'final' });
    expect(await run(['migrate'], env, () => {})).toBe(0);
  });
});
