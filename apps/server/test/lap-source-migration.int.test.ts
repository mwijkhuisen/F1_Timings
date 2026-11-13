import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// P3b's migration (20261112000001_lap_source.sql) on a database that already holds laps: every row becomes the
// candidate of its own source, `lap.filled` starts as {}, and the down migration takes both away again.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

let testDb: TestDb;
let admin: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const candidates = async () =>
  (
    await sql`SELECT session_key, driver_number, lap_number, source, date_start, lap_ms, s1_ms, i1_kph, is_pit_out, seg1, quali_phase
      FROM lap_source ORDER BY driver_number`.execute(admin)
  ).rows;

beforeAll(async () => {
  testDb = await createTestDb();
  env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await dbmate('rollback')).toMatch(/Rolled back: 20261113000001_jolpica\.sql/); // the newer migration first
  expect(await dbmate('rollback')).toMatch(/Rolled back: 20261112000001_lap_source\.sql/);
  admin = createDb(testDb.urls.admin);
  await admin.insertInto('meeting').values({ meeting_key: 1, source: 'openf1', year: 2026 }).execute();
  await admin
    .insertInto('session')
    .values({
      session_key: 10,
      source: 'openf1',
      meeting_key: 1,
      date_start: '2026-10-11T12:00:00Z',
      date_end: '2026-10-11T14:00:00Z',
    })
    .execute();
  await sql`INSERT INTO lap (session_key, source, driver_number, lap_number, date_start, lap_ms, s1_ms, i1_kph, is_pit_out, seg1, quali_phase)
    VALUES (10, 'openf1', 1, 1, '2026-10-11T12:05:00Z', 90000, 30000, 301, false, '{2048,2049}', 2),
           (10, 'f1-archive', 44, 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`.execute(admin);
});
afterAll(async () => {
  await admin?.destroy();
  await testDb?.drop();
});

it('copies every lap row into lap_source with its own source, and lap.filled starts as {}', async () => {
  expect(await code(sql`SELECT 1 FROM lap_source`.execute(admin))).toBe('42P01');
  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await candidates()).toEqual([
    {
      session_key: 10,
      driver_number: 1,
      lap_number: 1,
      source: 'openf1',
      date_start: new Date('2026-10-11T12:05:00Z'),
      lap_ms: 90000,
      s1_ms: 30000,
      i1_kph: 301,
      is_pit_out: false,
      seg1: [2048, 2049],
      quali_phase: 2,
    },
    {
      session_key: 10,
      driver_number: 44,
      lap_number: 2,
      source: 'f1-archive',
      date_start: null,
      lap_ms: null,
      s1_ms: null,
      i1_kph: null,
      is_pit_out: null,
      seg1: null,
      quali_phase: null,
    },
  ]);
  const filled = await sql<{ filled: unknown }>`SELECT filled FROM lap`.execute(admin);
  expect(filled.rows).toEqual([{ filled: {} }, { filled: {} }]);
});

it('refuses a filled that is not an object, and a source the lap table does not know', async () => {
  expect(await code(sql`UPDATE lap SET filled = '[]'`.execute(admin))).toBe('23514');
  expect(await code(sql`UPDATE lap SET filled = '"x"'`.execute(admin))).toBe('23514');
  await sql`UPDATE lap SET filled = '{"s1_ms": "f1-archive"}' WHERE driver_number = 1`.execute(admin);
  expect(
    await code(
      sql`INSERT INTO lap_source (session_key, driver_number, lap_number, source) VALUES (10, 1, 1, 'nope')`.execute(
        admin,
      ),
    ),
  ).toBe('23514');
});

it('rolls back (lap_source and filled gone) and applies again, with the copy repeated', async () => {
  await dbmate('rollback'); // jolpica, the newer one
  expect(await dbmate('rollback')).toMatch(/Rolled back: 20261112000001_lap_source\.sql/);
  expect(await code(sql`SELECT 1 FROM lap_source`.execute(admin))).toBe('42P01');
  expect(await code(sql`SELECT filled FROM lap`.execute(admin))).toBe('42703');
  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await candidates()).toHaveLength(2);
  const filled = await sql`SELECT filled FROM lap`.execute(admin);
  expect(filled.rows).toEqual([{ filled: {} }, { filled: {} }]);
});
