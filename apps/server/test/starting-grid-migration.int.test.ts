import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// #115's migration (20261114000001_starting_grid.sql) on a database that already holds sessions: the re-queue sends
// only the final, not cancelled OpenF1 races and sprints back to `fetched` at date_end + 35 min (no SQL now()), and
// the down migration removes the grid raw rows and OpenF1's grids, keeps a Jolpica grid and brings the old CHECK back.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const RACE = 11388;
const SPRINT = 11383;

// [key, source, type, name, state, cancelled]: the two the re-queue must take, then every row it must leave alone.
const SESSIONS = [
  [RACE, 'openf1', 'Race', 'Race', 'final', false],
  [SPRINT, 'openf1', 'Race', 'Sprint', 'final', false],
  [900_001, 'openf1', 'Race', 'Race', 'final', true], // cancelled
  [900_002, 'openf1', 'Qualifying', 'Qualifying', 'final', false], // another type
  [900_003, 'openf1', 'Race', 'Race', 'failed', false], // other states
  [900_004, 'openf1', 'Race', 'Race', 'fetched', false],
  [900_005, 'f1-archive', 'Race', 'Race', 'final', false], // an archive race
] as const;

let testDb: TestDb;
let admin: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
const DONE = /Rolled back: 20261114000001_starting_grid\.sql/;
// Rolls back any newer migration, then this one; dbmate's last output.
const rollbackGrid = async () => {
  for (;;) {
    const out = await dbmate('rollback');
    if (DONE.test(out) || !/Rolled back:/.test(out)) return out;
  }
};
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
const gridRaw = (key: number) =>
  sql`INSERT INTO raw_response VALUES (${key}, 'openf1', 'starting_grid', now(), 200, '[]')`.execute(admin);

describe('the starting grid migration (20261114000001)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
    expect(await run(['migrate'], env, () => {})).toBe(0);
    expect(await rollbackGrid()).toMatch(DONE);
    admin = createDb(testDb.urls.admin);
    await admin
      .insertInto('meeting')
      .values([
        { meeting_key: 1296, source: 'openf1', year: 2026 },
        { meeting_key: 1950, source: 'jolpica', year: 1950 },
      ])
      .execute();
    for (const [key, source, type, name, state, cancelled] of SESSIONS)
      await admin
        .insertInto('session')
        .values({
          session_key: key,
          source,
          meeting_key: 1296,
          type,
          name,
          date_start: '2026-10-11T12:00:00Z',
          date_end: '2026-10-11T14:00:00Z',
          is_cancelled: cancelled,
          ingest_state: state,
          next_fetch_at: state === 'fetched' ? '2026-12-01T00:00:00Z' : null,
          fetch_count: state === 'failed' ? 0 : 1,
          fail_count: state === 'failed' ? 9 : 0,
          last_error: state === 'failed' ? 'http_500' : null,
        })
        .execute();
    await admin
      .insertInto('session')
      .values({
        session_key: 19501,
        source: 'jolpica',
        meeting_key: 1950,
        type: 'Race',
        name: 'Race',
        date_start: '1950-05-13T12:00:00Z',
        date_end: '1950-05-13T14:00:00Z',
        ingest_state: 'final',
      })
      .execute();
    await admin
      .insertInto('result')
      .values([
        { session_key: RACE, source: 'openf1', driver_number: 3, grid: 1 },
        { session_key: 19501, source: 'jolpica', driver_number: 1, grid: 0 }, // Jolpica: a pit-lane start
      ])
      .execute();
  });
  afterAll(async () => {
    await admin?.destroy();
    await testDb?.drop();
  });

  it('the old CHECK refuses starting_grid', async () => {
    expect(await code(gridRaw(RACE))).toBe('23514');
  });

  it('re-queues only the final, not cancelled OpenF1 races and sprints, at date_end + 35 min', async () => {
    const before = await snapshot();
    expect(await run(['migrate'], env, () => {})).toBe(0);
    const after = await snapshot();
    for (const key of [RACE, SPRINT])
      expect(after[key], String(key)).toEqual({
        ...before[key],
        ingest_state: 'fetched',
        next_fetch_at: '2026-10-11T14:35:00+00:00',
      });
    for (const [key] of SESSIONS.slice(2)) expect(after[key], String(key)).toEqual(before[key]);
    expect(after[19501]).toEqual(before[19501]);
    expect(await code(gridRaw(RACE))).toBe('ok');
  });

  it('rolls back: the grid raw rows and the OpenF1 grids go, a Jolpica grid stays, the old CHECK is back; up again', async () => {
    expect(await rollbackGrid()).toMatch(DONE);
    expect(await sql`SELECT endpoint FROM raw_response`.execute(admin)).toMatchObject({ rows: [] });
    const grids = await sql`SELECT session_key, grid FROM result ORDER BY session_key`.execute(admin);
    expect(grids.rows).toEqual([
      { session_key: RACE, grid: null },
      { session_key: 19501, grid: 0 },
    ]);
    expect(await code(gridRaw(RACE))).toBe('23514');
    // The down migration does not undo the re-queue.
    expect(
      await admin.selectFrom('session').select('ingest_state').where('session_key', '=', RACE).executeTakeFirst(),
    ).toEqual({ ingest_state: 'fetched' });
    expect(await run(['migrate'], env, () => {})).toBe(0);
    expect(await code(gridRaw(RACE))).toBe('ok');
  });
});
