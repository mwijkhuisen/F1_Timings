import {
  type Lap,
  merge,
  type Obj,
  PlaybackDelta,
  PlaybackEnd,
  PlaybackLaps,
  PlaybackSnapshot,
  type Stints,
} from '@f1/contracts';

// The playback stream (A§10, A§11.3): state at T over SSE, framework-free. Every event is parsed with its contract;
// a delta merges into the state as the server's feed does. EventSource's own retry would reconnect to the same URL,
// so the same stale `at`: on an error the stream closes itself and the caller reopens (views/Player.tsx).

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

/** Opens one stream; the returned function closes it (idempotent). */
export function openStream(params: StreamParams, h: Handlers, ES: typeof EventSource = globalThis.EventSource) {
  const es = new ES(streamUrl(params));
  let feed: Feed | undefined;
  let open = true;
  const close = () => {
    open = false;
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
  on('end', PlaybackEnd, (d) => {
    close();
    h.onEnd(d.t);
  });
  es.addEventListener('error', fail);
  return close;
}

/** What React renders: a new object per flush; `laps` is a new array only when the rows changed. */
export type Snap = { rev: number; feed: Feed | undefined; laps: Lap[] };

/** Holds the latest feed and notifies at most every `everyMs`, so a burst of deltas is one render. */
export function createStore(everyMs = 250) {
  let snap: Snap = { rev: 0, feed: undefined, laps: [] };
  let pending: Feed | undefined;
  let lapsDirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<() => void>();
  const flush = () => {
    timer = undefined;
    const laps = lapsDirty && pending ? [...pending.laps.values()] : snap.laps;
    snap = { rev: snap.rev + 1, feed: pending, laps };
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
