import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { jolpica } from '../src/jolpica/job.ts';
import { run } from '../src/main.ts';
import { writeLaps } from '../src/merge/write.ts';
import { createTestDb, type TestDb } from './db.ts';

// The 2018+ tier (P3c, H6) against a real PostgreSQL 18, logged in as f1_ingest: the synthetic dump's 2018 and 2019
// races (fixtures/jolpica/) attach their laps to seeded OpenF1 and archive races. Invented keys, numbers and times.
//   2018 r1 (05:10Z): car 33 laps 1–4 of 90/91/92/93 s and a lap without a number, car 77 laps 1–2 → RACE
//   2019 r1 (05:10Z): car 33 lap 1 of 90 s → ARCH (05:30Z)
//   2019 r2: car 33 lap 1, no race of ours → no_match; 2019 r3: no laps (a future round)

const FIXTURES = join(import.meta.dirname, 'fixtures/jolpica');
const [RACE, SPRINT, ARCH] = [9801, 9802, 9811];
const UNTOUCHED = ['meeting', 'session', 'driver', 'result', 'pit', 'stint'] as const;
const ALL = [...UNTOUCHED, 'lap', 'lap_source'] as const;

let testDb: TestDb;
let db: Kysely<DB>;
let admin: Kysely<DB>;
const lines: Record<string, unknown>[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(JSON.parse(line)) });
const deps = () => ({ db, log });
const args = { years: [2018, 2019], dir: FIXTURES };
const own = (msg: string) => lines.filter((l) => l.msg === msg);

const hashes = async (tables: readonly string[]) => {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const { rows } = await sql<{ h: string }>`
      SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) AS h
      FROM (SELECT to_jsonb(t) AS x FROM ${sql.table(table)} t) s`.execute(admin);
    out[table] = rows[0]?.h ?? '';
  }
  return out;
};
const laps = (key: number) =>
  admin
    .selectFrom('lap')
    .select(['driver_number', 'lap_number', 'source', 'lap_ms', 's1_ms', 'filled'])
    .where('session_key', '=', key)
    .orderBy('driver_number')
    .orderBy('lap_number')
    .execute();

describe('the 2018+ tier (synthetic dump, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    db = createDb(testDb.urls.f1_ingest);
    admin = createDb(testDb.urls.admin);
    await admin
      .insertInto('meeting')
      .values([
        { meeting_key: 9800, source: 'openf1', year: 2018, name: 'Synthetic' },
        { meeting_key: 9810, source: 'f1-archive', year: 2019, name: 'Synthetic' },
      ])
      .execute();
    const session = (session_key: number, source: string, meeting_key: number, name: string, at: string) => ({
      session_key,
      source,
      meeting_key,
      name,
      type: 'Race',
      date_start: new Date(at),
      date_end: new Date(Date.parse(at) + 7_200_000),
    });
    await admin
      .insertInto('session')
      .values([
        session(RACE, 'openf1', 9800, 'Race', '2018-03-25T05:10:00Z'),
        session(SPRINT, 'openf1', 9800, 'Sprint', '2018-03-25T05:40:00Z'), // within 1 h, but a sprint
        session(ARCH, 'f1-archive', 9810, 'Race', '2019-03-17T05:30:00Z'),
      ])
      .execute();
    const driver = (session_key: number, source: string, driver_number: number) => ({
      session_key,
      source,
      driver_number,
      acronym: 'XXX',
    });
    await admin
      .insertInto('driver')
      .values([
        driver(RACE, 'openf1', 33),
        driver(RACE, 'openf1', 5),
        driver(SPRINT, 'openf1', 33),
        driver(ARCH, 'f1-archive', 33),
      ])
      .execute();
    await admin
      .insertInto('result')
      .values({ session_key: RACE, source: 'openf1', driver_number: 33, position: 1 })
      .execute();
    await admin
      .insertInto('pit')
      .values({ session_key: RACE, source: 'openf1', driver_number: 33, lap_number: 2, pit_ms: 22_000 })
      .execute();
    await admin
      .insertInto('stint')
      .values({ session_key: RACE, source: 'openf1', driver_number: 33, stint_number: 1, lap_start: 1 })
      .execute();
    // A: lap 1 without a time; B: lap 2 as Jolpica's; C: lap 3 500 ms off; D: lap 4 missing.
    const lap = (driver_number: number, lap_number: number, v: object) =>
      ({ driver_number, lap_number, ...v }) as never;
    await db.transaction().execute(async (trx) => {
      await writeLaps(trx, RACE, 'openf1', [
        lap(33, 1, { lap_ms: null, s1_ms: 30_000 }),
        lap(33, 2, { lap_ms: 91_000 }),
        lap(33, 3, { lap_ms: 92_500 }),
        lap(5, 1, { lap_ms: 95_000 }),
      ]);
      await writeLaps(trx, SPRINT, 'openf1', [lap(33, 1, { lap_ms: null })]);
      await writeLaps(trx, ARCH, 'f1-archive', [lap(33, 1, { s1_ms: 30_000 })]);
    });
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it('fills a null lap time, keeps equal and conflicting ones, adds a missing lap and writes nothing else', async () => {
    const before = await hashes(UNTOUCHED);
    const sprint = await laps(SPRINT);
    expect(await jolpica(deps(), args)).toBe(true);
    expect(await hashes(UNTOUCHED)).toEqual(before);

    expect(await laps(RACE)).toEqual([
      { driver_number: 5, lap_number: 1, source: 'openf1', lap_ms: 95_000, s1_ms: null, filled: {} },
      {
        driver_number: 33,
        lap_number: 1,
        source: 'openf1',
        lap_ms: 90_000,
        s1_ms: 30_000,
        filled: { lap_ms: 'jolpica' },
      },
      { driver_number: 33, lap_number: 2, source: 'openf1', lap_ms: 91_000, s1_ms: null, filled: {} },
      { driver_number: 33, lap_number: 3, source: 'openf1', lap_ms: 92_500, s1_ms: null, filled: {} },
      { driver_number: 33, lap_number: 4, source: 'jolpica', lap_ms: 93_000, s1_ms: null, filled: {} },
    ]);
    expect(await laps(SPRINT)).toEqual(sprint);
    expect(await laps(ARCH)).toEqual([
      {
        driver_number: 33,
        lap_number: 1,
        source: 'f1-archive',
        lap_ms: 90_000,
        s1_ms: 30_000,
        filled: { lap_ms: 'jolpica' },
      },
    ]);
    const stored = await admin
      .selectFrom('lap_source')
      .selectAll()
      .where('source', '=', 'jolpica')
      .orderBy('session_key')
      .orderBy('lap_number')
      .execute();
    expect(stored.map((c) => [c.session_key, c.driver_number, c.lap_number, c.lap_ms])).toEqual([
      [RACE, 33, 1, 90_000],
      [RACE, 33, 2, 91_000],
      [RACE, 33, 3, 92_000],
      [RACE, 33, 4, 93_000],
      [ARCH, 33, 1, 90_000],
    ]);
    // Every value but the lap time is null.
    for (const { session_key, source, driver_number, lap_number, lap_ms, ...rest } of stored)
      expect(Object.values(rest).every((v) => v === null)).toBe(true);

    expect(own('jolpica_attach').find((l) => l.session_key === RACE)).toMatchObject({
      year: 2018,
      round: 1,
      laps: 4,
      skipped: { unknown_driver: 2, no_number: 1, lap_dup: 0 },
      merge: { added: { jolpica: 1 }, dup: {}, filled: { jolpica: { lap_ms: 1 } }, conflicts: { jolpica: 1 } },
    });
    expect(own('jolpica_attach').find((l) => l.skip === 'no_match')).toMatchObject({ year: 2019, round: 2 });
    expect(own('jolpica_done').at(-1)).toMatchObject({
      imported: 0,
      failed: 0,
      attached: 2,
      no_match: 1,
      ambiguous: 0,
      no_laps: 1,
      unknown_driver: 2,
      stale_lap: 0,
    });
  });

  it('a rerun changes nothing', async () => {
    const before = await hashes(ALL);
    expect(await jolpica(deps(), args)).toBe(true);
    expect(await hashes(ALL)).toEqual(before);
  });

  it('a `lap` row without its own candidate leaves the session as it is and fails it (stale_lap)', async () => {
    await admin
      .insertInto('lap')
      .values({ session_key: RACE, source: 'openf1', driver_number: 5, lap_number: 2, lap_ms: 96_000 })
      .execute();
    const before = await hashes(ALL);
    const at = lines.length;
    expect(await jolpica(deps(), { ...args, years: [2018] })).toBe(false);
    expect(await hashes(ALL)).toEqual(before);
    const mine = lines.slice(at);
    expect(mine.filter((l) => l.msg === 'jolpica_attach')).toEqual([
      expect.objectContaining({ session_key: RACE, error: 'stale_lap', level: 50 }),
    ]);
    expect(mine.at(-1)).toMatchObject({ msg: 'jolpica_done', stale_lap: 1, failed: 1, attached: 0 });
    await admin
      .deleteFrom('lap')
      .where('session_key', '=', RACE)
      .where('lap_number', '=', 2)
      .where('driver_number', '=', 5)
      .execute();
  });

  // The 11353 shape (E6): OpenF1's lap 42 carries lap 43's time and lacks lap 43, so Jolpica's lap 43 repeats it.
  it('a Jolpica lap that repeats OpenF1 lap n − 1 is not added, and the TIME deletion stays on lap n − 1', async () => {
    const HOLE = 9803;
    await admin
      .insertInto('session')
      .values({
        session_key: HOLE,
        source: 'openf1',
        meeting_key: 9800,
        name: 'Race',
        type: 'Race',
        date_start: new Date('2018-04-08T06:10:00Z'),
        date_end: new Date('2018-04-08T08:10:00Z'),
      })
      .execute();
    await admin
      .insertInto('race_control')
      .values({
        session_key: HOLE,
        source: 'openf1',
        date: new Date('2018-04-08T07:00:00Z'),
        message: 'CAR 33 (XXX) TIME 1:31.500 DELETED - TRACK LIMITS AT TURN 4 LAP 43 07:00:00',
      })
      .execute();
    const lap = (lap_number: number, lap_ms: number) => ({ driver_number: 33, lap_number, lap_ms }) as never;
    const merge = await db.transaction().execute(async (trx) => {
      await writeLaps(trx, HOLE, 'openf1', [lap(41, 90_000), lap(42, 91_500), lap(44, 92_000)]);
      return writeLaps(trx, HOLE, 'jolpica', [lap(41, 90_000), lap(42, 91_000), lap(43, 91_500), lap(44, 92_000)]);
    });
    const rows = await admin
      .selectFrom('lap')
      .select(['lap_number', 'source', 'lap_ms', 'deleted'])
      .where('session_key', '=', HOLE)
      .orderBy('lap_number')
      .execute();
    expect(rows).toEqual([
      { lap_number: 41, source: 'openf1', lap_ms: 90_000, deleted: false },
      { lap_number: 42, source: 'openf1', lap_ms: 91_500, deleted: true },
      { lap_number: 44, source: 'openf1', lap_ms: 92_000, deleted: false },
    ]);
    expect(merge).toMatchObject({ added: {}, dup: { jolpica: 1 }, conflicts: { jolpica: 1 }, rules: { deleted: 1 } });
  });

  it('never logs a name, a time or a path', () => {
    const all = JSON.stringify(lines);
    for (const text of ['Grand Prix', 'Driver', 'Team', FIXTURES, '01:3', 'Synthetic', 'XXX'])
      expect(all).not.toContain(text);
  });
});
