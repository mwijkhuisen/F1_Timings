import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// #236's migration (20261118000001_overtake.sql): the CHECKs, the cascade from the session and the grants.
// migrate.int.test.ts already rolls every migration back and applies it again, so this file does not.

const SESSION = 900_001;
const row = (over: Partial<Record<string, string | number>> = {}) => ({
  session_key: SESSION,
  driver_number: 7,
  date: '2026-11-22T06:00:00Z',
  places: 1,
  source: 'f1-archive',
  ...over,
});

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
  db.insertInto('overtake').values(row(over)).execute();
const count = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM overtake`.execute(admin)).rows[0]?.n;

describe('the overtake migration (20261118000001)', { timeout: 120_000 }, () => {
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
          date_start: '2026-11-22T06:00:00Z',
          date_end: '2026-11-22T08:00:00Z',
        })
        .execute();
  });
  afterAll(async () => {
    await Promise.all([admin?.destroy(), ingest?.destroy(), api?.destroy()]);
    await testDb?.drop();
  });

  it('f1_ingest inserts (the identity needs no sequence grant), selects and deletes, and cannot update', async () => {
    expect(await code(insert(ingest))).toBe('ok');
    expect(await code(insert(ingest))).toBe('ok'); // two moves of a car at the same time are two rows
    expect(await ingest.selectFrom('overtake').select(['driver_number', 'places', 'source']).execute()).toEqual([
      { driver_number: 7, places: 1, source: 'f1-archive' },
      { driver_number: 7, places: 1, source: 'f1-archive' },
    ]);
    expect(await code(sql`UPDATE overtake SET places = 2`.execute(ingest))).toBe('42501');
    expect(await code(sql`DELETE FROM overtake`.execute(ingest))).toBe('ok');
    expect(await count()).toBe(0);
  });

  it('f1_api selects and cannot insert, update or delete', async () => {
    await insert(admin);
    expect((await api.selectFrom('overtake').selectAll().execute()).length).toBe(1);
    expect(await code(insert(api))).toBe('42501');
    expect(await code(sql`UPDATE overtake SET places = 2`.execute(api))).toBe('42501');
    expect(await code(sql`DELETE FROM overtake`.execute(api))).toBe('42501');
    await sql`DELETE FROM overtake`.execute(admin);
  });

  it('the CHECKs: places 1..99, the two F1 sources only', async () => {
    for (const places of [1, 99]) expect(await code(insert(admin, { places }))).toBe('ok');
    for (const places of [0, 100, -1]) expect(await code(insert(admin, { places }))).toBe('23514');
    expect(await code(insert(admin, { source: 'f1-live' }))).toBe('ok');
    expect(await code(insert(admin, { source: 'openf1' }))).toBe('23514');
    await sql`DELETE FROM overtake`.execute(admin);
  });

  it('a session delete cascades to its rows only', async () => {
    await insert(admin);
    await insert(admin, { session_key: SESSION + 1 });
    await sql`DELETE FROM session WHERE session_key = ${SESSION}`.execute(admin);
    expect(await admin.selectFrom('overtake').select('session_key').execute()).toEqual([{ session_key: SESSION + 1 }]);
  });
});
