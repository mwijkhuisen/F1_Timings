import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipLeftovers, openRecording, writeRecordingJson } from '../src/live/recording.ts';

// #210: each step is on disk before the next one depends on it. `open`, `rename` and `rm` pass through to the real calls
// and log synchronously when they are called (`rename` also when it resolves); the `sync` spy logs its call and its
// resolution. A `rename` that is not awaited therefore logs the next `open` before `renamed`, every time. A `sync` that
// is not awaited keeps the order (FileHandle#close waits for a pending operation) but loses its error, which the
// failing-sync tests catch.
const log = vi.hoisted((): string[] => []);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return {
    ...fs,
    open: (path: string, flags?: string, mode?: number) => {
      log.push(`open ${base(path)}`);
      return fs.open(path, flags, mode);
    },
    rename: async (from: string, to: string) => {
      log.push(`rename ${base(from)} ${base(to)}`);
      await fs.rename(from, to);
      log.push('renamed');
    },
    rm: (path: string, options?: { force?: boolean }) => {
      log.push(`rm ${base(path)}`);
      return fs.rm(path, options);
    },
  };
});

const proto = await open(tmpdir(), 'r').then(async (fh) => {
  await fh.close();
  return Object.getPrototypeOf(fh) as FileHandle;
});
const realSync = proto.sync;
const EIO = Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
/** Every FileHandle's `sync`, logged; the `fail`th call rejects with EIO instead. */
const spySync = (fail?: number) => {
  let n = 0;
  return vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
    if (++n === fail) throw EIO;
    log.push('sync');
    await realSync.call(this);
    log.push('synced');
  });
};

const T0 = Date.parse('2026-11-20T00:30:00Z');
const line = (ms: number) => `${JSON.stringify([ms, 'TimingData', { Seq: 1 }, 'undefined'])}\n`;
const meta = {
  session_key: 9001,
  started_at: new Date(T0).toISOString(),
  ended_at: new Date(T0 + 1).toISOString(),
  bytes: 42,
  complete: true,
};
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'f1-sync-'));
  dir = join(root, 'session');
  mkdirSync(dir);
  log.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('the sync before the delete (#210)', () => {
  it('a closed segment: the gzip is synced, renamed, the directory synced, and only then the plain file goes', async () => {
    spySync();
    const rec = openRecording({ dir, now: () => T0 });
    rec.feed(T0, 'TimingData', { Seq: 1 }, 'undefined');
    await rec.finish();
    const gz = `feed-${T0}.jsonl.gz`;
    expect(log).toEqual([
      `open ${gz}.tmp`,
      'sync',
      'synced',
      `rename ${gz}.tmp ${gz}`,
      'renamed',
      'open session',
      'sync',
      'synced',
      `rm feed-${T0}.jsonl`,
    ]);
    expect(rec.backgroundFailures).toBe(0);
    expect(readdirSync(dir)).toEqual([gz]);
    expect(statSync(join(dir, gz)).mode & 0o777).toBe(0o600);
    expect(gunzipSync(readFileSync(join(dir, gz))).toString()).toBe(line(T0));
  });

  it('recording.json: synced before the rename, and the directory after it', async () => {
    spySync();
    await writeRecordingJson(dir, meta);
    expect(log).toEqual([
      'open recording.json.tmp',
      'sync',
      'synced',
      'rename recording.json.tmp recording.json',
      'renamed',
      'open session',
      'sync',
      'synced',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8'))).toEqual(meta);
    expect(statSync(join(dir, 'recording.json')).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['the gzip', 1, ['feed-100.jsonl']],
    ['the directory', 2, ['feed-100.jsonl', 'feed-100.jsonl.gz']],
  ] as const)('a failing sync of %s keeps the plain file, leaves no tmp and rejects', async (_what, fail, left) => {
    writeFileSync(join(dir, 'feed-100.jsonl'), line(100));
    spySync(fail);
    await expect(gzipLeftovers(dir)).resolves.toBe(1); // gzipFile rejected
    expect(readdirSync(dir).sort()).toEqual(left);
    expect(readFileSync(join(dir, 'feed-100.jsonl'), 'utf8')).toBe(line(100));
    // Once the cause is gone, the next boot's gzipLeftovers finishes the job.
    vi.restoreAllMocks();
    await expect(gzipLeftovers(dir)).resolves.toBe(0);
    expect(readdirSync(dir)).toEqual(['feed-100.jsonl.gz']);
    expect(gunzipSync(readFileSync(join(dir, 'feed-100.jsonl.gz'))).toString()).toBe(line(100));
  });

  it('a failing sync of recording.json rejects and leaves neither the tmp nor recording.json', async () => {
    spySync(1);
    await expect(writeRecordingJson(dir, meta)).rejects.toBe(EIO);
    expect(readdirSync(dir)).toEqual([]);
  });
});
