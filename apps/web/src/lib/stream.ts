import {
  type Lap,
  merge,
  type Obj,
  PlaybackDelta,
  PlaybackEnd,
  PlaybackLaps,
  PlaybackPing,
  PlaybackSnapshot,
  type Stints,
  view,
} from '@f1/contracts';

// The playback stream (A§10, A§11.3): state at T over SSE, framework-free. Every event is parsed with its contract;
// a delta merges into the state as the server's feed does. EventSource's own retry would reconnect to the same URL,
// so the same stale `at`: on an error the stream closes itself and the caller reopens (views/Player.tsx). A half-open
// connection raises no error, so a stream with no event at all (the server pings after 15 s) for 40 s fails too.

export type Stint = Stints[number];
export type StreamParams = { recording: number; at: number | 'live'; delay: number };
/** Mutated in place by every event; a snapshot starts a new one. */
export type Feed = { t: number; state: Obj; laps: Map<string, Lap>; stints: Map<string, Stint> };
export type Handlers = {
  onData(feed: Feed, kind: 'snapshot' | 'delta' | 'laps'): void;
  onError(): void;
  onEnd(t: number): void;
};

export const streamUrl = ({ recording, at, delay }: StreamParams): string =>
  `/api/v1/playback/${recording}/stream?${at === 'live' ? `at=live&delay=${delay}` : `at=${at}`}`;

const lapKey = (l: Lap) => `${l.driver_number}:${l.lap_number}`;
const stintKey = (s: Stint) => `${s.driver_number}:${s.stint_number}`;

function putRows(feed: Feed, rows: { laps: Lap[]; stints: Stint[] }) {
  for (const l of rows.laps) feed.laps.set(lapKey(l), l);
  for (const s of rows.stints) feed.stints.set(stintKey(s), s);
}

export const SILENT_MS = 40_000; // about 2.5 heartbeats
// Checked every second against the wall clock, so a page resumed from the background (timers throttled or frozen)
// finds a dead stream within a second, and a healthy one, whose events kept arriving, is left alone.
const WATCH_MS = 1_000;

/** Opens one stream; the returned function closes it (idempotent). */
export function openStream(params: StreamParams, h: Handlers, ES: typeof EventSource = globalThis.EventSource) {
  const es = new ES(streamUrl(params));
  let feed: Feed | undefined;
  let open = true;
  let heard = Date.now();
  const watch = setInterval(() => {
    if (Date.now() - heard >= SILENT_MS) fail();
  }, WATCH_MS);
  const close = () => {
    open = false;
    clearInterval(watch);
    es.close();
  };
  const fail = () => {
    if (!open) return;
    close();
    h.onError();
  };
  const on = <T>(name: string, contract: { parse(v: unknown): T }, apply: (d: T) => void) =>
    es.addEventListener(name, (e) => {
      if (!open) return;
      heard = Date.now();
      let d: T;
      try {
        d = contract.parse(JSON.parse((e as MessageEvent<string>).data));
      } catch {
        fail();
        return;
      }
      apply(d);
    });

  on('snapshot', PlaybackSnapshot, (d) => {
    // merge copies into prototype-free objects and drops unsafe keys, as on the server.
    feed = { t: d.t, state: Object.create(null), laps: new Map(), stints: new Map() };
    merge(feed.state, d.state);
    putRows(feed, d);
    h.onData(feed, 'snapshot');
  });
  on('delta', PlaybackDelta, (d) => {
    if (!feed) return;
    feed.t = d.t;
    // One merge at the root: an object merges into state[topic] (created first), anything else replaces it.
    merge(feed.state, { [d.topic]: d.data });
    h.onData(feed, 'delta');
  });
  on('laps', PlaybackLaps, (d) => {
    if (!feed) return;
    feed.t = d.t;
    putRows(feed, d);
    h.onData(feed, 'laps');
  });
  on('ping', PlaybackPing, () => {}); // liveness only
  on('end', PlaybackEnd, (d) => {
    close();
    h.onEnd(d.t);
  });
  es.addEventListener('error', fail);
  return close;
}

export type Marker = { kind: 'start' | 'red' | 'chequered'; t: number };

/** A feed Utc in epoch ms, read as UTC with or without its Z; NaN when absent or unparsable. */
export const utc = (v: string | undefined) =>
  v === undefined ? Number.NaN : Date.parse(v.endsWith('Z') ? v : `${v}Z`);

/**
 * The session's start, red flags and chequered flags so far, from `SessionData.StatusSeries` alone (A§13). A Started
 * followed within 60 s by the next entry with a SessionStatus is the race's 2 s blip (A§11.1); a TrackStatus-only entry
 * does not count. Red is every TrackStatus Red, chequered every SessionStatus Finished. RaceControl is not read: a red
 * flag can arrive without its `Flag: RED` (A§11.3).
 */
export function markers(state: Obj): Marker[] {
  const out: Marker[] = [];
  const series = Object.values(view(state, 'SessionData')?.StatusSeries ?? {})
    .flatMap((s) => (s ? [{ ...s, t: utc(s.Utc) }] : []))
    .filter((s) => !Number.isNaN(s.t))
    .sort((a, b) => a.t - b.t);
  series.forEach((s, i) => {
    if (s.TrackStatus === 'Red') out.push({ kind: 'red', t: s.t });
    if (s.SessionStatus === 'Finished') out.push({ kind: 'chequered', t: s.t });
    if (s.SessionStatus !== 'Started') return;
    const next = series.slice(i + 1).find((n) => n.SessionStatus !== undefined);
    if (!(next && next.t - s.t <= 60_000)) out.push({ kind: 'start', t: s.t });
  });
  return out;
}

/**
 * What React renders: a new object per flush, so it is the key for everything derived from the state. `laps` is a new
 * array only when the rows changed; `marks` is every marker seen since the store was made (the page visit): the stream
 * delivers nothing ahead of T, so none is a spoiler.
 */
export type Snap = { rev: number; feed: Feed | undefined; laps: Lap[]; marks: Marker[] };

/** Holds the latest feed and notifies at most every `everyMs`, so a burst of deltas is one render. */
export function createStore(everyMs = 250) {
  let snap: Snap = { rev: 0, feed: undefined, laps: [], marks: [] };
  let pending: Feed | undefined;
  let lapsDirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Map<string, Marker>();
  const subs = new Set<() => void>();
  const flush = () => {
    timer = undefined;
    const laps = lapsDirty && pending ? [...pending.laps.values()] : snap.laps;
    const before = seen.size;
    if (pending) for (const m of markers(pending.state)) seen.set(`${m.kind}:${m.t}`, m);
    const marks = seen.size === before ? snap.marks : [...seen.values()];
    snap = { rev: snap.rev + 1, feed: pending, laps, marks };
    lapsDirty = false;
    for (const f of subs) f();
  };
  return {
    get: () => snap,
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    update(feed: Feed, kind: 'snapshot' | 'delta' | 'laps') {
      pending = feed;
      lapsDirty ||= kind !== 'delta';
      if (timer === undefined) timer = setTimeout(flush, everyMs);
    },
  };
}
