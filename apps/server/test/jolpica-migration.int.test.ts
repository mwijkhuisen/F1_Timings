import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// P3c's migration (20261113000001_jolpica.sql): 'jolpica' joins the source CHECK of the seven tables the job writes,
// result gets `grid`, and the down migration removes every jolpica row and puts the old CHECK back.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

let testDb: TestDb;
let admin: Kysely<DB>;
let ingest: Kysely<DB>;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const count = async (table: string) =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(admin)).rows[0]?.n);

/** One 'jolpica' row per table, on the openf1 session 10, valid but for the source: a refusal is the CHECK (23514). */
const PROBES = {
  stint: sql`INSERT INTO stint (session_key, source, driver_number, stint_number) VALUES (10, 'jolpica', 9, 1)`,
  race_control: sql`INSERT INTO race_control (session_key, source) VALUES (10, 'jolpica')`,
  raw_response: sql`INSERT INTO raw_response (session_key, source, endpoint, fetched_at, http_status, body)
    VALUES (10, 'jolpica', 'laps', '2026-10-11T15:00:00Z', 200, '[]')`,
  weather: sql`INSERT INTO weather (session_key, source, date) VALUES (10, 'jolpica', '2026-10-11T12:00:00Z')`,
  recording: sql`INSERT INTO recording (session_key, source, path, started_at)
    VALUES (10, 'jolpica', '10-1', '2026-10-11T12:00:00Z')`,
  meeting: sql`INSERT INTO meeting (meeting_key, source, year) VALUES (2, 'jolpica', 2026)`,
  session: sql`INSERT INTO session (session_key, source, meeting_key, date_start, date_end)
    VALUES (11, 'jolpica', 1, '2026-10-11T12:00:00Z', '2026-10-11T14:00:00Z')`,
  driver: sql`INSERT INTO driver (session_key, source, driver_number) VALUES (10, 'jolpica', 9)`,
  lap: sql`INSERT INTO lap (session_key, source, driver_number, lap_number) VALUES (10, 'jolpica', 9, 1)`,
  lap_source: sql`INSERT INTO lap_source (session_key, source, driver_number, lap_number) VALUES (10, 'jolpica', 9, 1)`,
  pit: sql`INSERT INTO pit (session_key, source, driver_number, lap_number) VALUES (10, 'jolpica', 9, 1)`,
  result: sql`INSERT INTO result (session_key, source, driver_number) VALUES (10, 'jolpica', 9)`,
};
const UNTOUCHED = ['stint', 'race_control', 'raw_response', 'weather', 'recording'] as const;
const SEVEN = ['meeting', 'session', 'driver', 'lap', 'lap_source', 'pit', 'result'] as const;
const refusals = async (tables: readonly (keyof typeof PROBES)[]) => {
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await code(PROBES[t].execute(admin));
  return out;
};
const refused = (tables: readonly string[]) => Object.fromEntries(tables.map((t) => [t, '23514']));

const seed = async (db: Kysely<DB>) => {
  await sql`INSERT INTO meeting (meeting_key, source, year) VALUES (1950, 'jolpica', 1950)`.execute(db);
  await sql`INSERT INTO session (session_key, source, meeting_key, date_start, date_end)
    VALUES (19501, 'jolpica', 1950, '1950-05-13T12:00:00Z', '1950-05-13T14:00:00Z')`.execute(db);
  await sql`INSERT INTO driver (session_key, source, driver_number) VALUES (19501, 'jolpica', 1)`.execute(db);
  await sql`INSERT INTO lap (session_key, source, driver_number, lap_number) VALUES (19501, 'jolpica', 1, 1)`.execute(
    db,
  );
  await sql`INSERT INTO lap_source (session_key, source, driver_number, lap_number) VALUES (19501, 'jolpica', 1, 1)`.execute(
    db,
  );
  await sql`INSERT INTO pit (session_key, source, driver_number, lap_number) VALUES (19501, 'jolpica', 1, 1)`.execute(
    db,
  );
  await sql`INSERT INTO result (session_key, source, driver_number, position, grid) VALUES (19501, 'jolpica', 1, 1, 0)`.execute(
    db,
  );
};

beforeAll(async () => {
  testDb = await createTestDb();
  env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
  expect(await run(['migrate'], env, () => {})).toBe(0);
  admin = createDb(testDb.urls.admin);
  ingest = createDb(testDb.urls.f1_ingest);
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
});
afterAll(async () => {
  await ingest?.destroy();
  await admin?.destroy();
  await testDb?.drop();
});

it('accepts source jolpica in the seven tables as f1_ingest, and result.grid exists', async () => {
  await seed(ingest);
  const r = await sql<{ grid: number }>`SELECT grid FROM result`.execute(admin);
  expect(r.rows).toEqual([{ grid: 0 }]);
});

it('still refuses jolpica in the five tables the job never writes', async () => {
  expect(await refusals(UNTOUCHED)).toEqual(refused(UNTOUCHED));
});

it('rolls back: jolpica rows gone (also a candidate on another session), grid gone, old CHECK back; applies again', async () => {
  await sql`INSERT INTO lap_source (session_key, source, driver_number, lap_number) VALUES (10, 'jolpica', 1, 1)`.execute(
    ingest,
  );
  await sql`INSERT INTO lap (session_key, source, driver_number, lap_number) VALUES (10, 'jolpica', 1, 1)`.execute(
    ingest,
  );
  await sql`INSERT INTO lap_source (session_key, source, driver_number, lap_number) VALUES (10, 'openf1', 1, 1)`.execute(
    ingest,
  );
  expect(await dbmate('rollback')).toMatch(/Rolled back: 20261113000002_ingest_status\.sql/); // the newer one first
  expect(await dbmate('rollback')).toMatch(/Rolled back: 20261113000001_jolpica\.sql/);
  for (const t of ['meeting', 'session', 'driver', 'lap', 'pit', 'result']) {
    const own = t === 'meeting' || t === 'session' ? 1 : 0;
    expect(await count(t)).toBe(own);
  }
  expect(await count('lap_source')).toBe(1);
  expect(await code(sql`SELECT grid FROM result`.execute(admin))).toBe('42703');
  expect(await refusals(SEVEN)).toEqual(refused(SEVEN)); // every old CHECK back
  expect(await run(['migrate'], env, () => {})).toBe(0);
  await seed(admin);
  expect(await count('result')).toBe(1);
});
