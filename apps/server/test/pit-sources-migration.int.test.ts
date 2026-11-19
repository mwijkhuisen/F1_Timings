import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// #219's migration (20261119000001_pit_sources.sql) on a database that already holds pit rows: each row's values move
// into `sources` under its own source (the date as epoch ms), `filled` starts as {}, and the down migration drops both.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const VERSION = '20261119000001_pit_sources';

let testDb: TestDb;
let admin: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
// Rolls back the newest migrations until `version` is gone, whichever newer ones exist; dbmate's last output.
const rollbackPast = async (version: string) => {
  for (;;) {
    const out = await dbmate('rollback');
    if (out.includes(`Rolled back: ${version}.sql`) || !/Rolled back:/.test(out)) return out;
  }
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const pits = async () =>
  (
    await sql<{
      driver_number: number;
      source: string;
      sources: unknown;
      filled: unknown;
    }>`SELECT driver_number, source, sources, filled FROM pit ORDER BY driver_number`.execute(admin)
  ).rows;

beforeAll(async () => {
  testDb = await createTestDb();
  env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await rollbackPast(VERSION)).toMatch(/Rolled back: 20261119000001_pit_sources\.sql/);
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
  await sql`INSERT INTO pit (session_key, source, driver_number, lap_number, date, pit_ms, lane_ms, stop_ms)
    VALUES (10, 'openf1', 1, 20, '2026-10-11T13:31:02.395+00', 22100, 22100, NULL),
           (10, 'jolpica', 44, 30, NULL, 23000, 23000, NULL)`.execute(admin);
});
afterAll(async () => {
  await admin?.destroy();
  await testDb?.drop();
});

it('moves each row into `sources` under its own source, the date as epoch ms, and `filled` starts as {}', async () => {
  expect(await code(sql`SELECT sources FROM pit`.execute(admin))).toBe('42703');
  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await pits()).toEqual([
    {
      driver_number: 1,
      source: 'openf1',
      sources: {
        openf1: { date: Date.parse('2026-10-11T13:31:02.395Z'), pit_ms: 22100, lane_ms: 22100, stop_ms: null },
      },
      filled: {},
    },
    {
      driver_number: 44,
      source: 'jolpica',
      sources: { jolpica: { date: null, pit_ms: 23000, lane_ms: 23000, stop_ms: null } },
      filled: {},
    },
  ]);
});

it('refuses a `sources` or `filled` that is no object; the previous image can still insert without them', async () => {
  for (const column of ['sources', 'filled']) {
    expect(await code(sql`UPDATE pit SET ${sql.ref(column)} = '[]'`.execute(admin))).toBe('23514');
    expect(await code(sql`UPDATE pit SET ${sql.ref(column)} = '"x"'`.execute(admin))).toBe('23514');
  }
  const ingest = createDb(testDb.urls.f1_ingest);
  try {
    await ingest
      .insertInto('pit')
      .values({ session_key: 10, source: 'openf1', driver_number: 4, lap_number: 5, lane_ms: 21000 })
      .execute();
  } finally {
    await ingest.destroy();
  }
  expect((await pits()).find((r) => r.driver_number === 4)).toEqual({
    driver_number: 4,
    source: 'openf1',
    sources: {},
    filled: {},
  });
});

it('rolls back (both columns gone) and applies again, with the backfill repeated', async () => {
  expect(await rollbackPast(VERSION)).toMatch(/Rolled back: 20261119000001_pit_sources\.sql/);
  expect(await code(sql`SELECT sources FROM pit`.execute(admin))).toBe('42703');
  expect(await code(sql`SELECT filled FROM pit`.execute(admin))).toBe('42703');
  expect(await run(['migrate'], env, () => {})).toBe(0);
  const rows = await pits();
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.driver_number === 4)).toMatchObject({
    sources: { openf1: { date: null, pit_ms: null, lane_ms: 21000, stop_ms: null } },
  });
});
