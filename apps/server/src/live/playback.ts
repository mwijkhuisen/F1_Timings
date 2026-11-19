import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Lap,
  type Obj,
  type Pits,
  type PlaybackPos,
  type Stints,
  view,
  type Weather,
  weatherRow,
  withWeatherRow,
} from '@f1/contracts';
import { progressiveColours } from '../timing/colours.ts';
import { markLaps } from '../timing/rules.ts';
import { type Frame, toOutline } from './fit.ts';
import { createLaps, type LapRow, qualifyingParts, type StintRow } from './laps.ts';
import { createFeed } from './merge.ts';
import { createPits } from './pits.ts';
import { isObj, parseFeedLine, UNPARSED, utc } from './read.ts';
import { type Line, missing, NOFOLLOW, notFile, segment, segments, splitter } from './recording.ts';
import { decodeZ, positions, type ZFail } from './telemetry.ts';

// State at T over one recording's files (A§11.3, ADR-0007): a replay from the first line up to T, then a delta per
// change, paced by the live clock (T = now − delay) or the replay clock (T = at + elapsed × speed). The time axis is
// each line's receivedAt, the number before its first comma. An async generator: while the consumer writes, it does not
// advance, which is the back-pressure. `.z` topics are never applied, kept or sent (O1), nor are the UNPARSED ones (#96, #147). Nothing here logs.
//
// The lap and stint rows come from createLaps over the same events: a snapshot carries all of them, a `laps` event the
// rows that changed since the last send. So do the pit rows (#219): createPits over the recording's own session's
// PitLaneTimeCollection and PitStopSeries lines, which stay UNPARSED (never applied, kept or sent as deltas), so the
// browser gets the derived rows only (`source: 'f1-live'`, `filled: {}`). The weather rows are one per applied
// WeatherData delta since the last session switch, at most the last MAX_WEATHER_ROWS (withWeatherRow).
//
// With `pos` (P7a, pos=1, A§11.3): `Position.z` streams as `pos` events, still never applied or kept in the state.

type Snapshot = {
  t: number;
  state: Obj;
  laps: Lap[];
  stints: Stints;
  pits: Pits;
  weather: Weather;
  pos?: PlaybackPos | null;
};
/** `state` is the stream's own, which changes on the next `next()`: serialize it before. `weather` is never mutated. */
export type PlaybackEvent =
  | { event: 'snapshot'; data: Snapshot }
  | { event: 'delta'; data: { t: number; topic: string; data: unknown } }
  | { event: 'laps'; data: { t: number; laps: Lap[]; stints: Stints; pits: Pits } }
  | { event: 'pos'; data: PlaybackPos }
  | { event: 'end'; data: { t: number } }
  | { event: 'ping'; data: { t: number } };

const BEHIND_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const LAPS_MS = 1_000;
const TAIL_MS = 1_000;
const ENDED_MS = 30_000;
const CHUNK = 64 * 1024;
const AGAIN_MS = 50;
const POS_MS = 500; // T4: the first Position entry per 500 ms of t, at most 2 Hz
const FRAME_MS = 30_000; // without a frame, asked again at most this often (a live session's first lap, T5)
const keyOf = (info: unknown) => (isObj(info) && typeof info.Key === 'number' ? info.Key : undefined);
// The topics the lap rows read: the engine's two, and A§9's race control and qualifying parts (lapRows).
const LAP_TOPICS = new Set(['TimingData', 'TimingAppData', 'RaceControlMessages', 'SessionData']);
const PIT_TOPICS = new Set(['PitLaneTimeCollection', 'PitStopSeries']);

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
      top_kph: null, // telemetry is stored per lap after the session, never in the stream (P7b)
      full_throttle: null,
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
      const st = await fh.stat();
      if (!st.isFile()) throw notFile(); // NOFOLLOW opened a FIFO without blocking
      const { ino } = st;
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

const ignore = () => {};
/** `p`'s value, or undefined as soon as `signal` aborts. */
const untilAbort = <T>(p: Promise<T>, signal: AbortSignal) =>
  new Promise<T | undefined>((resolve, reject) => {
    const stop = () => resolve(undefined);
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });

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
  /**
   * Called once, just before the open's snapshot is yielded (#101): the seek's wall time in ms on `now` (reading,
   * parsing and the lap rows) and the lines it applied. Never for a later snapshot (a switch or a backlog).
   */
  onOpen?: (seek: { ms: number; lines: number }) => void;
  /**
   * pos=1 (P7a, A§11.3): the session's map frame (T5), awaited before the seek and asked again at most every FRAME_MS
   * while there is none; a failed decode is counted in `counts`, never thrown. Without it the stream is as before.
   */
  pos?: { frame: () => Promise<Frame | undefined>; counts: Record<ZFail, number> };
}): AsyncGenerator<PlaybackEvent> {
  const start = o.now();
  let frame: Frame | undefined;
  if (o.pos) {
    // An abort during a fit ends the stream and frees its slot.
    frame = await untilAbort(o.pos.frame(), o.signal);
    if (o.signal.aborted) return;
  }
  // The replay clock starts after the fit, so a slow one is no backlog (BEHIND_MS); onOpen's ms still counts it.
  const begun = o.pos ? o.now() : start;
  const T = () => (o.at === 'live' ? o.now() - o.delay * 1000 : o.at + (o.now() - begun) * o.speed);
  let asked = begun;
  let asking = false;
  /** The last Position.z line applied, raw: decoded only for a snapshot or while streaming. */
  let lastPos: { payload: unknown; r: number } | undefined;
  let bucket = Number.NEGATIVE_INFINITY; // POS_MS bucket of the last position sent
  const feed = createFeed();
  let weather: Weather = [];
  const engine = createLaps(o.sessionKey, 'f1-live');
  const pits = createPits(o.sessionKey); // one per stream: a seek is a new stream, read from line 1
  const sent = new Map<string, string>(); // row key → the row's JSON as last sent
  let dirty = false; // a LAP_TOPICS change since the rows were last sent
  let lapsAt = Number.NEGATIVE_INFINITY; // wall time of the last `laps` check
  let applied = Number.NEGATIVE_INFINITY; // receivedAt of the last line applied

  /**
   * The kept line's Position entries on the receive axis (A§10): t = r − (newest − Timestamp), so t ≤ r ≤ T. Each car
   * (OffTrack too, D3) in outline metres.
   */
  const entries = (kept: { payload: unknown; r: number }, f: Frame, counts: Record<ZFail, number>): PlaybackPos[] => {
    const z = decodeZ(kept.payload);
    if (!z.ok) {
      counts[z.fail]++;
      return [];
    }
    const list = positions(z.value);
    const newest = Math.max(...list.map((e) => e.t));
    return list.map(({ t, cars }) => ({
      t: kept.r - (newest - t),
      cars: Object.fromEntries(cars.map(([n, s]) => [String(n), toOutline(f, s.x, s.y)])),
    }));
  };
  /** Applies one line, its deltas into `out`. True when it switched the session: the state was cleared first. */
  const apply = (line: Line, out?: PlaybackEvent[]) => {
    let switched = false;
    applied = line.r;
    for (const ev of parseFeedLine(line.text)) {
      // Not a Subscribe state's (`full`): it can be an hour old (A§11.3), yet it would be kept and sent at its line's r.
      if (ev.topic === 'Position.z' && o.pos && !ev.full) {
        lastPos = { payload: ev.payload, r: line.r };
        // Streaming only: the seek keeps the line and decodes none (A§11.3).
        if (!out || !frame) continue;
        for (const p of entries(lastPos, frame, o.pos.counts)) {
          const b = Math.floor(p.t / POS_MS);
          if (b <= bucket || Object.keys(p.cars).length === 0) continue;
          bucket = b;
          out.push({ event: 'pos', data: p });
        }
        continue;
      }
      // The pit topics stay UNPARSED (never applied, kept or sent); the recording's own session's feed the pit rows, the
      // builder gates them on SessionInfo.Key, so it sees every SessionInfo too.
      if (PIT_TOPICS.has(ev.topic) || ev.topic === 'SessionInfo') {
        pits.push(ev);
        dirty ||= PIT_TOPICS.has(ev.topic);
      }
      if (ev.topic.endsWith('.z') || UNPARSED.has(ev.topic)) continue;
      // A new session's SessionInfo: no topic of the previous session stays (no ghost driver, line or message). The
      // laps engine keeps going: it holds the recording's session only.
      if (ev.topic === 'SessionInfo') {
        const [key, current] = [keyOf(ev.payload), keyOf(feed.state.SessionInfo)];
        if (key !== undefined && current !== undefined && key !== current) {
          for (const topic of Object.keys(feed.state)) delete feed.state[topic];
          weather = [];
          lastPos = undefined;
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
    const pit: Pits = pits
      .rows()
      .rows.sort((a, b) => a.date - b.date || a.driver_number - b.driver_number || a.lap_number - b.lap_number)
      .map(({ date, ...p }) => ({
        ...p,
        date: new Date(date).toISOString(),
        pit_ms: null,
        source: 'f1-live',
        filled: {},
      }));
    return {
      laps: unsent(all.laps, (l) => `lap ${l.driver_number} ${l.lap_number}`),
      stints: unsent(all.stints, (s) => `stint ${s.driver_number} ${s.stint_number}`),
      pits: unsent(pit, (p) => `pit ${p.driver_number} ${p.lap_number}`),
    };
  };
  /**
   * The snapshot's position: the last line's newest entry, decoded once (A§11.3), or no cars without one; null without
   * a frame (T5). The events go on from its bucket.
   */
  const posAt = (t: number, counts: Record<ZFail, number>): PlaybackPos | null => {
    const kept = lastPos;
    const newest = kept && frame ? entries(kept, frame, counts).findLast((e) => e.t === kept.r) : undefined;
    const pos = frame ? (newest ?? { t, cars: {} }) : null;
    bucket = Math.floor((pos?.t ?? t) / POS_MS);
    return pos;
  };
  // ponytail: every open sends all lap rows uncompressed, about 0.65 MB for a full race (Caddy leaves the SSE route
  // uncompressed); a compact or compressed form if that hurts.
  const snapshot = (t: number): PlaybackEvent => {
    sent.clear();
    const data: Snapshot = { t, state: feed.state, ...rows(), weather };
    if (o.pos) data.pos = posAt(t, o.pos.counts);
    return { event: 'snapshot', data };
  };
  const changes = (): PlaybackEvent | undefined => {
    lapsAt = o.now();
    const data = { t: applied, ...rows() };
    return data.laps.length + data.stints.length + data.pits.length > 0 ? { event: 'laps', data } : undefined;
  };

  // Seek: every line from the first one up to T, through one feed (its duplicate filter sees every line) and the laps.
  // ponytail: a full scan per stream open, ~1.1 s for a 4 h race on WSL and more on the VM's 1 CPU; a per-recording
  // scan cache if that hurts. `onOpen` measures it: the api logs it per open (#101, A§11.3 "Cost").
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
    let seeked = 0;
    for (; line && line.r <= at; line = await seekNext()) {
      apply(line);
      seeked++;
    }
    const first = snapshot(at);
    o.onOpen?.({ ms: o.now() - start, lines: seeked });
    yield first;

    let wrote = o.now();
    let polled = Number.NEGATIVE_INFINITY;
    let ending = false;
    while (!o.signal.aborted) {
      if (o.pos && !frame && !asking && o.now() - asked >= FRAME_MS) {
        // In the background: the stream goes on, and the events start with the frame. createFrames never rejects.
        [asking, asked] = [true, o.now()];
        o.pos
          .frame()
          .then((f) => {
            frame = f;
          }, ignore)
          .finally(() => {
            asking = false;
          });
      }
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
