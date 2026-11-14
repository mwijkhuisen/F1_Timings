import {
  closeSync,
  constants,
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
import { open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Obj } from '@f1/contracts';
import { codeOf } from '../db/db.ts';
import { createFeed } from './merge.ts';
import { parseFeedLine } from './read.ts';

// One recording's directory (A§11.2), its writer and its readers: `feed.jsonl` is the current segment,
// `feed-<firstReceivedMs>.jsonl.gz` a finished one, and `recording.json` what the recorder wrote when it closed the
// recording (writeRecordingJson; the reindex takes `complete` from it). Since #109 no snapshots are written; an older
// directory can still hold a `snapshots/` folder, which nothing reads. Lines go out synchronously, one whole line per
// writeSync, so there is no buffer to lose. Gzip runs in the background and removes the plain file only after it
// succeeds. Nothing here logs or throws into the socket handler: the recorder reads `failed`.

const PLAIN = /^feed(-\d+)?\.jsonl$/;
// Files from `live`, which parses the untrusted feed (A§12.1): no file is read through a symlink (ELOOP), and no line
// grows without bound.
export const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_LINE = 8 * 2 ** 20; // a feed line is a few kB
export const SEGMENT = /^feed-(\d+)\.jsonl(\.gz)?$/;

export type Line = { r: number; text: string };
export const missing = (err: unknown): undefined => {
  if (codeOf(err) !== 'ENOENT') throw err;
};
const tooLarge = () => Object.assign(new Error('playback_too_large'), { code: 'playback_too_large' });

export type RecordingOptions = {
  dir: string;
  now?: () => number;
  rotateMs?: number;
  /** How often an idle segment is checked for its rotation. */
  tickMs?: number;
};
export type Recording = {
  /** The state a replay of the lines on disk would build. */
  readonly state: Obj;
  /** Raw feed bytes written. */
  readonly bytes: number;
  /** Sticky: a write failed (ENOSPC, say), and nothing more is written. */
  readonly failed: 'disk' | undefined;
  /** Gzip jobs that failed. A failed segment gzip keeps its plain file, for `gzipLeftovers`. */
  readonly backgroundFailures: number;
  feed(receivedAt: number, topic: string, payload: unknown, ts: string): void;
  subscribed(receivedAt: number, result: unknown): void;
  /** Idempotent: gzips the remaining segment and waits for every job. */
  finish(): Promise<void>;
};
/** `recording.json`: the times as ISO strings. */
export type RecordingMeta = {
  session_key: number;
  started_at: string;
  ended_at: string;
  bytes: number;
  complete: boolean;
};

/** Plain → `<plain>.gz` through a tmp name. On failure the plain file stays and the promise rejects. */
async function gzipFile(plain: string): Promise<void> {
  const tmp = `${plain}.gz.tmp`;
  try {
    await pipelineAsync(createReadStream(plain), createGzip(), createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, `${plain}.gz`);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await rm(plain);
}

/** `<dir>/recording.json` through a tmp name, 0600. On failure no tmp stays and the promise rejects. */
export async function writeRecordingJson(dir: string, meta: RecordingMeta): Promise<void> {
  const tmp = join(dir, 'recording.json.tmp');
  try {
    await writeFile(tmp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    await rename(tmp, join(dir, 'recording.json'));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function openRecording({
  dir,
  now = Date.now,
  rotateMs = 3_600_000,
  tickMs = 30_000,
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

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(current, 'a', 0o600);
  } catch {
    fail();
  }
  const timer = setInterval(rotateIfDue, tickMs);
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
    finish() {
      finishing ??= (async () => {
        clearInterval(timer);
        try {
          seal();
        } catch {
          fail();
        }
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
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.tmp')) await rm(join(dir, name), { force: true }).catch(() => {});
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

/** The `\n`-terminated lines of a byte stream whose receivedAt is a safe integer; a partial line waits for the rest. */
export function splitter(): (chunk: Buffer) => Line[] {
  let rest = Buffer.alloc(0);
  return (chunk) => {
    const buf = Buffer.concat([rest, chunk]); // a copy: the caller may reuse its chunk
    const out: Line[] = [];
    let from = 0;
    for (let end = buf.indexOf(10); end >= 0; end = buf.indexOf(10, from)) {
      const text = buf.toString('utf8', from, end);
      from = end + 1;
      const r = Number(/^\[(\d+),/.exec(text)?.[1]);
      if (Number.isSafeInteger(r)) out.push({ r, text });
    }
    rest = buf.subarray(from);
    if (rest.length > MAX_LINE) throw tooLarge();
    return out;
  };
}

/** A sealed segment: the plain file while it is there (it is complete once renamed), else its gzip. */
export async function* segment(dir: string, base: string, plain: boolean): AsyncGenerator<Line> {
  const fh = plain ? await open(join(dir, base), NOFOLLOW).catch(missing) : undefined;
  const file = (fh ?? (await open(join(dir, `${base}.gz`), NOFOLLOW))).createReadStream(); // closes its handle
  const source = fh ? file : pipeline(file, createGunzip(), () => {}); // an error surfaces in the loop below
  const split = splitter();
  try {
    for await (const chunk of source) yield* split(chunk);
  } finally {
    source.destroy();
    file.destroy();
  }
}

/** The sealed segments in numeric order of their first receivedAt. `*.tmp` never matches. */
export async function segments(dir: string): Promise<{ ms: number; base: string; plain: boolean }[]> {
  const found = new Map<number, { ms: number; base: string; plain: boolean }>();
  for (const name of await readdir(dir)) {
    const m = SEGMENT.exec(name);
    const ms = Number(m?.[1]);
    if (!m || !Number.isSafeInteger(ms)) continue;
    found.set(ms, { ms, base: `feed-${m[1]}.jsonl`, plain: !m[2] || found.get(ms)?.plain === true });
  }
  return [...found.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * Every line of a recording once, in order: the sealed segments in numeric order, then feed.jsonl when there is one.
 * For a finished recording or a copy (the tools, the reindex); a running one is tailed by playback's `lines`.
 * ponytail: a rotation between the listing and the open of feed.jsonl skips the segment it sealed; tail as `lines` does
 * if a running recording ever needs this.
 */
export async function* recordingLines(dir: string): AsyncGenerator<Line> {
  for (const s of await segments(dir)) yield* segment(dir, s.base, s.plain);
  try {
    yield* segment(dir, 'feed.jsonl', true);
  } catch (err) {
    missing(err); // no feed.jsonl: a sealed recording
  }
}
