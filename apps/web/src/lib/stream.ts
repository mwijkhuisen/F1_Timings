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
  type Weather,
  weatherRow,
  withWeatherRow,
} from '@f1/contracts';

// The playback stream (A§10, A§11.3): state at T over SSE, framework-free. Every event is parsed with its contract;
// a delta merges into the state as the server's feed does. EventSource's own retry would reconnect to the same URL,
// so the same stale `at`: on an error the stream closes itself and the caller reopens (views/Player.tsx). A half-open
// connection raises no error, so a stream with no event at all (the server pings after 15 s) for 40 s fails too.
// The weather rows (P5b): the snapshot's, then one per WeatherData delta, read from the merged view at the delta's t.

export type Stint = Stints[number];
export type StreamParams = { recording: number; at: number | 'live'; delay: number };
/** Mutated in place by every event; a snapshot starts a new one. `weather` is a new array per row. */
export type Feed = { t: number; state: Obj; laps: Map<string, Lap>; stints: Map<string, Stint>; weather: Weather };
export type Handlers = {
  onData(feed: Feed, kind: 'snapshot' | 'delta' | 'laps'): void;
  onError(): void;
  /** An event failed its contract: the build and the server differ, and a reconnect cannot fix that (A§13). */
  onStale(): void;
  onEnd(t: number): void;
};

export const streamUrl = ({ recording, at, delay }: StreamParams): string =>
  `/api/v1/playback/${recording}/stream?${at === 'live' ? `at=live&delay=${delay}` : `at=${at}`}`;

export type Probe = 'expired' | 'offline' | 'missing' | 'up';

/**
 * One HEAD on a failed stream's URL (#100): the route answers it after its checks, before the cap, with no body (A§10).
 * 401 is an expired Access session, 404 a recording whose files are gone, anything else a server that has it. A throw
 * is no network, or Access's login redirect under `redirect: 'error'`; an abort lands there too, and the caller drops
 * it. It never reads a body.
 */
export async function probeStream(url: string, signal: AbortSignal): Promise<Probe> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'error', signal });
    return res.status === 401 ? 'expired' : res.status === 404 ? 'missing' : 'up';
  } catch {
    return navigator.onLine === false ? 'offline' : 'expired';
  }
}

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
  const stale = () => {
    if (!open) return;
    close();
    h.onStale();
  };
  const on = <T>(name: string, contract: { parse(v: unknown): T }, apply: (d: T) => void) =>
    es.addEventListener(name, (e) => {
      if (!open) return;
      heard = Date.now();
      let d: T;
      try {
        d = contract.parse(JSON.parse((e as MessageEvent<string>).data));
      } catch {
        stale();
        return;
      }
      apply(d);
    });

  on('snapshot', PlaybackSnapshot, (d) => {
    // merge copies into prototype-free objects and drops unsafe keys, as on the server.
    feed = { t: d.t, state: Object.create(null), laps: new Map(), stints: new Map(), weather: [...d.weather] };
    merge(feed.state, d.state);
    putRows(feed, d);
    h.onData(feed, 'snapshot');
  });
  on('delta', PlaybackDelta, (d) => {
    if (!feed) return;
    feed.t = d.t;
    // One merge at the root: an object merges into state[topic] (created first), anything else replaces it.
    merge(feed.state, { [d.topic]: d.data });
    // After the merge, as the server does: a row is the whole station reading at t, not the delta's fields.
    if (d.topic === 'WeatherData')
      feed.weather = withWeatherRow(feed.weather, weatherRow(view(feed.state, 'WeatherData'), d.t));
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

/** A feed Utc in epoch ms, read as UTC with or without its Z; NaN when absent or unparsable. */
export const utc = (v: string | undefined) =>
  v === undefined ? Number.NaN : Date.parse(v.endsWith('Z') ? v : `${v}Z`);

/**
 * What React renders: a new object per flush, so it is the key for everything derived from the state. `laps` is a new
 * array only when the rows changed; `weather` a new pair only when the weather rows changed.
 */
export type Snap = { rev: number; feed: Feed | undefined; laps: Lap[]; weather: { rows: Weather; laps: Lap[] } };

/** Holds the latest feed and notifies at most every `everyMs`, so a burst of deltas is one render. */
export function createStore(everyMs = 250) {
  let snap: Snap = { rev: 0, feed: undefined, laps: [], weather: { rows: [], laps: [] } };
  let pending: Feed | undefined;
  let lapsDirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<() => void>();
  const flush = () => {
    timer = undefined;
    const laps = lapsDirty && pending ? [...pending.laps.values()] : snap.laps;
    // The Weather tab's chart option is rebuilt only when the rows change (about once a minute), not on every `laps`
    // event (up to one a second in a race): its lap rows are those as of the last row change.
    const rows = pending?.weather ?? snap.weather.rows;
    const weather = rows === snap.weather.rows ? snap.weather : { rows, laps };
    snap = { rev: snap.rev + 1, feed: pending, laps, weather };
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
