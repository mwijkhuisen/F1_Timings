import {
  type Lap,
  merge,
  type Obj,
  type Pits,
  PlaybackDelta,
  PlaybackEnd,
  PlaybackLaps,
  PlaybackPing,
  PlaybackPos,
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
// A live delay above the open stream's own holds each event inside the stream instead of reopening it (#101).
// The weather rows (P5b): the snapshot's, then one per WeatherData delta, read from the merged view at the delta's t.

export type Stint = Stints[number];
export type Pit = Pits[number];
/** `still`: a still frame (a paused seek, or a load that resumes at `?t`, A§13), which the server only logs (#101). */
export type StreamParams = { recording: number; at: number | 'live'; delay: number; still?: boolean; pos?: boolean };
/**
 * The car positions (P7a, A§11.3), one sample per car: x and y in integer metres of the circuit outline's frame, `t` on
 * the receive axis and `run` the first t of the car's gap-free run (a gap over RUN_GAP_MS between its samples starts a
 * new one). `at` is the newest t. A new object per `pos` event or snapshot.
 */
export type Positions = { at: number; cars: Record<string, { x: number; y: number; t: number; run: number }> };
/** A car's samples further apart than this are not one run (T3, A§11.3): the dot jumps instead of gliding. */
export const RUN_GAP_MS = 1500;
/**
 * Mutated in place by every event; a snapshot starts a new one. `weather` is a new array per row. `pos`: undefined when
 * the stream did not ask for positions, null while the session has no fitted frame. A `pos` event replaces it and never
 * touches `t`: its t sits behind the newest receive time.
 */
export type Feed = {
  t: number;
  state: Obj;
  laps: Map<string, Lap>;
  stints: Map<string, Stint>;
  /** The server's derived pit rows (#219), keyed driver:lap. */
  pits: Map<string, Pit>;
  weather: Weather;
  pos?: Positions | null;
};
export type Handlers = {
  onData(feed: Feed, kind: 'snapshot' | 'delta' | 'laps' | 'pos'): void;
  onError(): void;
  /** An event failed its contract: the build and the server differ, and a reconnect cannot fix that (A§13). */
  onStale(): void;
  onEnd(t: number): void;
};

export const streamUrl = ({ recording, at, delay, still, pos }: StreamParams): string =>
  `/api/v1/playback/${recording}/stream?${at === 'live' ? `at=live&delay=${delay}` : `at=${at}${still ? '&still=1' : ''}`}${pos ? '&pos=1' : ''}`;

export type Probe = 'expired' | 'offline' | 'missing' | 'up' | 'error';

/**
 * One HEAD on a failed stream's URL (#100): the route answers it after its checks, before the cap, with no body (A§10).
 * 401 is an expired Access session, 404 a recording whose files are gone, a 2xx a server that has it (the route's checks
 * passed), any other status a server error. A throw
 * is no network, or Access's login redirect under `redirect: 'error'`; an abort lands there too, and the caller drops
 * it. It never reads a body.
 */
export async function probeStream(url: string, signal: AbortSignal): Promise<Probe> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'error', signal });
    return res.status === 401 ? 'expired' : res.status === 404 ? 'missing' : res.ok ? 'up' : 'error';
  } catch {
    return navigator.onLine === false ? 'offline' : 'expired';
  }
}

const lapKey = (l: Lap) => `${l.driver_number}:${l.lap_number}`;
const stintKey = (s: Stint) => `${s.driver_number}:${s.stint_number}`;
const pitKey = (p: Pit) => `${p.driver_number}:${p.lap_number}`;

function putRows(feed: Feed, rows: { laps: Lap[]; stints: Stint[]; pits: Pit[] }) {
  for (const l of rows.laps) feed.laps.set(lapKey(l), l);
  for (const s of rows.stints) feed.stints.set(stintKey(s), s);
  for (const p of rows.pits) feed.pits.set(pitKey(p), p);
}

export const SILENT_MS = 40_000; // about 2.5 heartbeats
// Checked every second against the wall clock, so a page resumed from the background (timers throttled or frozen)
// finds a dead stream within a second, and a healthy one, whose events kept arriving, is left alone.
const WATCH_MS = 1_000;

/**
 * The open stream: `close` is idempotent; `hold` sets how long each event waits after it arrives before it is applied
 * (#101, A§13: a live delay above the stream's own). The wait is from the arrival, never from `t` against this
 * device's clock, so a phone whose clock is off adds no delay: the server already paces the events at its T.
 */
export type Stream = { close(): void; hold(ms: number): void };

/** Held events past this fail the stream (a reopen at the current delay holds nothing); 120 s of a race is far fewer. */
export const MAX_HELD = 20_000;

/** Opens one stream, holding nothing until `hold` says so: each event is applied as it arrives. */
export function openStream(params: StreamParams, h: Handlers, ES: typeof EventSource = globalThis.EventSource): Stream {
  const es = new ES(streamUrl(params));
  let feed: Feed | undefined;
  let open = true;
  let heard = Date.now();
  let held = 0;
  // `end` has arrived: the server closes the response after it, so the transport is done (its `error` is no failure),
  // and only the held events, `end` last, are left to apply.
  let ending = false;
  // In arrival order. Parsed on arrival, so a contract failure is stale at once; applied once due.
  const queue: { arrived: number; apply: () => void }[] = [];
  let due: ReturnType<typeof setTimeout> | undefined;
  const watch = setInterval(() => {
    if (Date.now() - heard >= SILENT_MS) fail();
  }, WATCH_MS);
  const close = () => {
    open = false;
    clearInterval(watch);
    clearTimeout(due);
    queue.length = 0;
    es.close();
  };
  const fail = () => {
    if (!open || ending) return;
    close();
    h.onError();
  };
  const stale = () => {
    if (!open) return;
    close();
    h.onStale();
  };
  /** Applies every due event in order, then waits for the next one. */
  const drain = () => {
    clearTimeout(due);
    due = undefined;
    for (let next = queue[0]; open && next && next.arrived + held <= Date.now(); next = queue[0]) {
      queue.shift();
      next.apply();
    }
    const next = queue[0];
    if (open && next) due = setTimeout(drain, next.arrived + held - Date.now());
  };
  const later = (apply: () => void) => {
    if (queue.length === 0 && held === 0) return apply(); // nothing held: as it arrives
    if (queue.length >= MAX_HELD) return fail();
    queue.push({ arrived: Date.now(), apply });
    if (queue.length === 1) drain();
  };
  /** `hold: false` for the heartbeat: it is liveness only and changes nothing on the page. */
  const on = <T>(
    name: string,
    contract: { parse(v: unknown): T },
    apply: (d: T) => void,
    hold = true,
    arrived?: () => void,
  ) =>
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
      if (hold) later(() => apply(d));
      else apply(d);
      if (open) arrived?.();
    });

  on('snapshot', PlaybackSnapshot, (d) => {
    // merge copies into prototype-free objects and drops unsafe keys, as on the server.
    feed = {
      t: d.t,
      state: Object.create(null),
      laps: new Map(),
      stints: new Map(),
      pits: new Map(),
      weather: [...d.weather],
    };
    if (d.pos !== undefined) feed.pos = d.pos && withPos(null, d.pos);
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
  on('pos', PlaybackPos, (d) => {
    if (!feed) return;
    feed.pos = withPos(feed.pos ?? null, d); // not feed.t: the position's t is behind the newest receive time
    h.onData(feed, 'pos');
  });
  on('ping', PlaybackPing, () => {}, false); // liveness only
  on(
    'end',
    PlaybackEnd,
    (d) => {
      close();
      h.onEnd(d.t);
    },
    true,
    () => {
      // Still held: close the transport and the watchdog now, and let the queue drain to the `end`.
      ending = true;
      clearInterval(watch);
      es.close();
    },
  );
  es.addEventListener('error', fail);
  return {
    close,
    hold(ms) {
      held = Math.max(0, ms);
      if (open) drain();
    },
  };
}

/** `prev` with the event's cars put in, as a new object; a car's run goes on while its samples are within RUN_GAP_MS. */
function withPos(prev: Positions | null, d: PlaybackPos): Positions {
  const cars = { ...prev?.cars };
  for (const [n, [x, y]] of Object.entries(d.cars)) {
    const was = cars[n];
    cars[n] = { x, y, t: d.t, run: was && d.t - was.t <= RUN_GAP_MS ? was.run : d.t };
  }
  return { at: d.t, cars };
}

/** A feed Utc in epoch ms, read as UTC with or without its Z; NaN when absent or unparsable. */
export const utc = (v: string | undefined) =>
  v === undefined ? Number.NaN : Date.parse(v.endsWith('Z') ? v : `${v}Z`);

/**
 * What React renders: a new object per flush, so it is the key for everything derived from the state. `laps`,
 * `stints` and `pits` are new arrays only when the rows changed (a snapshot or a `laps` event); `weather` a new pair
 * only when the weather rows changed. The positions are not in it (P7a review): a `pos` event leaves it as it was.
 */
export type Snap = {
  rev: number;
  feed: Feed | undefined;
  laps: Lap[];
  stints: Stint[];
  pits: Pit[];
  weather: { rows: Weather; laps: Lap[] };
};

/** The store's positions channel (P7a): the feed's positions as of the last flush, for `useSyncExternalStore`. */
export type PosChannel = { get(): Positions | null | undefined; subscribe(f: () => void): () => void };

const subscriber = (subs: Set<() => void>) => (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/**
 * Holds the latest feed and notifies at most every `everyMs`, so a burst of deltas is one render. The positions have
 * their own channel on the same flush: a `pos` event (2–4 a second) renders the map only, never what `Snap` keys.
 */
export function createStore(everyMs = 250) {
  let snap: Snap = { rev: 0, feed: undefined, laps: [], stints: [], pits: [], weather: { rows: [], laps: [] } };
  let pos: Positions | null | undefined;
  let pending: Feed | undefined;
  let [snapDirty, lapsDirty] = [false, false];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [subs, posSubs] = [new Set<() => void>(), new Set<() => void>()];
  const flush = () => {
    timer = undefined;
    if (pending?.pos !== pos) {
      pos = pending?.pos; // a new object per `pos` event or snapshot
      for (const f of posSubs) f();
    }
    if (!snapDirty) return;
    snapDirty = false;
    const laps = lapsDirty && pending ? [...pending.laps.values()] : snap.laps;
    const stints = lapsDirty && pending ? [...pending.stints.values()] : snap.stints;
    const pits = lapsDirty && pending ? [...pending.pits.values()] : snap.pits;
    // The Weather tab's chart option is rebuilt only when the rows change (about once a minute), not on every `laps`
    // event (up to one a second in a race): its lap rows are those as of the last row change.
    const rows = pending?.weather ?? snap.weather.rows;
    const weather = rows === snap.weather.rows ? snap.weather : { rows, laps };
    snap = { rev: snap.rev + 1, feed: pending, laps, stints, pits, weather };
    lapsDirty = false;
    for (const f of subs) f();
  };
  return {
    get: () => snap,
    subscribe: subscriber(subs),
    pos: { get: () => pos, subscribe: subscriber(posSubs) } satisfies PosChannel,
    update(feed: Feed, kind: 'snapshot' | 'delta' | 'laps' | 'pos') {
      pending = feed;
      snapDirty ||= kind !== 'pos';
      lapsDirty ||= kind === 'snapshot' || kind === 'laps';
      if (timer === undefined) timer = setTimeout(flush, everyMs);
    },
  };
}
