import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Insertable, type Kysely, sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { type Deps, processSession, syncSchedule } from '../src/ingest/ingest.ts';
import { run } from '../src/main.ts';
import { writeLaps } from '../src/merge/write.ts';
import { type Clock, createClient, OPENF1 } from '../src/openf1/client.ts';
import { createTestDb, type TestDb } from './db.ts';

// P3b against a real PostgreSQL 18, logged in as f1_ingest: the Singapore race (11388) from the P1a fixtures (msw),
// then synthetic f1-archive candidates through writeLaps, then an OpenF1 refetch. Expected values are literals read
// off laps-normal.raw and race_control-normal.raw.

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const KEY = 11388;
const fixture = (name: string) =>
  new HttpResponse(readFileSync(join(FIXTURES, `${name}.raw`), 'utf8'), {
    headers: { 'content-type': 'application/json' },
  });

let virtual = 0;
const clock: Clock = {
  now: () => virtual,
  sleep: async (ms) => {
    virtual += ms;
  },
};
/** OpenF1 from the fixtures (msw resets its handlers after each test); only 2026 and 11388 are asked for. */
const openf1 = () =>
  server.use(
    http.get(`${OPENF1}/:endpoint`, ({ params, request }) =>
      fixture(`${params.endpoint}-${new URL(request.url).searchParams.has('year') ? 'year' : 'normal'}`),
    ),
  );
const lines: string[] = [];
const lastSession = () => lines.map((l) => JSON.parse(l)).findLast((l) => l.msg === 'session');

let testDb: TestDb;
let db: Kysely<DB>;
let deps: Deps;

// 23/55: OpenF1's s1 is null (its lap and the other sectors match). 16/22: a lap time 500 ms off (a conflict), with an
// i1 that OpenF1 lacks. 16/36: OpenF1 lacks the lap; its time is the one "CAR 16 … TIME 1:37.138 DELETED … LAP 36" names.
const archive = (driver_number: number, lap_number: number, values: Partial<Insertable<DB['lap']>>) => ({
  session_key: KEY,
  source: 'f1-archive',
  driver_number,
  lap_number,
  ...values,
});
const CANDIDATES = [
  archive(23, 55, { lap_ms: 98_385, s1_ms: 29_034, s2_ms: 41_644, s3_ms: 27_707, is_pit_in: true, deleted: true }),
  archive(16, 22, { lap_ms: 98_778, i1_kph: 280 }),
  archive(16, 36, { lap_ms: 97_138, date_start: '2026-10-11T13:01:33.910Z', is_pit_out: false }),
];
const MERGED = [
  {
    driver_number: 16,
    lap_number: 22,
    source: 'openf1',
    lap_ms: 98_278,
    s1_ms: 29_007,
    i1_kph: null,
    deleted: false,
    deleted_reason: null,
    filled: {},
  },
  {
    driver_number: 16,
    lap_number: 36,
    source: 'f1-archive',
    lap_ms: 97_138,
    s1_ms: null,
    i1_kph: null,
    deleted: true,
    deleted_reason: 'TRACK LIMITS AT TURN 2',
    filled: {},
  },
  {
    driver_number: 23,
    lap_number: 55,
    source: 'openf1',
    lap_ms: 98_385,
    s1_ms: 29_034,
    i1_kph: 296,
    deleted: false,
    deleted_reason: null,
    filled: { s1_ms: 'f1-archive' },
  },
];
const ARCHIVE_COUNTS = {
  rows: 63,
  added: { 'f1-archive': 1 },
  dup: {},
  filled: { 'f1-archive': { s1_ms: 1 } },
  diffs: { 'f1-archive': { lap_ms: 1 } },
  conflicts: { 'f1-archive': 1 },
};

const merged = () =>
  db
    .selectFrom('lap')
    .select([
      'driver_number',
      'lap_number',
      'source',
      'lap_ms',
      's1_ms',
      'i1_kph',
      'deleted',
      'deleted_reason',
      'filled',
    ])
    .where('session_key', '=', KEY)
    .where((eb) =>
      eb.or(
        CANDIDATES.map((c) => eb.and([eb('driver_number', '=', c.driver_number), eb('lap_number', '=', c.lap_number)])),
      ),
    )
    .orderBy('driver_number')
    .orderBy('lap_number')
    .execute();
const perSource = async () =>
  Object.fromEntries(
    (
      await sql<{ source: string; n: string }>`
        SELECT source, count(*) AS n FROM lap_source WHERE session_key = ${KEY} GROUP BY source`.execute(db)
    ).rows.map((r) => [r.source, Number(r.n)]),
  );
const laps = async () =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM lap WHERE session_key = ${KEY}`.execute(db)).rows[0]?.n);

describe('the lap merge (11388 through msw, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    db = createDb(testDb.urls.f1_ingest);
    const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });
    // Outside every live window of the 2026 schedule, so a refetch runs.
    deps = { db, client: createClient({ clock }), now: () => new Date('2026-10-26T00:00:00Z'), log, beat: () => {} };
  });
  afterAll(async () => {
    await db?.destroy();
    await testDb?.drop();
  });

  it('the ingest writes its laps as openf1 candidates and merges them to themselves', async () => {
    openf1();
    expect(await syncSchedule(deps, [2026])).toBe(true);
    expect((await processSession(deps, KEY)).ok).toBe(true);
    const line = lastSession();
    expect(line.merge).toEqual({
      rows: 62,
      added: {},
      dup: {},
      filled: {},
      diffs: {},
      conflicts: {},
      rules: line.rules,
    });
    expect(line.merge.rules.unmatched).toBeGreaterThan(0);
    expect(await perSource()).toEqual({ openf1: 62 });
    expect((await merged()).map((r) => [r.lap_number, r.source, r.filled])).toEqual([
      [22, 'openf1', {}],
      [55, 'openf1', {}],
    ]);
  });

  it('f1-archive candidates fill a null, skip a conflicting lap and add a lap, which a TIME ruling now deletes', async () => {
    const { rules } = lastSession();
    const counts = await db.transaction().execute((trx) => writeLaps(trx, KEY, 'f1-archive', CANDIDATES));
    expect(counts).toEqual({
      ...ARCHIVE_COUNTS,
      rules: { ...rules, deleted: rules.deleted + 1, unmatched: rules.unmatched - 1 },
    });
    expect(await merged()).toEqual(MERGED);
    expect(await laps()).toBe(63);
    // Only the lap_source columns: the candidates' is_pit_in and deleted are not stored, and were derived again.
    expect(await perSource()).toEqual({ openf1: 62, 'f1-archive': 3 });
  });

  it('an OpenF1 refetch replaces its own candidates only: the fills, the added lap and `filled` stay', async () => {
    openf1();
    expect(await processSession(deps, KEY, true)).toEqual({ ok: true, value: 'final' });
    expect(lastSession().merge).toMatchObject(ARCHIVE_COUNTS);
    expect(await merged()).toEqual(MERGED);
    expect(await laps()).toBe(63);
    expect(await perSource()).toEqual({ openf1: 62, 'f1-archive': 3 });
  });

  it("a writer with no laps and no other candidates deletes the session's laps (`stale_lap` is fill's guard only)", async () => {
    await db.transaction().execute((trx) => writeLaps(trx, KEY, 'f1-archive', []));
    expect(await laps()).toBe(62);
    const counts = await db.transaction().execute((trx) => writeLaps(trx, KEY, 'openf1', []));
    expect(counts).toMatchObject({ rows: 0 });
    expect(await laps()).toBe(0);
    expect(await perSource()).toEqual({});
  });

  it('race control is read with its ms: rulings within one second go by time, not by id', async () => {
    // Inserted DELETED (.900) first, REINSTATED (.100) second: by time the reinstatement finds no deleted lap, so the
    // lap stays deleted; with the ms dropped, id order would reinstate it.
    const rc = (date: string, message: string) => ({ session_key: KEY, source: 'openf1', date, message });
    await db
      .insertInto('race_control')
      .values(rc('2026-10-11T14:00:00.900Z', 'CAR 99 (XXX) TIME 1:30.000 DELETED - TRACK LIMITS AT TURN 1'))
      .execute();
    await db
      .insertInto('race_control')
      .values(rc('2026-10-11T14:00:00.100Z', 'CAR 99 (XXX) TIME 1:30.000 WILL BE REINSTATED'))
      .execute();
    const lap = { driver_number: 99, lap_number: 5, lap_ms: 90_000 } as Insertable<DB['lap']>;
    await db.transaction().execute((trx) => writeLaps(trx, KEY, 'openf1', [lap]));
    expect(await db.selectFrom('lap').select(['deleted']).where('session_key', '=', KEY).execute()).toEqual([
      { deleted: true },
    ]);
  });
});
