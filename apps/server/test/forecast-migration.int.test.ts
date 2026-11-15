import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// #120's migration (20261115000001_forecast.sql): the CHECKs, the cascades (meeting -> forecast -> hours), the grants
// and the down migration.

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const MEETING = 1300;

let testDb: TestDb;
let admin: Kysely<DB>;
let ingest: Kysely<DB>;
let api: Kysely<DB>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const forecast = (over: Partial<Record<string, string | number | null>> = {}) => {
  const f = {
    meeting_key: MEETING,
    source: 'open-meteo',
    map_id: 'us-2023',
    lat: 36.1167,
    lon: -115.1666,
    state: 'live',
    last_error: null,
    updated_at: '2026-11-18T00:00:00Z',
    ...over,
  };
  return sql`INSERT INTO forecast (meeting_key, source, map_id, lat, lon, state, last_error, updated_at)
    VALUES (${f.meeting_key}, ${f.source}, ${f.map_id}, ${f.lat}, ${f.lon}, ${f.state}, ${f.last_error}, ${f.updated_at})`;
};
const hour = (date: string, over: Partial<Record<string, number | null>> = {}, key = MEETING) => {
  const h = { precipitation_probability: 40, precipitation: 0.2, temperature_2m: -3.5, wind_speed_10m: 4, ...over };
  return sql`INSERT INTO forecast_hour (meeting_key, date, precipitation_probability, precipitation, temperature_2m, wind_speed_10m)
    VALUES (${key}, ${date}, ${h.precipitation_probability}, ${h.precipitation}, ${h.temperature_2m}, ${h.wind_speed_10m})`;
};
const count = async (table: 'forecast' | 'forecast_hour') =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(admin)).rows[0]?.n;

describe('the forecast migration (20261115000001)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    ingest = createDb(testDb.urls.f1_ingest);
    api = createDb(testDb.urls.f1_api);
    for (const meeting_key of [MEETING, MEETING + 1])
      await admin.insertInto('meeting').values({ meeting_key, source: 'openf1', year: 2026 }).execute();
  });
  afterAll(async () => {
    await Promise.all([admin?.destroy(), ingest?.destroy(), api?.destroy()]);
    await testDb?.drop();
  });

  it('refuses a bad state, a bad last_error, another source and an out-of-range point', async () => {
    const bad: Partial<Record<string, string | number | null>>[] = [
      { state: 'done' },
      { last_error: 'HTTP 500' },
      { last_error: 'oops' },
      { source: 'openf1' },
      { lat: 90.5 },
      { lat: -91 },
      { lon: 180.5 },
      { lon: -181 },
    ];
    for (const over of bad) expect(await code(forecast(over).execute(ingest)), JSON.stringify(over)).toBe('23514');
    expect(await count('forecast')).toBe(0);
  });

  it('takes a valid forecast and hours from f1_ingest, nulls included, and refuses an hour out of range', async () => {
    expect(await code(forecast().execute(ingest))).toBe('ok');
    for (const last_error of ['http_429', 'rate_limited', 'timeout', 'network', 'schema', 'db', 'unknown'])
      expect(await code(sql`UPDATE forecast SET last_error = ${last_error}`.execute(ingest)), last_error).toBe('ok');
    const nulls = { precipitation_probability: null, precipitation: null, temperature_2m: null, wind_speed_10m: null };
    expect(await code(hour('2026-11-20T01:00:00Z').execute(ingest))).toBe('ok');
    expect(await code(hour('2026-11-20T02:00:00Z', nulls).execute(ingest))).toBe('ok');
    expect(await code(hour('2026-11-20T02:00:00Z').execute(ingest))).toBe('23505');
    for (const over of [
      { precipitation_probability: 101 },
      { precipitation_probability: -1 },
      { precipitation: -0.1 },
      { wind_speed_10m: -1 },
    ])
      expect(await code(hour('2026-11-20T03:00:00Z', over).execute(ingest)), JSON.stringify(over)).toBe('23514');
    expect(await count('forecast_hour')).toBe(2);
  });

  it('refuses hours without a forecast and a forecast without a meeting', async () => {
    expect(await code(hour('2026-11-20T01:00:00Z', {}, MEETING + 1).execute(ingest))).toBe('23503');
    expect(await code(forecast({ meeting_key: 123 }).execute(ingest))).toBe('23503');
  });

  it('lets f1_api read both tables and nothing else', async () => {
    expect((await sql`SELECT * FROM forecast`.execute(api)).rows).toHaveLength(1);
    expect((await sql`SELECT * FROM forecast_hour`.execute(api)).rows).toHaveLength(2);
    for (const stmt of [
      forecast({ meeting_key: MEETING + 1 }),
      hour('2026-11-20T04:00:00Z'),
      sql`UPDATE forecast SET state = 'final'`,
      sql`UPDATE forecast_hour SET precipitation = 0`,
      sql`DELETE FROM forecast`,
      sql`DELETE FROM forecast_hour`,
    ])
      expect(await code(stmt.execute(api))).toBe('42501');
    expect(await count('forecast')).toBe(1);
    expect(await count('forecast_hour')).toBe(2);
  });

  it('lets f1_ingest update a forecast and delete hours, but neither delete a forecast nor update an hour', async () => {
    await sql`UPDATE forecast SET state = 'final', fetch_count = fetch_count + 1, attempt_count = attempt_count + 1`.execute(
      ingest,
    );
    expect(
      (await sql<{ state: string; attempt_count: number }>`SELECT state, attempt_count FROM forecast`.execute(api))
        .rows[0],
    ).toEqual({ state: 'final', attempt_count: 1 });
    expect(await code(sql`DELETE FROM forecast`.execute(ingest))).toBe('42501');
    expect(await code(sql`UPDATE forecast_hour SET precipitation = 0`.execute(ingest))).toBe('42501');
    expect(await code(sql`DELETE FROM forecast_hour WHERE date = '2026-11-20T02:00:00Z'`.execute(ingest))).toBe('ok');
    expect(await count('forecast')).toBe(1);
    expect(await count('forecast_hour')).toBe(1);
  });

  it('deleting the meeting cascades to the forecast and its hours', async () => {
    await sql`DELETE FROM meeting WHERE meeting_key = ${MEETING}`.execute(admin);
    expect(await count('forecast')).toBe(0);
    expect(await count('forecast_hour')).toBe(0);
  });

  it('the down migration drops both tables', async () => {
    const env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator };
    const dbmate = async (...args: string[]) =>
      (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;
    // Rolls back the newest migrations until this one is gone, whichever newer ones exist.
    for (;;) {
      const out = await dbmate('rollback');
      if (out.includes('Rolled back: 20261115000001_forecast.sql') || !/Rolled back:/.test(out)) break;
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('forecast', 'forecast_hour')`.execute(admin);
    expect(rows[0]?.n).toBe(0);
  });
});
