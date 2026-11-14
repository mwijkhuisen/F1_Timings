import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { openRecording, writeRecordingJson } from '../src/live/recording.ts';
import { reindexRecordings } from '../src/live/reindex.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// reindex-recordings (#109) against a real PostgreSQL 18 as f1_ingest, over synthetic recorder directories in a temp
// dir. MARKER is in every feed payload: no log line may carry it.

const M = 9800;
const [KEY, OTHER, UNKNOWN] = [9801, 9802, 9899];
const T0 = Date.parse('2026-11-01T12:00:00Z');
const MARKER = 'sentinel-feed-text';
const iso = (ms: number) => new Date(ms).toISOString();
const line = (ms: number) =>
  JSON.stringify([ms, 'TimingData', { Lines: { '1': { Note: `${MARKER} São Paulo ${ms}` } } }, 'undefined']);
/** The recorder's count: each line's UTF-8 bytes and its newline. */
const bytesOf = (lines: string[]) => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
/** The fields a log line may carry. */
const FIELDS = new Set([
  'level',
  'time',
  'msg',
  'session_key',
  'complete',
  'path',
  'error',
  'cause',
  'inserted',
  'existing',
  'failed',
  'ms',
]);

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;
let root: string;
let liveDir: string;
let recorderBytes: number;
const logs: Record<string, unknown>[] = [];
const log = pino({ base: null }, { write: (l: string) => void logs.push(JSON.parse(l)) });
const reindex = () => reindexRecordings({ db, log, liveDir });
const rows = async () =>
  (await db.selectFrom('recording').selectAll().orderBy('path').execute()).map((r) => ({
    path: r.path,
    session_key: r.session_key,
    source: r.source,
    started_at: r.started_at.getTime(),
    ended_at: r.ended_at?.getTime() ?? null,
    bytes: Number(r.bytes),
    complete: r.complete,
  }));
const dir = (path: string) => {
  const at = join(liveDir, path);
  mkdirSync(at, { recursive: true });
  return at;
};
const json = (at: string, meta: object) => writeFileSync(join(at, 'recording.json'), JSON.stringify(meta));

describe('reindex-recordings (f1_ingest login, synthetic directories)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'f1-reindex-'));
    liveDir = join(root, 'fixtures-private', 'live'); // the privateDir rule, for the role below
    mkdirSync(liveDir, { recursive: true });
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
    await admin.insertInto('meeting').values({ meeting_key: M, source: 'openf1', year: 2026 }).execute();
    const session = (session_key: number) => ({
      session_key,
      source: 'openf1',
      meeting_key: M,
      date_start: new Date(T0),
      date_end: new Date(T0 + 3_600_000),
    });
    await admin
      .insertInto('session')
      .values([session(KEY), session(OTHER)])
      .execute();

    // Complete, through the real recorder: two segments, the first one plain again (a gzip that did not run).
    let clock = T0;
    const complete = join(liveDir, `${KEY}-${T0}`);
    const rec = openRecording({ dir: complete, now: () => clock, rotateMs: 60_000 });
    for (const ms of [T0, T0 + 1, T0 + 60_000]) {
      clock = ms;
      rec.feed(ms, 'TimingData', JSON.parse(line(ms))[2], 'undefined');
    }
    await rec.finish();
    recorderBytes = rec.bytes;
    writeFileSync(join(complete, `feed-${T0}.jsonl`), gunzipSync(readFileSync(join(complete, `feed-${T0}.jsonl.gz`))));
    rmSync(join(complete, `feed-${T0}.jsonl.gz`));
    await writeRecordingJson(complete, {
      session_key: KEY,
      started_at: iso(T0),
      ended_at: iso(T0 + 60_001),
      bytes: rec.bytes,
      complete: true,
    });

    // Incomplete: a crash left feed.jsonl with a partial last line, and no recording.json.
    writeFileSync(join(dir(`${KEY}-${T0 + 1000}`), 'feed.jsonl'), `${line(T0 + 1000)}\n${line(T0 + 1001)}\n[17`);
    // Already a row: left as it is, though its recording.json says complete.
    json(dir(`${KEY}-${T0 + 2000}`), { session_key: KEY, started_at: iso(T0 + 2000), complete: true });
    writeFileSync(join(liveDir, `${KEY}-${T0 + 2000}`, 'feed.jsonl'), `${line(T0 + 2000)}\n`);
    await admin
      .insertInto('recording')
      .values({ session_key: KEY, path: `${KEY}-${T0 + 2000}`, started_at: new Date(T0 + 2000), bytes: 7 })
      .execute();
    // recording.json that does not count: another session, another start, over 4 KiB, a symlink, a FIFO (which must
    // not block), no JSON, a `complete` that is no boolean. No lines either.
    json(dir(`${OTHER}-${T0}`), { session_key: KEY, started_at: iso(T0), complete: true });
    json(dir(`${OTHER}-${T0 + 1}`), { session_key: OTHER, started_at: iso(T0), complete: true });
    json(dir(`${OTHER}-${T0 + 2}`), {
      session_key: OTHER,
      started_at: iso(T0 + 2),
      complete: true,
      pad: 'x'.repeat(4096),
    });
    json(root, { session_key: OTHER, started_at: iso(T0 + 3), complete: true });
    symlinkSync(join(root, 'recording.json'), join(dir(`${OTHER}-${T0 + 3}`), 'recording.json'));
    execFileSync('mkfifo', [join(dir(`${OTHER}-${T0 + 5}`), 'recording.json')]);
    writeFileSync(join(dir(`${OTHER}-${T0 + 6}`), 'recording.json'), '{"session_key":');
    json(dir(`${OTHER}-${T0 + 7}`), { session_key: OTHER, started_at: iso(T0 + 7), complete: 'yes' });
    // Unreadable: a segment through a symlink.
    writeFileSync(join(root, 'elsewhere.jsonl'), `${line(T0 + 4)}\n`);
    symlinkSync(join(root, 'elsewhere.jsonl'), join(dir(`${OTHER}-${T0 + 4}`), `feed-${T0 + 4}.jsonl`));
    // Unreadable: a segment that is no gzip, and a receivedAt that is a safe integer but no time (> 8.64e15 ms).
    writeFileSync(join(dir(`${OTHER}-${T0 + 8}`), `feed-${T0 + 8}.jsonl.gz`), `${line(T0 + 8)}\n`);
    writeFileSync(join(dir(`${OTHER}-${T0 + 9}`), 'feed.jsonl'), `${line(9e15)}\n`);
    // A session the database does not know.
    writeFileSync(join(dir(`${UNKNOWN}-${T0}`), 'feed.jsonl'), `${line(T0)}\n`);
    // Skipped: no recorder directory name, a file, a symlink to a directory.
    writeFileSync(join(dir('p2a'), 'feed.jsonl'), `${line(T0)}\n`);
    writeFileSync(join(liveDir, '1-2'), `${line(T0)}\n`);
    symlinkSync(complete, join(liveDir, '3-4'));
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('inserts a row per directory without one, from the name and one read of the files', async () => {
    expect(await reindex()).toBe(false);
    const row = (key: number, started_at: number, ended_at: number | null, bytes: number, complete = false) => {
      const path = `${key}-${started_at}`;
      return { path, session_key: key, source: 'f1-live', started_at, ended_at, bytes, complete };
    };
    expect(await rows()).toEqual([
      row(KEY, T0, T0 + 60_000, recorderBytes, true),
      row(KEY, T0 + 1000, T0 + 1001, bytesOf([line(T0 + 1000), line(T0 + 1001)])), // the partial line is none
      row(KEY, T0 + 2000, null, 7),
      ...[0, 1, 2, 3, 5, 6, 7].map((d) => row(OTHER, T0 + d, T0 + d, 0)), // no lines: ended at the start
    ]);
    expect(recorderBytes).toBe(bytesOf([T0, T0 + 1, T0 + 60_000].map(line))); // D2: the recorder's own count

    expect(
      logs.filter((l) => l.msg === 'recording reindexed').map((l) => [l.level, l.session_key, l.complete]),
    ).toEqual([[30, KEY, true], [30, KEY, false], ...Array(7).fill([30, OTHER, false])]);
    expect(logs.filter((l) => l.msg === 'reindex')).toEqual([
      expect.objectContaining({ level: 50, path: `${OTHER}-${T0 + 4}`, error: 'unreadable', cause: 'ELOOP' }),
      expect.objectContaining({ level: 50, path: `${OTHER}-${T0 + 8}`, error: 'unreadable', cause: 'Z_DATA_ERROR' }),
      expect.objectContaining({ level: 50, path: `${OTHER}-${T0 + 9}`, error: 'unreadable', cause: 'bad_time' }),
      expect.objectContaining({ level: 50, path: `${UNKNOWN}-${T0}`, error: 'no_session', cause: '23503' }),
    ]);
    expect(logs.at(-1)).toMatchObject({ msg: 'reindex_done', level: 50, inserted: 9, existing: 1, failed: 4 });
    expect(logs.at(-1)?.ms).toEqual(expect.any(Number));
    // Fixed fields only, and never a value from a file.
    for (const l of logs) expect(Object.keys(l).filter((k) => !FIELDS.has(k))).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(MARKER);
  });

  it('a second run inserts nothing and changes no row', async () => {
    const before = await rows();
    logs.length = 0;
    expect(await reindex()).toBe(false); // the four failures stay
    expect(await rows()).toEqual(before);
    expect(logs.filter((l) => l.msg === 'recording reindexed')).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ msg: 'reindex_done', inserted: 0, existing: 10, failed: 4 });
  });

  it('the role: as f1_ingest, exit 0 when nothing fails', async () => {
    for (const d of [4, 8, 9]) rmSync(join(liveDir, `${OTHER}-${T0 + d}`), { recursive: true });
    rmSync(join(liveDir, `${UNKNOWN}-${T0}`), { recursive: true });
    writeFileSync(join(dir(`${KEY}-${T0 + 5000}`), 'feed.jsonl'), `${line(T0 + 5000)}\n`);
    const env = { DATABASE_URL: testDb.urls.f1_ingest };
    expect(await run(['reindex-recordings', '--live-dir', liveDir], env, () => {})).toBe(0);
    expect((await rows()).find((r) => r.path === `${KEY}-${T0 + 5000}`)).toMatchObject({
      complete: false,
      bytes: bytesOf([line(T0 + 5000)]),
    });
  });

  it('the role: exit 1 and one fixed line when the live dir is missing', async () => {
    const out: string[] = [];
    // A replaced stdout.write is what pino writes to (it uses fd 1 directly only while stdout is untouched).
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => out.push(String(chunk)) > 0);
    let code: number;
    try {
      const args = ['reindex-recordings', '--live-dir', join(root, 'fixtures-private', 'missing')];
      code = await run(args, { DATABASE_URL: testDb.urls.f1_ingest }, (l) => void out.push(l));
    } finally {
      write.mockRestore();
    }
    expect(code).toBe(1);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      {
        level: 50,
        time: expect.any(Number),
        role: 'reindex-recordings',
        cause: 'ENOENT',
        msg: 'reindex-recordings failed',
      },
    ]);
  });
});
