import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// P5c's migration (20261109000002_rain.sql): the CHECKs, the cascades (session -> grid -> frames) and the grants.
// migrate.int.test.ts already rolls every migration back and applies it again, so this file does not.

const SESSION = 900_001;
const MM = Array.from({ length: 49 }, (_, i) => (i % 5 === 0 ? null : i / 10));

let testDb: TestDb;
let admin: Kysely<DB>;
let ingest: Kysely<DB>;
let api: Kysely<DB>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const grid = (over: Partial<Record<string, string | number | null>> = {}) => {
  const g = {
    session_key: SESSION,
    source: 'open-meteo',
    map_id: 'marina-bay',
    centre_lat: 1.2914,
    centre_lon: 103.864,
    size: 7,
    step_m: 1500,
    state: 'live',
    last_error: null,
    updated_at: '2026-11-09T12:00:00Z',
    ...over,
  };
  return sql`INSERT INTO rain_grid (session_key, source, map_id, centre_lat, centre_lon, size, step_m, state, last_error, updated_at)
    VALUES (${g.session_key}, ${g.source}, ${g.map_id}, ${g.centre_lat}, ${g.centre_lon}, ${g.size}, ${g.step_m}, ${g.state}, ${g.last_error}, ${g.updated_at})`;
};
const frame = (key: number, date: string, mm: readonly (number | null)[] = MM) =>
  sql`INSERT INTO rain_frame (session_key, date, mm) VALUES (${key}, ${date}, ${mm as (number | null)[]})`;
const count = async (table: 'rain_grid' | 'rain_frame') =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(admin)).rows[0]?.n;

describe('the rain migration (20261109000002)', { timeout: 120_000 }, () => {
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

  it('refuses a bad state, a bad last_error, a size other than 7, another source and an out-of-range centre', async () => {
    const bad: Partial<Record<string, string | number | null>>[] = [
      { state: 'done' },
      { last_error: 'HTTP 500' },
      { last_error: 'oops' },
      { size: 8 },
      { source: 'openf1' },
      { step_m: 0 },
      { centre_lat: 91 },
      { centre_lon: -181 },
    ];
    for (const over of bad) expect(await code(grid(over).execute(ingest)), JSON.stringify(over)).toBe('23514');
    expect(await count('rain_grid')).toBe(0);
  });

  it('takes a valid grid and frames from f1_ingest, null elements included, and refuses a wrong cardinality', async () => {
    expect(await code(grid().execute(ingest))).toBe('ok');
    for (const last_error of ['http_429', 'rate_limited', 'timeout', 'network', 'schema', 'db', 'unknown'])
      expect(await code(sql`UPDATE rain_grid SET last_error = ${last_error}`.execute(ingest)), last_error).toBe('ok');
    expect(await code(frame(SESSION, '2026-10-11T12:00:00Z').execute(ingest))).toBe('ok');
    expect(await code(frame(SESSION, '2026-10-11T12:15:00Z').execute(ingest))).toBe('ok');
    expect(await code(frame(SESSION, '2026-10-11T12:15:00Z').execute(ingest))).toBe('23505');
    expect(await code(frame(SESSION, '2026-10-11T12:30:00Z', MM.slice(0, 48)).execute(ingest))).toBe('23514');
    expect(await code(frame(SESSION, '2026-10-11T12:30:00Z', [...MM, 0]).execute(ingest))).toBe('23514');
    const row = await sql<{ mm: (number | null)[] }>`
      SELECT mm FROM rain_frame WHERE date = '2026-10-11T12:00:00Z'`.execute(ingest);
    expect(row.rows[0]?.mm).toEqual(MM);
    expect(await count('rain_frame')).toBe(2);
  });

  it('refuses a frame without a grid and a grid without a session', async () => {
    expect(await code(frame(SESSION + 1, '2026-10-11T12:00:00Z').execute(ingest))).toBe('23503');
    expect(await code(grid({ session_key: 123 }).execute(ingest))).toBe('23503');
  });

  it('lets f1_api read both tables and nothing else', async () => {
    expect((await sql`SELECT * FROM rain_grid`.execute(api)).rows).toHaveLength(1);
    expect((await sql`SELECT * FROM rain_frame`.execute(api)).rows).toHaveLength(2);
    for (const stmt of [
      grid({ session_key: SESSION + 1 }),
      frame(SESSION, '2026-10-11T13:00:00Z'),
      sql`UPDATE rain_grid SET state = 'final'`,
      sql`UPDATE rain_frame SET mm = mm`,
      sql`DELETE FROM rain_grid`,
      sql`DELETE FROM rain_frame`,
    ])
      expect(await code(stmt.execute(api))).toBe('42501');
    expect(await count('rain_grid')).toBe(1);
    expect(await count('rain_frame')).toBe(2);
  });

  it('lets f1_ingest update a grid and delete frames, but neither delete a grid nor update a frame', async () => {
    await sql`UPDATE rain_grid SET state = 'final', fetch_count = fetch_count + 1, attempt_count = attempt_count + 1`.execute(
      ingest,
    );
    expect(
      (
        await sql<{ state: string; fetch_count: number; attempt_count: number }>`
          SELECT state, fetch_count, attempt_count FROM rain_grid`.execute(api)
      ).rows[0],
    ).toEqual({ state: 'final', fetch_count: 1, attempt_count: 1 });
    expect(await code(sql`DELETE FROM rain_grid`.execute(ingest))).toBe('42501');
    expect(await code(sql`UPDATE rain_frame SET mm = mm`.execute(ingest))).toBe('42501');
    expect(await code(sql`DELETE FROM rain_frame WHERE date = '2026-10-11T12:15:00Z'`.execute(ingest))).toBe('ok');
    expect(await count('rain_grid')).toBe(1);
    expect(await count('rain_frame')).toBe(1);
  });

  it('deleting the grid cascades to its frames, deleting the session cascades to the grid and its frames', async () => {
    await grid({ session_key: SESSION + 1 }).execute(ingest);
    await frame(SESSION + 1, '2026-10-11T12:00:00Z').execute(ingest);
    expect(await count('rain_frame')).toBe(2);

    await sql`DELETE FROM rain_grid WHERE session_key = ${SESSION + 1}`.execute(admin);
    expect(await count('rain_frame')).toBe(1);
    expect(await count('rain_grid')).toBe(1);

    await sql`DELETE FROM session WHERE session_key = ${SESSION}`.execute(admin);
    expect(await count('rain_grid')).toBe(0);
    expect(await count('rain_frame')).toBe(0);
  });
});
