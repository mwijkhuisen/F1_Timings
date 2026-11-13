import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { type Lap, type Obj, type Stints, view, type Weather, weatherRow, withWeatherRow } from '@f1/contracts';
import { codeOf } from '../db/db.ts';
import { progressiveColours } from '../timing/colours.ts';
import { markLaps } from '../timing/rules.ts';
import { createLaps, type LapRow, qualifyingParts, type StintRow } from './laps.ts';
import { createFeed } from './merge.ts';
import { isObj, parseFeedLine, utc } from './read.ts';

// State at T over one recording's files (A§11.3, ADR-0007): a replay from the first line up to T, then a delta per
// change, paced by the live clock (T = now − delay) or the replay clock (T = at + elapsed × speed). The time axis is
// each line's receivedAt, the number before its first comma. An async generator: while the consumer writes, it does not
// advance, which is the back-pressure. `.z` topics are never applied, kept or sent (O1). Nothing here logs.
//
// The lap and stint rows come from createLaps over the same events: a snapshot carries all of them, a `laps` event the
// rows that changed since the last send. The weather rows are one per applied WeatherData delta since the last session
// switch, at most the last MAX_WEATHER_ROWS (withWeatherRow).

/** `state` is the stream's own, which changes on the next `next()`: serialize it before. `weather` is never mutated. */
export type PlaybackEvent =
  | { event: 'snapshot'; data: { t: number; state: Obj; laps: Lap[]; stints: Stints; weather: Weather } }
  | { event: 'delta'; data: { t: number; topic: string; data: unknown } }
  | { event: 'laps'; data: { t: number; laps: Lap[]; stints: Stints } }
  | { event: 'end'; data: { t: number } }
  | { event: 'ping'; data: { t: number } };
type Line = { r: number; text: string };

const BEHIND_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const LAPS_MS = 1_000;
const TAIL_MS = 1_000;
const ENDED_MS = 30_000;
const CHUNK = 64 * 1024;
const AGAIN_MS = 50;
// Files from `live`, which parses the untrusted feed (A§12.1): no file is read through a symlink (ELOOP), and no line
// grows without bound.
const NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const MAX_LINE = 8 * 2 ** 20; // a feed line is a few kB
const SEGMENT = /^feed-(\d+)\.jsonl(\.gz)?$/;

const missing = (err: unknown): undefined => {
  if (codeOf(err) !== 'ENOENT') throw err;
};
const tooLarge = () => Object.assign(new Error('playback_too_large'), { code: 'playback_too_large' });
const keyOf = (info: unknown) => (isObj(info) && typeof info.Key === 'number' ? info.Key : undefined);
// The topics the lap rows read: the engine's two, and A§9's race control and qualifying parts (lapRows).
const LAP_TOPICS = new Set(['TimingData', 'TimingAppData', 'RaceControlMessages', 'SessionData']);

/**
 * The engine's rows in the shapes of the Lap and Stints contracts, with A§9's deleted laps and qualifying phases from
 * the state at T, and the tower's progressive colours. Spoiler-safe: the state holds only the race control aired by
 * T, so a lap is struck once its ruling has aired. The phases come from SessionData's parts in a qualifying session
 * only: after a switch the series can still hold the previous day's entries (A§11.3), and practice and races have none.
 * The lap table does not use the segments (the tower reads them from the state). A lap's compound is that of the
 * driver's stint covering it (the later one when two do), an open stint running to infinity. Marks `laps` in place.
 */
export function lapRows(
  { laps, stints }: { laps: LapRow[]; stints: StintRow[] },
  state: Obj,
): { laps: Lap[]; stints: Stints } {
  const type = view(state, 'SessionInfo')?.Type ?? null;
  const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const said = Object.values(view(state, 'RaceControlMessages')?.Messages ?? {}).map((m) => ({
    date: at(utc(m?.Utc)), // the feed's Utc has no Z
    qualifying_phase: null,
    message: m?.Message ?? null,
  }));
  const parts = (type === 'Qualifying' ? qualifyingParts(state) : []).map((p) => ({
    date: at(p.at),
    qualifying_phase: p.part,
    message: null,
  }));
  markLaps(laps, [...said, ...parts], type);
  const starts = laps.map((l) => (l.date_start === null ? null : new Date(l.date_start)));
  const colour = progressiveColours(laps.map((l, i) => ({ ...l, date_start: starts[i] ?? null })));
  return {
    laps: laps.map((l, i) => ({
      driver_number: l.driver_number,
      lap_number: l.lap_number,
      date_start: starts[i]?.toISOString() ?? null,
      lap_ms: l.lap_ms,
      s1_ms: l.s1_ms,
      s2_ms: l.s2_ms,
      s3_ms: l.s3_ms,
      i1_kph: l.i1_kph,
      i2_kph: l.i2_kph,
      st_kph: l.st_kph,
      is_pit_out: l.is_pit_out,
      is_pit_in: l.is_pit_in,
      seg1: null,
      seg2: null,
      seg3: null,
      deleted: l.deleted,
      deleted_reason: l.deleted_reason,
      quali_phase: l.quali_phase,
      compound:
        stints.findLast(
          (s) =>
            s.driver_number === l.driver_number &&
            s.lap_start !== null &&
            s.lap_start <= l.lap_number &&
            l.lap_number <= (s.lap_end ?? Number.POSITIVE_INFINITY),
        )?.compound ?? null,
      colour: colour[i] as Lap['colour'],
    })),
    stints: stints.map(({ session_key: _, source: __, ...s }) => s),
  };
}

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
  /** The recording's session: the lap rows are its own (createLaps ignores another session's lines). */
  sessionKey: number;
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
  let weather: Weather = [];
  const engine = createLaps(o.sessionKey, 'f1-live');
  const sent = new Map<string, string>(); // row key → the row's JSON as last sent
  let dirty = false; // a LAP_TOPICS change since the rows were last sent
  let lapsAt = Number.NEGATIVE_INFINITY; // wall time of the last `laps` check
  let applied = Number.NEGATIVE_INFINITY; // receivedAt of the last line applied

  /** Applies one line, its deltas into `out`. True when it switched the session: the state was cleared first. */
  const apply = (line: Line, out?: PlaybackEvent[]) => {
    let switched = false;
    applied = line.r;
    for (const ev of parseFeedLine(line.text)) {
      if (ev.topic.endsWith('.z')) continue;
      // A new session's SessionInfo: no topic of the previous session stays (no ghost driver, line or message). The
      // laps engine keeps going: it holds the recording's session only.
      if (ev.topic === 'SessionInfo') {
        const [key, current] = [keyOf(ev.payload), keyOf(feed.state.SessionInfo)];
        if (key !== undefined && current !== undefined && key !== current) {
          for (const topic of Object.keys(feed.state)) delete feed.state[topic];
          weather = [];
          switched = true;
        }
      }
      const data = feed.apply(ev);
      if (data === undefined) continue;
      engine.push(ev, data);
      if (LAP_TOPICS.has(ev.topic)) dirty = true;
      if (ev.topic === 'WeatherData')
        weather = withWeatherRow(weather, weatherRow(view(feed.state, 'WeatherData'), line.r));
      out?.push({ event: 'delta', data: { t: line.r, topic: ev.topic, data } });
    }
    return switched;
  };
  /** The rows whose JSON differs from the last sent, now marked as sent. */
  const unsent = <R>(rows: R[], key: (row: R) => string) =>
    rows.filter((row) => {
      const [k, json] = [key(row), JSON.stringify(row)];
      if (sent.get(k) === json) return false;
      sent.set(k, json);
      return true;
    });
  const rows = () => {
    dirty = false;
    // A§9 from the recording's own session only: after a switch to a later one, its rulings must not strike these laps.
    // ponytail: re-reads every race-control message per laps check (about 200 in a race); cache the rulings per message
    // key if a state ever holds far more.
    const own = keyOf(feed.state.SessionInfo) === o.sessionKey ? feed.state : {};
    const all = lapRows(engine.rows(), own);
    return {
      laps: unsent(all.laps, (l) => `lap ${l.driver_number} ${l.lap_number}`),
      stints: unsent(all.stints, (s) => `stint ${s.driver_number} ${s.stint_number}`),
    };
  };
  // ponytail: every open sends all lap rows uncompressed, about 0.65 MB for a full race (Caddy leaves the SSE route
  // uncompressed); a compact or compressed form if that hurts.
  const snapshot = (t: number): PlaybackEvent => {
    sent.clear();
    return { event: 'snapshot', data: { t, state: feed.state, ...rows(), weather } };
  };
  const changes = (): PlaybackEvent | undefined => {
    lapsAt = o.now();
    const data = { t: applied, ...rows() };
    return data.laps.length + data.stints.length > 0 ? { event: 'laps', data } : undefined;
  };

  // Seek: every line from the first one up to T, through one feed (its duplicate filter sees every line) and the laps.
  // ponytail: a full scan per stream open, ~1.1 s for a 4 h race on WSL and more on the VM's 1 CPU; a per-recording
  // scan cache if that hurts.
  const at = T();
  const src = lines(o.dir, 0);
  try {
    const next = async () => (await src.next()).value;
    // The seek reads to the real end of the data; the loop below takes `null` as `undefined`.
    const seekNext = async () => {
      let line = await next();
      for (; line === null; line = await next()) await o.sleep(AGAIN_MS, o.signal);
      return line;
    };
    let line: Line | null | undefined = await seekNext();
    for (; line && line.r <= at; line = await seekNext()) apply(line);
    yield snapshot(at);

    let wrote = o.now();
    let polled = Number.NEGATIVE_INFINITY;
    let ending = false;
    while (!o.signal.aborted) {
      const now = T();
      // Changed rows at most once a second, after the last line of a receivedAt (so `t` covers every line up to it).
      if (dirty && o.now() - lapsAt >= LAPS_MS && line?.r !== applied) {
        const ev = changes();
        if (ev) {
          yield ev;
          wrote = o.now();
        }
        continue;
      }
      if (line && line.r <= now) {
        if (now - line.r > BEHIND_MS * o.speed) {
          // The consumer fell behind: apply the backlog silently and send the state instead. Nothing queues.
          for (; line && line.r <= now; line = await next()) apply(line);
          yield snapshot(now);
          wrote = o.now();
        } else {
          const out: PlaybackEvent[] = [];
          const r = line.r;
          const switched = apply(line, out);
          line = await next();
          if (switched) yield snapshot(r);
          else yield* out;
          if (switched || out.length > 0) wrote = o.now();
        }
        continue;
      }
      if (!line) {
        if (ending) {
          const ev = dirty ? changes() : undefined;
          if (ev) yield ev;
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
        yield { event: 'ping', data: { t: now } };
        wrote = o.now();
        continue;
      }
      const wait = line ? Math.ceil((line.r - now) / o.speed) : TAIL_MS;
      const due = dirty ? Math.max(1, lapsAt + LAPS_MS - o.now()) : wait; // ≥ 1: a clock step back is no busy loop
      await o.sleep(Math.min(wait, idle, due), o.signal).catch((err: unknown) => {
        if (!o.signal.aborted) throw err;
      });
      line ??= await next();
    }
  } finally {
    await src.return(undefined);
  }
}
