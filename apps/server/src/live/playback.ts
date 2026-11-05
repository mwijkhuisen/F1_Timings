import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip, gunzip } from 'node:zlib';
import { codeOf } from '../db/db.ts';
import { createFeed, merge, type Obj } from './merge.ts';
import { parseFeedLine } from './read.ts';

// State at T over one recording's files (A§11.3, ADR-0007): a seek to the newest snapshot at or before T, then a delta
// per change, paced by the live clock (T = now − delay) or the replay clock (T = at + elapsed × speed). The time axis is
// each line's receivedAt, the number before its first comma. An async generator: while the consumer writes, it does not
// advance, which is the back-pressure. `.z` topics are never applied, kept or sent (O1). Nothing here logs.

/** `state` is the stream's own state, which changes on the next `next()`: serialize it before. */
export type PlaybackEvent =
  | { event: 'snapshot'; data: { t: number; state: Obj } }
  | { event: 'delta'; data: { t: number; topic: string; data: unknown } }
  | { event: 'end'; data: { t: number } }
  | { event: 'ping' };
type Line = { r: number; text: string };

const PRIME_MS = 10 * 60_000;
const BEHIND_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const TAIL_MS = 1_000;
const ENDED_MS = 30_000;
const CHUNK = 64 * 1024;
const AGAIN_MS = 50;
// Files from `live`, which parses the untrusted feed (A§12.1): no file is read through a symlink (ELOOP), and no line
// or snapshot grows without bound.
const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_LINE = 8 * 2 ** 20; // a feed line is a few kB
const MAX_SNAPSHOT = 16 * 2 ** 20;
const SEGMENT = /^feed-(\d+)\.jsonl(\.gz)?$/;
const SNAPSHOT = /^\d+\.json\.gz$/;
const gunzipAsync = promisify(gunzip);

const missing = (err: unknown): undefined => {
  if (codeOf(err) !== 'ENOENT') throw err;
};
const tooLarge = () => Object.assign(new Error('playback_too_large'), { code: 'playback_too_large' });

/** The `\n`-terminated lines of a byte stream whose receivedAt is a safe integer; a partial line waits for the rest. */
function splitter(): (chunk: Buffer) => Line[] {
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
async function* segment(dir: string, base: string, plain: boolean): AsyncGenerator<Line> {
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
async function segments(dir: string): Promise<{ ms: number; base: string; plain: boolean }[]> {
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
 * Every line from `from` on, in order: the sealed segments from the last one that starts at or before `from`, then
 * feed.jsonl, tailed. `undefined` means nothing more for now, `null` that a rotation may be in progress: the open
 * feed.jsonl was renamed already, or it is missing for the first time (twice in a row, the recording is sealed). Either
 * way the next call looks again. A segment is named after its first line's receivedAt, and `done` is the newest file
 * read. feed.jsonl is opened before each listing, so a rotation in between neither skips a segment (the listing shows
 * it) nor repeats one (the open file's first line is ≤ `done`).
 */
async function* lines(dir: string, from: number): AsyncGenerator<Line | null | undefined, undefined> {
  const current = join(dir, 'feed.jsonl');
  let done: number | undefined;
  let gone = false; // feed.jsonl was missing in the last pass
  for (;;) {
    const fh = await open(current, NOFOLLOW).catch(missing);
    try {
      const segs = await segments(dir);
      done ??= (segs.findLast((s) => s.ms <= from)?.ms ?? Number.NEGATIVE_INFINITY) - 1;
      for (const s of segs) {
        if (s.ms <= done) continue;
        for await (const line of segment(dir, s.base, s.plain)) if (line.r >= from) yield line;
        done = s.ms;
      }
      if (!fh) {
        yield gone ? undefined : null;
        gone = true;
        continue;
      }
      gone = false;
      const { ino } = await fh.stat();
      const buffer = Buffer.allocUnsafe(CHUNK);
      const split = splitter();
      let first: number | undefined;
      let position = 0;
      let rotated = false;
      tail: for (;;) {
        const { bytesRead } = await fh.read(buffer, 0, CHUNK, position);
        if (bytesRead > 0) {
          position += bytesRead;
          for (const line of split(buffer.subarray(0, bytesRead))) {
            first ??= line.r;
            if (first <= done) {
              yield null; // renamed after the open and read as a segment already: look again
              break tail;
            }
            if (line.r >= from) yield line;
          }
        } else if (rotated) break;
        else {
          // The writer closes a segment before it renames it, so once the name points elsewhere one more read drains it.
          rotated = (await stat(current).catch(missing))?.ino !== ino;
          if (!rotated) yield undefined;
        }
      }
      if (first !== undefined && first > done) done = first;
    } finally {
      await fh?.close();
    }
  }
}

export async function* playback(o: {
  dir: string;
  at: number | 'live';
  /** Seconds, live only. */
  delay: number;
  speed: number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Whether the recording is finished: called at EOF, at most every 30 s. */
  ended: () => Promise<boolean>;
  signal: AbortSignal;
}): AsyncGenerator<PlaybackEvent> {
  const start = o.now();
  const T = () => (o.at === 'live' ? o.now() - o.delay * 1000 : o.at + (o.now() - start) * o.speed);
  const feed = createFeed();
  const apply = (line: Line, out?: PlaybackEvent[]) => {
    for (const ev of parseFeedLine(line.text)) {
      if (ev.topic.endsWith('.z')) continue;
      const data = feed.apply(ev);
      if (data !== undefined) out?.push({ event: 'delta', data: { t: line.r, topic: ev.topic, data } });
    }
  };

  // Seek. A snapshot holds no duplicate memory, so the lines of the 10 min before it prime the filter (a reconnect
  // replays messages), then the snapshot replaces the state and the lines in [S, T] follow. A line at exactly S may be
  // in the snapshot already: applying the lines at S once more leaves the same state.
  // ponytail: exact unless a duplicate arrives more than 10 min after its original (P2a saw none). Snapshots that
  // carried their duplicate memory would drop this scan.
  const at = T();
  let s = Number.NEGATIVE_INFINITY;
  let snapshot: string | undefined;
  for (const name of (await readdir(join(o.dir, 'snapshots')).catch(missing)) ?? []) {
    const ms = Number.parseInt(name, 10);
    if (SNAPSHOT.test(name) && Number.isSafeInteger(ms) && ms <= at && ms > s) [s, snapshot] = [ms, name];
  }
  const src = lines(o.dir, s - PRIME_MS);
  try {
    const next = async () => (await src.next()).value;
    // The seek reads to the real end of the data; the loop below takes `null` as `undefined`.
    const seekNext = async () => {
      let line = await next();
      for (; line === null; line = await next()) await o.sleep(AGAIN_MS, o.signal);
      return line;
    };
    let line: Line | null | undefined = await seekNext();
    for (; line && line.r < s; line = await seekNext()) apply(line);
    if (snapshot) {
      const fh = await open(join(o.dir, 'snapshots', snapshot), NOFOLLOW);
      const gz = await fh.readFile().finally(() => fh.close());
      const json = await gunzipAsync(gz, { maxOutputLength: MAX_SNAPSHOT }).catch((err: unknown) => {
        throw codeOf(err) === 'ERR_BUFFER_TOO_LARGE' ? tooLarge() : err;
      });
      for (const topic of Object.keys(feed.state)) delete feed.state[topic];
      merge(feed.state, JSON.parse(String(json)));
      for (const topic of Object.keys(feed.state)) if (topic.endsWith('.z')) delete feed.state[topic];
    }
    for (; line && line.r <= at; line = await seekNext()) apply(line);
    yield { event: 'snapshot', data: { t: at, state: feed.state } };

    let wrote = o.now();
    let polled = Number.NEGATIVE_INFINITY;
    let ending = false;
    while (!o.signal.aborted) {
      const now = T();
      if (line && line.r <= now) {
        if (now - line.r > BEHIND_MS * o.speed) {
          // The consumer fell behind: apply the backlog silently and send the state instead. Nothing queues.
          for (; line && line.r <= now; line = await next()) apply(line);
          yield { event: 'snapshot', data: { t: now, state: feed.state } };
          wrote = o.now();
        } else {
          const out: PlaybackEvent[] = [];
          apply(line, out);
          line = await next();
          yield* out;
          if (out.length > 0) wrote = o.now();
        }
        continue;
      }
      if (!line) {
        if (ending) {
          yield { event: 'end', data: { t: now } };
          return;
        }
        if (o.now() - polled >= ENDED_MS) {
          polled = o.now();
          if (await o.ended()) {
            // Every line was on disk before the recording ended: list and drain once more, then end.
            ending = true;
            line = await next();
            continue;
          }
        }
      }
      const idle = wrote + HEARTBEAT_MS - o.now();
      if (idle <= 0) {
        yield { event: 'ping' };
        wrote = o.now();
        continue;
      }
      const wait = line ? Math.ceil((line.r - now) / o.speed) : TAIL_MS;
      await o.sleep(Math.min(wait, idle), o.signal).catch((err: unknown) => {
        if (!o.signal.aborted) throw err;
      });
      line ??= await next();
    }
  } finally {
    await src.return(undefined);
  }
}
