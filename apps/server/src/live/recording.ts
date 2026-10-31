import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gzip } from 'node:zlib';
import { createFeed, type Obj } from './merge.ts';
import { parseFeedLine } from './read.ts';

// One recording's directory (A§11.2): `feed.jsonl` is the current segment, `feed-<firstReceivedMs>.jsonl.gz` a
// finished one, `snapshots/<ms>.json.gz` the state at that moment. Lines go out synchronously, one whole line per
// writeSync, so there is no buffer to lose. Gzip runs in the background and removes the plain file only after it
// succeeds. Nothing here logs or throws into the socket handler: the recorder reads `failed`.

const PLAIN = /^feed(-\d+)?\.jsonl$/;
const gzipAsync = promisify(gzip);

export type RecordingOptions = {
  dir: string;
  now?: () => number;
  rotateMs?: number;
  snapshotMs?: number;
};
export type Recording = {
  /** The state a replay of the lines on disk would build. */
  readonly state: Obj;
  /** Raw feed bytes written. */
  readonly bytes: number;
  /** Sticky: a write failed (ENOSPC, say), and nothing more is written. */
  readonly failed: 'disk' | undefined;
  /** Gzip or snapshot jobs that failed. A failed segment gzip keeps its plain file, for `gzipLeftovers`. */
  readonly backgroundFailures: number;
  feed(receivedAt: number, topic: string, payload: unknown, ts: string): void;
  subscribed(receivedAt: number, result: unknown): void;
  /** Writes the state as of this call. Skipped while one is still running. Runs every `snapshotMs` on its own too. */
  snapshot(ms: number): Promise<void>;
  /** Idempotent: gzips the remaining segment and waits for every job. */
  finish(): Promise<void>;
};

/** Plain → `<plain>.gz` through a tmp name. On failure the plain file stays and the promise rejects. */
async function gzipFile(plain: string): Promise<void> {
  const tmp = `${plain}.gz.tmp`;
  try {
    await pipeline(createReadStream(plain), createGzip(), createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, `${plain}.gz`);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await rm(plain);
}

async function writeSnapshot(dir: string, ms: number, text: string): Promise<void> {
  const tmp = join(dir, 'snapshots', `.${ms}.tmp`);
  try {
    await writeFile(tmp, await gzipAsync(text), { mode: 0o600 });
    await rename(tmp, join(dir, 'snapshots', `${ms}.json.gz`));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function openRecording({
  dir,
  now = Date.now,
  rotateMs = 3_600_000,
  snapshotMs = 30_000,
}: RecordingOptions): Recording {
  const live = createFeed();
  const current = join(dir, 'feed.jsonl');
  const jobs = new Set<Promise<void>>();
  let fd: number | undefined;
  let first: number | undefined; // the current segment's first receivedAt: undefined while it is empty
  let firstAt = 0; // and when that line was written
  let bytes = 0;
  let failed: 'disk' | undefined;
  let backgroundFailures = 0;
  let snapshotting: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;

  const fail = () => {
    failed = 'disk';
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {}
    fd = undefined;
  };
  // Closes the current segment and moves it aside in one synchronous step, so no line can land in between.
  const seal = () => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    if (first === undefined) return rmSync(current, { force: true });
    const plain = join(dir, `feed-${first}.jsonl`);
    renameSync(current, plain);
    first = undefined;
    const job: Promise<void> = gzipFile(plain)
      .catch(() => {
        backgroundFailures++;
      })
      .finally(() => jobs.delete(job));
    jobs.add(job);
  };
  const rotateIfDue = () => {
    if (fd === undefined || first === undefined || now() - firstAt < rotateMs) return;
    try {
      seal();
      fd = openSync(current, 'a', 0o600);
    } catch {
      fail();
    }
  };
  const append = (receivedAt: number, value: unknown[]) => {
    rotateIfDue();
    if (fd === undefined) return;
    const line = JSON.stringify(value);
    const buf = Buffer.from(`${line}\n`);
    try {
      if (writeSync(fd, buf) !== buf.length) return fail(); // a short write is how a full disk starts
    } catch {
      return fail();
    }
    bytes += buf.length;
    if (first === undefined) {
      first = receivedAt;
      firstAt = now();
    }
    for (const ev of parseFeedLine(line)) live.apply(ev);
  };
  const snapshot = (ms: number): Promise<void> => {
    if (snapshotting) return snapshotting;
    if (finishing || failed) return Promise.resolve();
    snapshotting = writeSnapshot(dir, ms, JSON.stringify(live.state))
      .catch(() => {
        backgroundFailures++;
      })
      .finally(() => {
        snapshotting = undefined;
      });
    return snapshotting;
  };

  try {
    mkdirSync(join(dir, 'snapshots'), { recursive: true, mode: 0o700 });
    fd = openSync(current, 'a', 0o600);
  } catch {
    fail();
  }
  const timer = setInterval(() => {
    rotateIfDue();
    void snapshot(now());
  }, snapshotMs);
  timer.unref();

  return {
    state: live.state,
    get bytes() {
      return bytes;
    },
    get failed() {
      return failed;
    },
    get backgroundFailures() {
      return backgroundFailures;
    },
    feed: (receivedAt, topic, payload, ts) => append(receivedAt, [receivedAt, topic, payload, ts]),
    subscribed: (receivedAt, result) => append(receivedAt, [receivedAt, '_subscribe', result]),
    snapshot,
    finish() {
      finishing ??= (async () => {
        clearInterval(timer);
        try {
          seal();
        } catch {
          fail();
        }
        await snapshotting;
        await Promise.all(jobs);
      })();
      return finishing;
    },
  };
}

/** The receivedAt that opens a segment. A crash can leave too little of the first line: then undefined. */
function firstReceivedAt(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(32);
    return /^\[(\d+),/.exec(head.toString('latin1', 0, readSync(fd, head)))?.[1];
  } finally {
    closeSync(fd);
  }
}

/**
 * After a crash: gzips any plain segment left in `dir`, removes empty ones and stale tmp files. Resolves with the
 * number of segments that could not be gzipped; never rejects. A partial last line stays: `parseFeedLine` skips it.
 */
export async function gzipLeftovers(dir: string): Promise<number> {
  let failures = 0;
  for (const folder of [dir, join(dir, 'snapshots')]) {
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) if (name.endsWith('.tmp')) await rm(join(folder, name), { force: true }).catch(() => {});
  }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!PLAIN.test(name)) continue;
    try {
      let plain = join(dir, name);
      const { size, mtimeMs } = statSync(plain);
      if (size === 0) {
        rmSync(plain);
        continue;
      }
      if (name === 'feed.jsonl') {
        const named = join(dir, `feed-${firstReceivedAt(plain) ?? Math.trunc(mtimeMs)}.jsonl`);
        renameSync(plain, named);
        plain = named;
      }
      await gzipFile(plain);
    } catch {
      failures++;
    }
  }
  return failures;
}
