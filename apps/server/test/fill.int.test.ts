import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { openRecording } from '../src/live/recording.ts';
import { run } from '../src/main.ts';
import { fill } from '../src/merge/fill.ts';
import { writeLaps } from '../src/merge/write.ts';
import { createTestDb, type TestDb } from './db.ts';

// The fill job against a real PostgreSQL 18 (f1_ingest login). Every file is synthetic and built under a temp dir:
// the archive streams are fixtures/archive/race with its session Key changed, the recordings are fixtures/live/
// practice.jsonl written through openRecording.

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

/** `<archiveDir>/<key>/`: the synthetic race streams with the session Key changed. */
function archiveFiles(key: number) {
  const dir = join(archiveDir, String(key));
  cpSync(join(FIXTURES, 'archive/race'), dir, { recursive: true });
  const info = join(dir, 'SessionInfo.jsonStream');
  writeFileSync(info, readFileSync(info, 'utf8').replace('"Key":9102', `"Key":${key}`));
}

/** A recording of the synthetic practice feed as session `key`, sealed (gzip) through the real recorder. */
async function record(key: number, path: string, session = key) {
  const rec = openRecording({ dir: join(liveDir, path), now: () => T0, snapshotMs: 3_600_000 });
  const feed = readFileSync(join(FIXTURES, 'live/practice.jsonl'), 'utf8').trim().split('\n');
  for (const [i, line] of feed.entries()) {
    const [, topic, payload, ts] = JSON.parse(line) as [number, string, Record<string, unknown>, string?];
    if (topic === '_subscribe') {
      const info = payload.SessionInfo as Record<string, unknown>;
      rec.feed(T0 + i * 50, 'SessionInfo', { ...info, Key: session }, 'undefined');
    } else rec.feed(T0 + i * 50, topic, payload, ts ?? 'undefined');
  }
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
  });

  it('a recording of another session fails that session and keeps its candidates', async () => {
    const before = await candidates(BARE);
    await complete(await record(BARE, `${BARE}-1`, OPENF1));
    expect(await fill({ db, log }, args([BARE]))).toBe(false);
    expect(one()).toMatchObject({ session_key: BARE, error: 'key_mismatch' });
    expect(await candidates(BARE)).toEqual(before);
  });

  it('an archive-source session gets no file candidates', async () => {
    archiveFiles(ARCHIVED);
    await complete(await record(ARCHIVED, `${ARCHIVED}-1`));
    const before = await laps(ARCHIVED);
    expect(await fill({ db, log }, args([ARCHIVED]))).toBe(true);
    expect(one()).toMatchObject({ session_key: ARCHIVED, sources: {} });
    expect(await candidates(ARCHIVED)).toEqual({ 'f1-archive': 1 });
    expect(await laps(ARCHIVED)).toEqual(before);
  });

  it('--all goes through every session, newest first, and counts the failures', async () => {
    expect(await fill({ db, log }, args('all'))).toBe(false); // BARE's recording is another session's
    const all = lines.splice(0);
    expect(all.filter((l) => l.msg === 'fill').map((l) => l.session_key)).toEqual([ARCHIVED, BARE, OPENF1]);
    expect(all.at(-1)).toMatchObject({ msg: 'fill_done', sessions: 3, failed: 1 });
  });
});
