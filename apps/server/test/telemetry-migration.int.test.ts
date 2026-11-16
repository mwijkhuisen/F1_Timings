import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// P7b's migration (20261116000001_telemetry.sql): the CHECKs (the byte bounds of TELEMETRY_MAX_SAMPLES records), the
// cascade from the session and the grants. migrate.int.test.ts already rolls every migration back and applies it
// again, so this file does not.

const SESSION = 900_001;
const row = (over: Partial<Record<string, string | number | Buffer | null>> = {}) => ({
  session_key: SESSION,
  driver_number: 1,
  lap_number: 1,
  source: 'f1-live',
  date_start: '2026-11-16T12:00:00Z',
  car: Buffer.alloc(11),
  pos: Buffer.alloc(9),
  top_kph: 331,
  full_throttle: 0.71,
  ...over,
});
const values = (over?: Parameters<typeof row>[0]) => sql`(${sql.join(Object.values(row(over)))})`;

let testDb: TestDb;
let admin: Kysely<DB>;
let ingest: Kysely<DB>;
let api: Kysely<DB>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const insert = (db: Kysely<DB>, over?: Parameters<typeof row>[0]) =>
  sql`INSERT INTO telemetry_lap VALUES ${values(over)}`.execute(db);
const count = async () =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM telemetry_lap`.execute(admin)).rows[0]?.n;

describe('the telemetry migration (20261116000001)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    ingest = createDb(testDb.urls.f1_ingest);
    api = createDb(testDb.urls.f1_api);
    await admin.insertInto('meeting').values({ meeting_key: 1296, source: 'openf1', year: 2026 }).execute();
    for (const key of [SESSION, SESSION + 1])
      await admin
        .insertInto('session')
        .values({
          session_key: key,
          source: 'openf1',
          meeting_key: 1296,
          type: 'Race',
          name: 'Race',
          date_start: '2026-10-11T12:00:00Z',
          date_end: '2026-10-11T14:00:00Z',
        })
        .execute();
  });
  afterAll(async () => {
    await Promise.all([admin?.destroy(), ingest?.destroy(), api?.destroy()]);
    await testDb?.drop();
  });

  it('f1_ingest inserts, selects and deletes a row, and cannot update one', async () => {
    expect(await code(insert(ingest))).toBe('ok');
    expect(await code(insert(ingest))).toBe('23505'); // one row per (session, driver, lap)
    expect(await ingest.selectFrom('telemetry_lap').select(['top_kph', 'full_throttle']).execute()).toEqual([
      { top_kph: 331, full_throttle: 0.71 },
    ]);
    expect(await code(sql`UPDATE telemetry_lap SET top_kph = 1`.execute(ingest))).toBe('42501');
    expect(await code(sql`DELETE FROM telemetry_lap`.execute(ingest))).toBe('ok');
    expect(await count()).toBe(0);
  });

  it('f1_api selects and cannot insert, update or delete', async () => {
    await insert(admin);
    expect((await api.selectFrom('telemetry_lap').selectAll().execute()).length).toBe(1);
    expect(await code(insert(api, { lap_number: 2 }))).toBe('42501');
    expect(await code(sql`UPDATE telemetry_lap SET top_kph = 1`.execute(api))).toBe('42501');
    expect(await code(sql`DELETE FROM telemetry_lap`.execute(api))).toBe('42501');
    await sql`DELETE FROM telemetry_lap`.execute(admin);
  });

  it('the byte bounds: 200,001 and 180,000 pass, 200,002 and 180,001 and an empty car do not', async () => {
    expect(await code(insert(admin, { car: Buffer.alloc(200_001), pos: Buffer.alloc(180_000) }))).toBe('ok');
    expect(await code(insert(admin, { lap_number: 2, car: Buffer.alloc(200_002) }))).toBe('23514');
    expect(await code(insert(admin, { lap_number: 3, pos: Buffer.alloc(180_001) }))).toBe('23514');
    expect(await code(insert(admin, { lap_number: 4, car: Buffer.alloc(0) }))).toBe('23514');
    expect(await code(insert(admin, { lap_number: 5, pos: Buffer.alloc(0) }))).toBe('ok'); // no position samples
    await sql`DELETE FROM telemetry_lap`.execute(admin);
  });

  it('the other CHECKs: source, a negative top speed, a full throttle share outside 0..1', async () => {
    expect(await code(insert(admin, { source: 'openf1' }))).toBe('23514');
    expect(await code(insert(admin, { top_kph: -1 }))).toBe('23514');
    expect(await code(insert(admin, { full_throttle: 1.01 }))).toBe('23514');
    expect(await code(insert(admin, { full_throttle: -0.01 }))).toBe('23514');
    expect(await code(insert(admin, { top_kph: null, full_throttle: null }))).toBe('ok');
    expect(await code(insert(admin, { lap_number: 2, source: 'f1-archive', top_kph: 0, full_throttle: 1 }))).toBe('ok');
    await sql`DELETE FROM telemetry_lap`.execute(admin);
  });

  it('a session delete cascades to its rows only', async () => {
    await insert(admin);
    await insert(admin, { session_key: SESSION + 1 });
    await sql`DELETE FROM session WHERE session_key = ${SESSION}`.execute(admin);
    expect(await admin.selectFrom('telemetry_lap').select('session_key').execute()).toEqual([
      { session_key: SESSION + 1 },
    ]);
  });
});
