import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SESSION_BYTES } from '../src/archive/files.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { replaceRows } from '../src/ingest/ingest.ts';
import { openRecording } from '../src/live/recording.ts';
import { run } from '../src/main.ts';
import { fill } from '../src/merge/fill.ts';
import { staleLap, writeLaps } from '../src/merge/write.ts';
import { createTestDb, type TestDb } from './db.ts';

// The fill job against a real PostgreSQL 18 (f1_ingest login). Every file is synthetic and built under a temp dir:
// the archive streams are fixtures/archive/race with its session Key changed, plus fixtures/archive/overtakes (its own
// folder, so the archive job's tests over race/ stay as they are), the recordings are fixtures/live/practice.jsonl
// written through openRecording.

const M = 9700;
const [OPENF1, BARE, ARCHIVED] = [9701, 9702, 9703];
const FIXTURES = join(import.meta.dirname, 'fixtures');
const T0 = Date.parse('2026-01-10T12:00:00Z');

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;
let root: string;
let archiveDir: string;
let liveDir: string;
const lines: Record<string, unknown>[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(JSON.parse(line)) });
const fills = () => lines.splice(0).filter((l) => l.msg === 'fill');
/** The one `fill` line of the run. */
const one = () => {
  const [line] = fills();
  return line ?? expect.fail('no fill line');
};

const args = (keys: number[] | 'all' = [OPENF1]) => ({ keys, archiveDir, liveDir });
const laps = (key: number) =>
  db
    .selectFrom('lap')
    .select(['driver_number', 'lap_number', 'source', 's1_ms', 'lap_ms', 'filled'])
    .where('session_key', '=', key)
    .orderBy('driver_number')
    .orderBy('lap_number')
    .execute();
const candidates = async (key: number) => {
  const rows = await db.selectFrom('lap_source').select('source').where('session_key', '=', key).execute();
  const n: Record<string, number> = {};
  for (const r of rows) n[r.source] = (n[r.source] ?? 0) + 1;
  return n;
};

/**
 * `<archiveDir>/<key>/`: the synthetic race streams and OvertakeSeries, with the session Key changed (unless
 * `sessionKey` is false).
 */
function archiveFiles(key: number, sessionKey = true) {
  const dir = join(archiveDir, String(key));
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(FIXTURES, 'archive/race'), dir, { recursive: true });
  cpSync(join(FIXTURES, 'archive/overtakes'), dir, { recursive: true });
  const info = join(dir, 'SessionInfo.jsonStream');
  if (sessionKey) writeFileSync(info, readFileSync(info, 'utf8').replace('"Key":9102', `"Key":${key}`));
  return dir;
}

/**
 * A recording of the synthetic practice feed as session `key`, sealed (gzip) through the real recorder. `pad`: the
 * size of an extra TimingStats line, a topic the parser does not read. `overtakes`: an OvertakeSeries line. `more`:
 * further lines, [topic, payload, F1 timestamp].
 */
async function record(
  key: number,
  path: string,
  session = key,
  pad = 0,
  overtakes?: Record<string, unknown>,
  more: readonly [string, unknown, string][] = [],
) {
  const rec = openRecording({ dir: join(liveDir, path), now: () => T0 });
  const feed = readFileSync(join(FIXTURES, 'live/practice.jsonl'), 'utf8').trim().split('\n');
  for (const [i, line] of feed.entries()) {
    const [, topic, payload, ts] = JSON.parse(line) as [number, string, Record<string, unknown>, string?];
    if (topic === '_subscribe') {
      const info = payload.SessionInfo as Record<string, unknown>;
      rec.feed(T0 + i * 50, 'SessionInfo', { ...info, Key: session }, 'undefined');
    } else rec.feed(T0 + i * 50, topic, payload, ts ?? 'undefined');
  }
  if (pad > 0) rec.feed(T0, 'TimingStats', { pad: 'x'.repeat(pad) }, 'undefined');
  if (overtakes) rec.feed(T0, 'OvertakeSeries', overtakes, 'undefined');
  for (const [topic, payload, ts] of more) rec.feed(T0, topic, payload, ts);
  await rec.finish();
  const { id } = await admin
    .insertInto('recording')
    .values({ session_key: key, path, started_at: new Date(T0), complete: false })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}
const complete = (id: string) =>
  admin
    .updateTable('recording')
    .set({ complete: true, ended_at: new Date(T0 + 1) })
    .where('id', '=', id)
    .execute();

describe('the fill job (f1_ingest login, synthetic files)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'f1-fill-'));
    [archiveDir, liveDir] = [join(root, 'archive'), join(root, 'live')];
    mkdirSync(archiveDir);
    mkdirSync(liveDir);
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
    await admin
      .insertInto('meeting')
      .values({ meeting_key: M, source: 'openf1', year: 2026, name: 'Synthetic' })
      .execute();
    const session = (session_key: number, source: string, day: number) => ({
      session_key,
      source,
      meeting_key: M,
      name: 'Race',
      type: 'Race',
      date_start: new Date(T0 + day * 86_400_000),
      date_end: new Date(T0 + day * 86_400_000 + 3_600_000),
    });
    await admin
      .insertInto('session')
      .values([session(OPENF1, 'openf1', 1), session(BARE, 'openf1', 2), session(ARCHIVED, 'f1-archive', 3)])
      .execute();
    // OpenF1's own laps. Driver 3 lap 2 lacks the first sector, which the archive's lap has (and agrees on the rest).
    await db.transaction().execute(async (trx) => {
      const lap = (driver_number: number, lap_number: number, v: object) => ({ driver_number, lap_number, ...v });
      await writeLaps(trx, OPENF1, 'openf1', [
        lap(3, 2, { lap_ms: 92_000, s2_ms: 33_900, s3_ms: 28_300 }) as never,
        lap(40, 1, { lap_ms: 100_000 }) as never,
      ]);
      await writeLaps(trx, BARE, 'openf1', [lap(40, 1, { lap_ms: 100_000 }) as never]);
      await writeLaps(trx, ARCHIVED, 'f1-archive', [lap(40, 1, { lap_ms: 100_000 }) as never]);
    });
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('a session without files is re-merged unchanged', async () => {
    const before = await laps(BARE);
    expect(await fill({ db, log }, args([BARE]))).toBe(true);
    const line = one();
    expect(line).toMatchObject({ session_key: BARE, sources: {}, merge: { rows: 1 } });
    expect(line).not.toHaveProperty('recording');
    expect(await laps(BARE)).toEqual(before);
    expect(await candidates(BARE)).toEqual({ openf1: 1 });
  });

  it('an unknown session fails, the others go on', async () => {
    expect(await fill({ db, log }, args([1, BARE]))).toBe(false);
    expect(fills().map((l) => [l.session_key, l.error, l.level])).toEqual([
      [1, 'unknown_session', 50],
      [BARE, undefined, 30],
    ]);
  });

  it('the archive streams fill a value OpenF1 lacks and add the laps it lacks, marked', async () => {
    archiveFiles(OPENF1);
    expect(await fill({ db, log }, args())).toBe(true);
    const line = one();
    expect(line.sources).toEqual({ 'f1-archive': expect.any(Number) });
    expect(line.merge).toMatchObject({ filled: { 'f1-archive': { s1_ms: 1 } }, conflicts: {} });
    const rows = await laps(OPENF1);
    expect(rows.find((r) => r.driver_number === 3 && r.lap_number === 2)).toMatchObject({
      source: 'openf1',
      s1_ms: 29_800,
      lap_ms: 92_000,
      filled: { s1_ms: 'f1-archive' },
    });
    expect(rows.find((r) => r.driver_number === 40)).toMatchObject({ source: 'openf1', filled: {} });
    expect(rows.find((r) => r.driver_number === 8)).toMatchObject({ source: 'f1-archive', filled: {} }); // an added lap
    expect(Object.keys(await candidates(OPENF1)).sort()).toEqual(['f1-archive', 'openf1']);
  });

  it('only a complete recording contributes f1-live candidates, the earliest one', async () => {
    const early = await record(OPENF1, `${OPENF1}-1`);
    await fill({ db, log }, args());
    expect(one()).not.toHaveProperty('recording'); // incomplete: ignored
    expect(await candidates(OPENF1)).not.toHaveProperty('f1-live');

    await complete(early);
    // A later complete recording, whose directory is missing: read first, it would be a failure.
    await admin
      .insertInto('recording')
      .values({ session_key: OPENF1, path: `${OPENF1}-2`, started_at: new Date(T0 + 1000), complete: true })
      .execute();
    expect(await fill({ db, log }, args())).toBe(true);
    const line = one();
    expect(line).toMatchObject({ recording: Number(early), sources: { 'f1-live': expect.any(Number) } });
    expect(line.sources).toHaveProperty('f1-archive'); // the archive streams are still there
    const rows = await laps(OPENF1);
    expect(rows.filter((r) => r.source === 'f1-live').map((r) => r.driver_number)).toContain(7);
    expect((await candidates(OPENF1))['f1-live']).toBeGreaterThan(0);
    // After a merge every `lap` row has its base candidate, so fill's guard has no false positive.
    expect(await db.transaction().execute((trx) => staleLap(trx, OPENF1))).toBe(false);
  });

  it('a recording of another session fails that session and keeps its candidates', async () => {
    const before = await candidates(BARE);
    await complete(await record(BARE, `${BARE}-1`, OPENF1));
    expect(await fill({ db, log }, args([BARE]))).toBe(false);
    expect(one()).toMatchObject({
      session_key: BARE,
      level: 50,
      errors: { 'f1-live': 'key_mismatch' },
      merge: { rows: 1 },
    });
    expect(await candidates(BARE)).toEqual(before);
  });

  it('an archive-source session gets no file candidates', async () => {
    archiveFiles(ARCHIVED);
    await complete(await record(ARCHIVED, `${ARCHIVED}-1`));
    const before = await laps(ARCHIVED);
    expect(await fill({ db, log }, args([ARCHIVED]))).toBe(true);
    const line = one();
    expect(line).toMatchObject({ session_key: ARCHIVED, sources: {} });
    expect(line).not.toHaveProperty('overtakes'); // nor overtakes
    expect(await candidates(ARCHIVED)).toEqual({ 'f1-archive': 1 });
    expect(await laps(ARCHIVED)).toEqual(before);
  });

  it('--all goes through every session but the jolpica ones, newest first, and counts the failures', async () => {
    await admin
      .insertInto('session')
      .values({
        session_key: 9709,
        source: 'jolpica',
        meeting_key: M,
        date_start: new Date(T0 + 4 * 86_400_000),
        date_end: new Date(T0 + 4 * 86_400_000 + 3_600_000),
      })
      .execute(); // the newest, but never filled
    expect(await fill({ db, log }, args('all'))).toBe(false); // BARE's recording is another session's
    const all = lines.splice(0);
    expect(all.filter((l) => l.msg === 'fill').map((l) => l.session_key)).toEqual([ARCHIVED, BARE, OPENF1]);
    expect(all.at(-1)).toMatchObject({ msg: 'fill_done', sessions: 3, failed: 1 });
  });

  describe('overtakes (#236)', () => {
    const KEY = 9706;
    const PRACTICE = 9707;
    // The fixtures' entries are of 2019-03-17 05:10 on; the session starts at 05:00 (S3: entries from an hour before).
    const RACE_START = Date.parse('2019-03-17T05:00:00Z');
    const series = { Overtakes: { 44: [{ Timestamp: '2019-03-17T05:10:01.000', count: 3 }] } };
    const put = (key: number, body: string) =>
      writeFileSync(join(archiveDir, String(key), 'OvertakeSeries.jsonStream'), `\ufeff00:00:01.000${body}\r\n`);
    const overtakesOf = (key: number) =>
      db
        .selectFrom('overtake')
        .select(['driver_number', 'date', 'places', 'source'])
        .where('session_key', '=', key)
        .orderBy('date')
        .orderBy('driver_number')
        .orderBy('id')
        .execute();
    const overtakes = () => overtakesOf(KEY);
    // fixtures/archive/overtakes/OvertakeSeries.jsonStream: its third line holds only entries to drop.
    const archived = [
      { driver_number: 8, date: new Date('2019-03-17T05:10:05Z'), places: 1, source: 'f1-archive' },
      { driver_number: 3, date: new Date('2019-03-17T05:12:10Z'), places: 2, source: 'f1-archive' },
      { driver_number: 8, date: new Date('2019-03-17T05:12:10Z'), places: 1, source: 'f1-archive' },
    ];
    beforeAll(async () => {
      await admin
        .insertInto('session')
        .values({
          session_key: KEY,
          source: 'openf1',
          meeting_key: M,
          name: 'Race',
          type: 'Race',
          date_start: new Date(RACE_START),
          date_end: new Date(RACE_START + 7_200_000),
        })
        .execute();
    });

    it("the archive's file gives the rows, its bad entries dropped, and a second fill replaces them", async () => {
      archiveFiles(KEY);
      for (let i = 0; i < 2; i++) {
        expect(await fill({ db, log }, args([KEY]))).toBe(true);
        expect(one().overtakes).toEqual({ source: 'f1-archive', rows: 3 });
        expect(await overtakes()).toEqual(archived);
      }
    });

    it('without the file and without a recording that has the topic, the stored rows stay', async () => {
      rmSync(join(archiveDir, String(KEY), 'OvertakeSeries.jsonStream'));
      await complete(await record(KEY, `${KEY}-1`));
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      const line = one();
      expect(line.sources).toEqual({ 'f1-archive': expect.any(Number), 'f1-live': expect.any(Number) });
      expect(line).not.toHaveProperty('overtakes');
      expect(await overtakes()).toEqual(archived);
    });

    it("the recording's entries when the archive has no file, the archive's again once it has", async () => {
      await admin.deleteFrom('recording').where('session_key', '=', KEY).execute();
      await complete(await record(KEY, `${KEY}-2`, KEY, 0, series));
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one().overtakes).toEqual({ source: 'f1-live', rows: 1 });
      expect(await overtakes()).toEqual([
        { driver_number: 44, date: new Date(RACE_START + 601_000), places: 3, source: 'f1-live' },
      ]);
      archiveFiles(KEY);
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one().overtakes).toEqual({ source: 'f1-archive', rows: 3 });
      expect(await overtakes()).toEqual(archived);
    });

    it('an archive that failed leaves the stored rows: the recording does not replace them (S2)', async () => {
      archiveFiles(KEY, false); // another session's Key: key_mismatch
      expect(await fill({ db, log }, args([KEY]))).toBe(false);
      expect(one()).toMatchObject({
        errors: { 'f1-archive': 'key_mismatch' },
        sources: { 'f1-live': expect.any(Number) },
      });
      expect(await overtakes()).toEqual(archived);
    });

    it('a file with no valid entry is absent: the recording supplies the rows, else the stored rows stay (S1)', async () => {
      archiveFiles(KEY);
      put(KEY, '{"Overtakes":{}}');
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one().overtakes).toEqual({ source: 'f1-live', rows: 1 });
      const stored = await overtakes();
      expect(stored).toEqual([
        { driver_number: 44, date: new Date(RACE_START + 601_000), places: 3, source: 'f1-live' },
      ]);
      await admin.deleteFrom('recording').where('session_key', '=', KEY).execute();
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one()).not.toHaveProperty('overtakes');
      expect(await overtakes()).toEqual(stored);
    });

    it('only entries from an hour before date_start on are kept (S3)', async () => {
      archiveFiles(KEY);
      put(
        KEY,
        JSON.stringify({
          Overtakes: {
            1: [{ Timestamp: '2019-03-16T05:10:00.000Z', count: 1 }],
            2: [{ Timestamp: '2019-03-17T03:59:59.000Z', count: 1 }],
            3: [{ Timestamp: '2019-03-17T04:00:00.000Z', count: 2 }],
          },
        }),
      );
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one().overtakes).toEqual({ source: 'f1-archive', rows: 1 });
      expect(await overtakes()).toEqual([
        { driver_number: 3, date: new Date('2019-03-17T04:00:00Z'), places: 2, source: 'f1-archive' },
      ]);
    });

    it('a session that is no race gets no rows, file or not (S3)', async () => {
      await admin
        .insertInto('session')
        .values({
          session_key: PRACTICE,
          source: 'openf1',
          meeting_key: M,
          name: 'Practice 1',
          type: 'Practice',
          date_start: new Date(RACE_START),
          date_end: new Date(RACE_START + 3_600_000),
        })
        .execute();
      archiveFiles(PRACTICE);
      expect(await fill({ db, log }, args([PRACTICE]))).toBe(true);
      expect(one()).not.toHaveProperty('overtakes');
      expect(await overtakesOf(PRACTICE)).toEqual([]);
    });
  });

  describe('pits (#219)', () => {
    const KEY = 9708;
    // fixtures/archive/pits on the race's t0: 8/2 a stop (PLTC + PSS), 3/3 a pass, a stale entry and two bad ones.
    const START = Date.parse('2019-03-17T05:10:00Z');
    // OpenF1's rows: 8/2 without a stop time, its date 2 s and its lane 88 ms off the feed's; 44/10 OpenF1's alone.
    const OPENF1_PITS = [
      {
        driver_number: 8,
        lap_number: 2,
        date: '2019-03-17T05:13:42.300Z',
        pit_ms: 45_400,
        lane_ms: 45_400,
        stop_ms: null,
      },
      {
        driver_number: 44,
        lap_number: 10,
        date: '2019-03-17T05:30:00Z',
        pit_ms: 22_000,
        lane_ms: 22_000,
        stop_ms: 2500,
      },
    ].map((p) => ({ ...p, session_key: KEY, source: 'openf1' }));
    const none = { driver: [], lap: [], stint: [], race_control: [], result: [], weather: [] };
    /** OpenF1's rows through the ingest's own write path. */
    const ingest = () => db.transaction().execute((trx) => replaceRows(trx, KEY, { ...none, pit: OPENF1_PITS }));
    const pits = () =>
      db
        .selectFrom('pit')
        .select(['driver_number', 'lap_number', 'source', 'date', 'pit_ms', 'lane_ms', 'stop_ms', 'filled'])
        .where('session_key', '=', KEY)
        .orderBy('driver_number')
        .orderBy('lap_number')
        .execute();
    const hash = async () =>
      (
        await sql<{ h: string }>`SELECT md5(string_agg(to_jsonb(p)::text, ',' ORDER BY to_jsonb(p)::text)) AS h
          FROM pit p WHERE session_key = ${KEY}`.execute(admin)
      ).rows[0]?.h;
    const MERGED = [
      {
        driver_number: 3,
        lap_number: 3,
        source: 'f1-archive',
        date: new Date('2019-03-17T05:14:30Z'),
        pit_ms: null,
        lane_ms: 21_600,
        stop_ms: null,
        filled: {},
      },
      {
        driver_number: 8,
        lap_number: 2,
        source: 'f1-archive',
        date: new Date('2019-03-17T05:13:40.300Z'),
        pit_ms: 45_400,
        lane_ms: 45_312,
        stop_ms: 2400,
        filled: { pit_ms: 'openf1' },
      },
      {
        driver_number: 44,
        lap_number: 10,
        source: 'openf1',
        date: new Date('2019-03-17T05:30:00Z'),
        pit_ms: 22_000,
        lane_ms: 22_000,
        stop_ms: 2500,
        filled: {},
      },
    ];
    beforeAll(async () => {
      await admin
        .insertInto('session')
        .values({
          session_key: KEY,
          source: 'openf1',
          meeting_key: M,
          name: 'Race',
          type: 'Race',
          date_start: new Date(START),
          date_end: new Date(START + 7_200_000),
        })
        .execute();
      await ingest();
    });

    it("the archive's pit-lane topics give the stop time OpenF1 lacks; the feed's lane and date win, OpenF1's fill is marked", async () => {
      cpSync(join(FIXTURES, 'archive/pits'), archiveFiles(KEY), { recursive: true });
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      const line = one();
      expect(line.pits).toEqual({ 'f1-archive': 2 });
      expect(line.pit_skipped).toEqual({ 'f1-archive': 2 }); // the fixture's two bad entries, counted
      expect(line.pit_merge).toEqual({
        rows: 3,
        added: { openf1: 1 },
        filled: { openf1: { pit_ms: 1 } },
        diffs: { openf1: { date: 1, lane_ms: 1 } },
      });
      expect(await pits()).toEqual(MERGED);
    });

    it('a second fill changes nothing, and neither does an OpenF1 rewrite through the ingest: the fills stay', async () => {
      const before = await hash();
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      expect(one().pits).toEqual({ 'f1-archive': 2 });
      expect(await hash()).toBe(before);
      expect((await ingest()).pits).toMatchObject({ rows: 3, filled: { openf1: { pit_ms: 1 } } });
      expect(await hash()).toBe(before);
      expect(await pits()).toEqual(MERGED);
    });

    it('an archive without the pit-lane topics is absent for the pits: the stored candidates stay', async () => {
      const before = await hash();
      for (const t of ['PitLaneTimeCollection', 'PitStopSeries'])
        rmSync(join(archiveDir, String(KEY), `${t}.jsonStream`));
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      const line = one();
      expect(line.sources).toEqual({ 'f1-archive': expect.any(Number) }); // its laps still read
      expect(line.pits).toEqual({});
      expect(line).not.toHaveProperty('pit_merge');
      expect(await hash()).toBe(before);
    });

    it("a recording's entries are f1-live candidates under the archive's: a row of its own, no value over the archive's", async () => {
      cpSync(join(FIXTURES, 'archive/pits'), join(archiveDir, String(KEY)), { recursive: true });
      const entries = {
        PitTimes: {
          8: { RacingNumber: '8', Lap: '2', Duration: '45.0' },
          16: { RacingNumber: '16', Lap: '5', Duration: '23.0' },
        },
      };
      const id = await record(KEY, `${KEY}-1`, KEY, 0, undefined, [
        ['PitLaneTimeCollection', entries, '2019-03-17T05:20:00.000Z'],
      ]);
      await complete(id);
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      const line = one();
      expect(line.pits).toEqual({ 'f1-archive': 2, 'f1-live': 2 });
      expect(line.pit_merge).toMatchObject({
        rows: 4,
        added: { openf1: 1, 'f1-live': 1 },
        diffs: { openf1: { date: 1, lane_ms: 1 }, 'f1-live': { date: 1, lane_ms: 1 } },
      });
      const rows = await pits();
      expect(rows.filter((r) => r.driver_number !== 16)).toEqual(MERGED);
      expect(rows.find((r) => r.driver_number === 16)).toEqual({
        driver_number: 16,
        lap_number: 5,
        source: 'f1-live',
        date: new Date('2019-03-17T05:20:00Z'),
        pit_ms: null,
        lane_ms: 23_000,
        stop_ms: null,
        filled: {},
      });
    });
  });

  describe('pits from a recording alone (#219)', () => {
    const KEY = 9710;
    const OTHER = 9799;
    const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
    it("a recording's PitStopSeries gives the stop time, only its own session's lines are read, a bad entry is counted", async () => {
      await admin
        .insertInto('session')
        .values({
          session_key: KEY,
          source: 'openf1',
          meeting_key: M,
          name: 'Race',
          type: 'Race',
          date_start: new Date(T0),
          date_end: new Date(T0 + 3_600_000),
        })
        .execute();
      const none = { driver: [], lap: [], stint: [], race_control: [], result: [], weather: [] };
      const openf1 = {
        driver_number: 8,
        lap_number: 2,
        date: at(20, 2),
        pit_ms: 45_400,
        lane_ms: 45_400,
        stop_ms: null,
      };
      await db
        .transaction()
        .execute((trx) => replaceRows(trx, KEY, { ...none, pit: [{ ...openf1, session_key: KEY, source: 'openf1' }] }));
      const stop = {
        Timestamp: at(20, 1),
        PitStop: { RacingNumber: '8', Lap: '2', PitLaneTime: '45.312', PitStopTime: '2.4' },
      };
      // The feed joins another session's state first: its entries lie inside the date window too.
      const id = await record(KEY, `${KEY}-1`, KEY, 0, undefined, [
        ['SessionInfo', { Key: OTHER }, at(10)],
        ['PitLaneTimeCollection', { PitTimes: { 16: { RacingNumber: '16', Lap: '5', Duration: '23.0' } } }, at(10)],
        [
          'PitStopSeries',
          { PitTimes: { 16: [{ Timestamp: at(10), PitStop: { RacingNumber: '16', Lap: '5', PitStopTime: '2.0' } }] } },
          at(10),
        ],
        ['SessionInfo', { Key: KEY }, at(15)],
        [
          'PitLaneTimeCollection',
          { PitTimes: { 8: { RacingNumber: '8', Lap: '2', Duration: '45.0' }, x: { RacingNumber: 'x', Lap: '3' } } },
          at(20),
        ],
        ['PitStopSeries', { PitTimes: { 8: [stop] } }, at(20, 1)],
      ]);
      await complete(id);
      expect(await fill({ db, log }, args([KEY]))).toBe(true);
      const line = one();
      expect(line.pits).toEqual({ 'f1-live': 1 });
      expect(line.pit_skipped).toEqual({ 'f1-live': 1 });
      expect(
        await db
          .selectFrom('pit')
          .select(['driver_number', 'lap_number', 'source', 'date', 'pit_ms', 'lane_ms', 'stop_ms', 'filled'])
          .where('session_key', '=', KEY)
          .execute(),
      ).toEqual([
        {
          driver_number: 8,
          lap_number: 2,
          source: 'f1-live',
          date: new Date(at(20)),
          pit_ms: 45_400,
          lane_ms: 45_312,
          stop_ms: 2400,
          filled: { pit_ms: 'openf1' },
        },
      ]);
    });
  });

  describe('per source', () => {
    const FAULTY = 9704;
    const OLD = 9705;
    let dir: string;
    beforeAll(async () => {
      const session = (session_key: number) => ({
        session_key,
        source: 'openf1',
        meeting_key: M,
        name: 'Race',
        type: 'Race',
        date_start: new Date(T0 - 86_400_000),
        date_end: new Date(T0 - 82_800_000),
      });
      await admin
        .insertInto('session')
        .values([session(FAULTY), session(OLD)])
        .execute();
      await db.transaction().execute(async (trx) => {
        const lap = { driver_number: 40, lap_number: 1, lap_ms: 100_000 } as never;
        await writeLaps(trx, FAULTY, 'openf1', [lap]);
        await writeLaps(trx, FAULTY, 'f1-archive', [lap]);
      });
      // A `lap` row without candidates, as an image before P3b leaves it.
      await admin
        .insertInto('lap')
        .values({ session_key: OLD, source: 'openf1', driver_number: 40, lap_number: 1, lap_ms: 100_000 })
        .execute();
    });
    const faulty = (maxBytes = MAX_SESSION_BYTES) => fill({ db, log, maxBytes }, args([FAULTY]));

    it('an archive without SessionInfo or TimingData, or without a t0, is absent: the stored candidates stay', async () => {
      for (const gone of [['SessionInfo'], ['TimingData'], ['Heartbeat', 'SessionData']]) {
        dir = archiveFiles(FAULTY);
        for (const t of gone) rmSync(join(dir, `${t}.jsonStream`));
        expect(await faulty()).toBe(true);
        expect(one()).toMatchObject({ session_key: FAULTY, sources: {}, errors: {}, merge: { rows: 1 } });
        expect(await candidates(FAULTY)).toEqual({ openf1: 1, 'f1-archive': 1 });
      }
    });

    it('an archive on the Heartbeat t0 is skipped: t0_heartbeat', async () => {
      dir = archiveFiles(FAULTY);
      rmSync(join(dir, 'SessionData.jsonStream'));
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({ level: 50, sources: {}, errors: { 'f1-archive': 't0_heartbeat' } });
      expect(await candidates(FAULTY)).toEqual({ openf1: 1, 'f1-archive': 1 });
    });

    it('only the parsed topics count towards the cap, each a regular file', async () => {
      dir = archiveFiles(FAULTY);
      writeFileSync(join(dir, 'Position.z.jsonStream'), '');
      truncateSync(join(dir, 'Position.z.jsonStream'), MAX_SESSION_BYTES + 1); // sparse: no disk use
      expect(await faulty()).toBe(true);
      expect(one().sources).toEqual({ 'f1-archive': expect.any(Number) });
      const before = await candidates(FAULTY);

      truncateSync(join(dir, 'WeatherData.jsonStream'), MAX_SESSION_BYTES + 1);
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({ sources: {}, errors: { 'f1-archive': 'too_large' } });

      rmSync(join(dir, 'WeatherData.jsonStream'));
      symlinkSync(join(FIXTURES, 'archive/race/WeatherData.jsonStream'), join(dir, 'WeatherData.jsonStream'));
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({ sources: {}, errors: { 'f1-archive': 'not_file' } });
      expect(await candidates(FAULTY)).toEqual(before);
    });

    it('an archive of another session fails that source only: the recording is stored and the session merged', async () => {
      const before = await candidates(FAULTY);
      archiveFiles(FAULTY, false);
      const id = await record(FAULTY, `${FAULTY}-1`, FAULTY, 50_000);
      await complete(id);
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({
        level: 50,
        recording: Number(id),
        sources: { 'f1-live': expect.any(Number) },
        errors: { 'f1-archive': 'key_mismatch' },
      });
      expect(await candidates(FAULTY)).toEqual({ ...before, 'f1-live': expect.any(Number) });
      expect((await laps(FAULTY)).some((r) => r.source === 'f1-live')).toBe(true);
    });

    it('a recording past the cap is too_large; only the parsed topics count', async () => {
      rmSync(join(archiveDir, String(FAULTY)), { recursive: true });
      const before = await candidates(FAULTY);
      expect(await faulty(40_000)).toBe(true); // the 50 kB TimingStats line does not count
      expect(one().sources).toEqual({ 'f1-live': expect.any(Number) });
      expect(await faulty(1_000)).toBe(false);
      expect(one()).toMatchObject({ sources: {}, errors: { 'f1-live': 'too_large' } });
      expect(await candidates(FAULTY)).toEqual(before);
    });

    it('a complete recording without its directory is recording_missing, without a sealed segment incomplete', async () => {
      const before = await candidates(FAULTY);
      const id = await admin
        .insertInto('recording')
        .values({ session_key: FAULTY, path: `${FAULTY}-0`, started_at: new Date(T0 - 1000), complete: true })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({
        recording: Number(id.id),
        sources: {},
        errors: { 'f1-live': 'recording_missing' },
      });
      mkdirSync(join(liveDir, `${FAULTY}-0`));
      expect(await faulty()).toBe(false);
      expect(one()).toMatchObject({ sources: {}, errors: { 'f1-live': 'incomplete' } });
      expect(await candidates(FAULTY)).toEqual(before);
    });

    it('a `lap` row without its own candidate leaves the session as it is: stale_lap, files or not', async () => {
      const before = await laps(OLD);
      expect(before).toHaveLength(1);
      expect(await fill({ db, log }, args([OLD]))).toBe(false);
      expect(one()).toMatchObject({ session_key: OLD, level: 50, error: 'stale_lap' });
      archiveFiles(OLD);
      await complete(await record(OLD, `${OLD}-1`));
      expect(await fill({ db, log }, args([OLD]))).toBe(false);
      expect(one()).toMatchObject({ session_key: OLD, level: 50, error: 'stale_lap' });
      expect(await laps(OLD)).toEqual(before);
      expect(await candidates(OLD)).toEqual({});
      expect(await admin.selectFrom('overtake').select('id').where('session_key', '=', OLD).execute()).toEqual([]);
      expect(
        await run(['fill', String(OLD)], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_ingest }, () => {}),
      ).toBe(1);
    });
  });

  it('the fill role: exit 0, and 1 for an unknown session', async () => {
    const env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_ingest };
    expect(await run(['fill', String(ARCHIVED)], env, () => {})).toBe(0);
    expect(await run(['fill', '1'], env, () => {})).toBe(1);
  });
});
