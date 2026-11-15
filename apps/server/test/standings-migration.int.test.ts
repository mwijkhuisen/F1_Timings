import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// P8's migration (20261115000002_standings.sql) on a database that already holds sessions: result.points and the two
// championship tables with their grants (f1_api SELECT only, f1_ingest SELECT, INSERT, DELETE), the widened CHECK, and
// the re-queue, which sends only the final, not cancelled OpenF1 Race-type sessions of 2023 on back to `fetched` at
// date_end + 35 min (no SQL now()). The down migration removes the two endpoints' raw rows, the tables and the column,
// brings the old CHECK back and does not undo the re-queue.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const RACE = 11388;
const SPRINT = 11383;
const MEETING = 1296; // 2026
const OLD_MEETING = 1100; // 2022: before OpenF1's own data starts, so never re-queued

// [key, meeting, source, type, name, state, cancelled]: the three the re-queue must take, then every row it must leave alone.
const SESSIONS = [
  [RACE, MEETING, 'openf1', 'Race', 'Race', 'final', false],
  [SPRINT, MEETING, 'openf1', 'Race', 'Sprint', 'final', false],
  [900_000, 1200, 'openf1', 'Race', 'Race', 'final', false], // 2023, the first season
  [900_001, MEETING, 'openf1', 'Race', 'Race', 'final', true], // cancelled
  [900_002, MEETING, 'openf1', 'Qualifying', 'Qualifying', 'final', false], // another type
  [900_003, MEETING, 'openf1', 'Race', 'Race', 'failed', false], // other states
  [900_004, MEETING, 'openf1', 'Race', 'Race', 'fetched', false],
  [900_005, MEETING, 'f1-archive', 'Race', 'Race', 'final', false], // an archive race
  [900_006, OLD_MEETING, 'openf1', 'Race', 'Race', 'final', false], // 2022
  [900_007, MEETING, 'openf1', 'Practice', 'Practice 1', 'final', false],
] as const;
const REQUEUED = [RACE, SPRINT, 900_000];

let testDb: TestDb;
let admin: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const clients: pg.Client[] = [];
const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
const DONE = /Rolled back: 20261115000002_standings\.sql/;
// Rolls back any newer migration, then this one; dbmate's last output.
const rollbackStandings = async () => {
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
const raw = (endpoint: string, key = RACE) =>
  sql`INSERT INTO raw_response VALUES (${key}, 'openf1', ${endpoint}, now(), 200, '[]')`.execute(admin);
const columns = async (table: string) =>
  (
    await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`.execute(admin)
  ).rows.map((c) => `${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' not null' : ''}`);

describe('the standings migration (20261115000002)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
    expect(await run(['migrate'], env, () => {})).toBe(0);
    expect(await rollbackStandings()).toMatch(DONE);
    admin = createDb(testDb.urls.admin);
    await admin
      .insertInto('meeting')
      .values([
        { meeting_key: MEETING, source: 'openf1', year: 2026 },
        { meeting_key: 1200, source: 'openf1', year: 2023 },
        { meeting_key: OLD_MEETING, source: 'openf1', year: 2022 },
      ])
      .execute();
    for (const [key, meeting, source, type, name, state, cancelled] of SESSIONS)
      await admin
        .insertInto('session')
        .values({
          session_key: key,
          source,
          meeting_key: meeting,
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
      .insertInto('result')
      .values({ session_key: RACE, source: 'openf1', driver_number: 3, grid: 1 })
      .execute();
    await raw('starting_grid');
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end()));
    await admin?.destroy();
    await testDb?.drop();
  });

  it('before: no points column, no tables, and the old CHECK refuses both endpoints', async () => {
    expect(await columns('result')).not.toContain('points real');
    expect(await columns('championship_driver')).toEqual([]);
    expect(await columns('championship_team')).toEqual([]);
    expect(await code(raw('championship_drivers'))).toBe('23514');
    expect(await code(raw('championship_teams'))).toBe('23514');
  });

  it('re-queues only the final, not cancelled OpenF1 Race-type sessions of 2023 on, at date_end + 35 min', async () => {
    const before = await snapshot();
    expect(await run(['migrate'], env, () => {})).toBe(0);
    const after = await snapshot();
    // The instant, not its spelling: to_jsonb writes it in the session's time zone.
    const split = (row: unknown) => {
      const { next_fetch_at, ...rest } = row as Record<string, unknown>;
      return { at: Date.parse(String(next_fetch_at)), rest };
    };
    for (const key of REQUEUED) {
      expect(split(after[key]), String(key)).toEqual({
        at: Date.parse('2026-10-11T14:35:00Z'),
        rest: { ...split(before[key]).rest, ingest_state: 'fetched' },
      });
    }
    for (const [key] of SESSIONS.filter(([k]) => !REQUEUED.includes(k)))
      expect(after[key], String(key)).toEqual(before[key]);
  });

  it('adds result.points (real, null) and the two tables, keyed by (session_key, driver_number | team_name)', async () => {
    expect(await columns('result')).toContain('points real');
    expect(await columns('championship_driver')).toEqual([
      'driver_number smallint not null',
      'points_current real',
      'points_start real',
      'position_current smallint',
      'position_start smallint',
      'session_key integer not null',
      'source text not null',
    ]);
    expect(await columns('championship_team')).toEqual([
      'points_current real',
      'points_start real',
      'position_current smallint',
      'position_start smallint',
      'session_key integer not null',
      'source text not null',
      'team_name text not null',
    ]);
    expect(await admin.selectFrom('result').select('points').executeTakeFirst()).toEqual({ points: null });
    const keys = await sql<{ table_name: string; columns: string[] }>`
      SELECT tc.table_name, array_agg(k.column_name::text ORDER BY k.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k USING (constraint_name, table_schema, table_name)
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name LIKE 'championship_%'
      GROUP BY tc.table_name ORDER BY tc.table_name`.execute(admin);
    expect(keys.rows).toEqual([
      { table_name: 'championship_driver', columns: ['session_key', 'driver_number'] },
      { table_name: 'championship_team', columns: ['session_key', 'team_name'] },
    ]);
  });

  it('the CHECK takes both endpoints; the tables refuse a bad source and cascade with the session', async () => {
    expect(await code(raw('championship_drivers'))).toBe('ok');
    expect(await code(raw('championship_teams'))).toBe('ok');
    expect(await code(raw('nope'))).toBe('23514');
    expect(
      await code(
        sql`INSERT INTO championship_driver (session_key, source, driver_number) VALUES (${RACE}, 'x', 1)`.execute(
          admin,
        ),
      ),
    ).toBe('23514');
    await sql`INSERT INTO championship_driver VALUES (${RACE}, 'openf1', 1, 1, 1, 0, 25)`.execute(admin);
    await sql`INSERT INTO championship_team VALUES (${RACE}, 'openf1', 'Ferrari', 1, 1, 0, 43.5)`.execute(admin);
    expect(await code(sql`INSERT INTO championship_team VALUES (${RACE}, 'openf1', 'Ferrari')`.execute(admin))).toBe(
      '23505',
    );
    await sql`INSERT INTO session (session_key, source, meeting_key, date_start, date_end)
      VALUES (900_100, 'openf1', ${MEETING}, now(), now())`.execute(admin);
    await sql`INSERT INTO championship_team VALUES (900_100, 'openf1', 'Ferrari')`.execute(admin);
    await sql`DELETE FROM session WHERE session_key = 900_100`.execute(admin);
    expect((await sql`SELECT 1 FROM championship_team WHERE session_key = 900_100`.execute(admin)).rows).toEqual([]);
  });

  it('grants: f1_api SELECT only; f1_ingest SELECT, INSERT and DELETE (it replaces rows, never updates one)', async () => {
    const privileges = async (role: string, table: string) =>
      (
        await sql<{ privilege_type: string }>`
          SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = ${table} AND grantee = ${role} ORDER BY 1`.execute(admin)
      ).rows.map((r) => r.privilege_type);
    for (const table of ['championship_driver', 'championship_team']) {
      expect(await privileges('f1_api', table), table).toEqual(['SELECT']);
      expect(await privileges('f1_ingest', table), table).toEqual(['DELETE', 'INSERT', 'SELECT']);
    }
    const api = await connect(testDb.urls.f1_api);
    expect((await api.query('SELECT * FROM championship_driver')).rowCount).toBe(1);
    expect((await api.query('SELECT * FROM championship_team')).rowCount).toBe(1);
    expect((await api.query('SELECT points FROM result')).rowCount).toBe(1);
    for (const q of [
      "INSERT INTO championship_team VALUES (11388, 'openf1', 'McLaren')",
      'UPDATE championship_driver SET points_current = 1',
      'DELETE FROM championship_driver',
      'DELETE FROM championship_team',
    ])
      expect(await code(api.query(q)), q).toBe('42501');
    const ingest = await connect(testDb.urls.f1_ingest);
    await ingest.query('DELETE FROM championship_driver WHERE session_key = 11388');
    await ingest.query('DELETE FROM championship_team WHERE session_key = 11388');
    await ingest.query("INSERT INTO championship_driver VALUES (11388, 'openf1', 3, 1, 1, 0, 25)");
    await ingest.query("INSERT INTO championship_team VALUES (11388, 'openf1', 'Ferrari', 1, 1, 0, 43.5)");
    expect(await code(ingest.query('UPDATE championship_driver SET points_current = 1'))).toBe('42501');
    expect(await code(ingest.query('UPDATE championship_team SET points_current = 1'))).toBe('42501');
    await ingest.query('UPDATE result SET points = 25 WHERE session_key = 11388'); // result already took updates
    expect(await code(ingest.query('DELETE FROM session'))).toBe('42501'); // nothing new on session
  });

  it('rolls back: the two endpoints raw rows, the tables and the column go, the old CHECK is back; up again', async () => {
    expect(await rollbackStandings()).toMatch(DONE);
    expect(await sql`SELECT endpoint FROM raw_response`.execute(admin)).toMatchObject({
      rows: [{ endpoint: 'starting_grid' }], // the other endpoints' raw rows stay
    });
    expect(await columns('championship_driver')).toEqual([]);
    expect(await columns('championship_team')).toEqual([]);
    expect(await columns('result')).not.toContain('points real');
    expect(await code(raw('championship_drivers'))).toBe('23514');
    expect(await code(raw('weather'))).toBe('ok');
    // The down migration does not undo the re-queue.
    for (const key of REQUEUED)
      expect(
        await admin.selectFrom('session').select('ingest_state').where('session_key', '=', key).executeTakeFirst(),
      ).toEqual({ ingest_state: 'fetched' });
    expect(await run(['migrate'], env, () => {})).toBe(0);
    expect(await code(raw('championship_teams'))).toBe('ok');
  });
});
