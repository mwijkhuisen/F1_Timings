import { type Obj, type SessionDetail, view } from '@f1/contracts';
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  fastestSoFar,
  fmtLeft,
  LIGHT,
  leftAt,
  raceControl,
  running,
  type Strip as StripData,
  stripOf,
  withinASecond,
} from '../lib/pitwall.ts';
import {
  lastStop,
  type Mark,
  type MarkKind,
  markersUpTo,
  type Status,
  skipped,
  skippedText,
  statusSeries,
} from '../lib/replay.ts';
import { setTitleWord } from '../lib/routes.ts';
import { createStore, type Feed, openStream, type Snap } from '../lib/stream.ts';
import { fmtClock, parseT } from '../lib/time.ts';
import { KIND_LABEL, KIND_NAME, type Kind } from '../lib/track.ts';
import { LapTable } from './LapTable.tsx';
import { Panel, Strip, useTick } from './PitWall.tsx';
import { RainMapCard } from './RainMap.tsx';
import { driverOf, Tower } from './Tower.tsx';
import { WeatherPanels } from './Weather.tsx';

// The player (A§13): one playback stream at a time; the bar holds the clock line, the seek bar with the marks at or
// before T, the transport, the "Back to" chips, the delay slider (live) and the announcements toggle; minimized
// (`f1.minimized`), only the clock line, Play/Pause and the Controls toggle, while the stream plays on. `open.at` is the
// open stream's start: 'live', epoch ms (replay), or null while paused; a `still` stream only fetches the state at a
// paused T and closes on its snapshot. Only the clock line, the seek bar, the Back to chips and the strip's LEFT cell
// (and, on the Weather tab, the rain map) tick each second, from values derived per flush (no state parsing per tick);
// the tower, the pit wall and everything else derived from the state render on a store flush. The tabs are Tower ·
// Laps · Weather; the Weather tab shows the feed's weather rows up to T (P5b), redrawn only when a row arrives, and the
// rain map's frames up to T (P5c).

/** A SessionDetail whose drivers and results come from the stream: OpenF1 has no drivers during a live session. */
function streamDetail(detail: SessionDetail, state: Obj): SessionDetail {
  const drivers = new Map(detail.drivers.map((d) => [d.driver_number, d]));
  for (const [n, d] of Object.entries(view(state, 'DriverList') ?? {}))
    if (d && /^\d{1,3}$/.test(n))
      drivers.set(Number(n), {
        driver_number: Number(n),
        acronym: d.Tla ?? null,
        full_name: d.FullName ?? null,
        team_name: d.TeamName ?? null,
        team_colour: d.TeamColour ?? null,
      });
  const lines = Object.entries(view(state, 'TimingData')?.Lines ?? {});
  const results = lines.flatMap(([n, l]) =>
    l && /^\d{1,3}$/.test(n)
      ? [
          {
            driver_number: Number(n),
            position: /^\d{1,2}$/.test(l.Position ?? '') ? Number(l.Position) : null,
            laps: null,
            dnf: null,
            dns: null,
            dsq: null,
            durations_ms: null,
            gaps_ms: null,
          },
        ]
      : [],
  );
  return { ...detail, drivers: [...drivers.values()], results: lines.length > 0 ? results : detail.results };
}

const Laps = memo(LapTable);

export const MAX_DELAY = 120;
const DELAY_KEY = 'f1.delay';
const ANNOUNCE_KEY = 'f1.announce';
const MINIMIZED_KEY = 'f1.minimized';
const DEBOUNCE_MS = 400;
const WRITE_T_MS = 15_000;
const SAY_GAP_MS = 5_000;
const NUDGES = [-30, -5, -1, 1, 5, 30];

/** The stored delay in s, or 0 when it is missing, invalid or storage throws. */
export function readDelay(): number {
  try {
    const v = localStorage.getItem(DELAY_KEY);
    return v !== null && /^\d{1,3}$/.test(v) && Number(v) <= MAX_DELAY ? Number(v) : 0;
  } catch {
    return 0;
  }
}

function writeDelay(s: number) {
  try {
    localStorage.setItem(DELAY_KEY, String(s));
  } catch {
    // Private mode or blocked storage: the delay just is not remembered.
  }
}

/** Announcements are on only when stored as '1'; off when storage throws. */
function readAnnounce(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAnnounce(on: boolean) {
  try {
    localStorage.setItem(ANNOUNCE_KEY, on ? '1' : '0');
  } catch {
    // As for the delay: not remembered.
  }
}

/** The bar is minimized only when stored as '1'; expanded when storage throws. */
function readMinimized(): boolean {
  try {
    return localStorage.getItem(MINIMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMinimized(on: boolean) {
  try {
    localStorage.setItem(MINIMIZED_KEY, on ? '1' : '0');
  } catch {
    // As for the delay: not remembered.
  }
}

/** T in the replay's URL (`?t=HH:mm:ss`): replaceState only, so the route stays and nothing is dispatched. */
function writeT(t: number) {
  try {
    history.replaceState(history.state, '', `${location.pathname}?t=${fmtClock(t)}`);
  } catch {
    // A browser that rate-limits replaceState throws (SecurityError): the URL just lags behind T.
  }
}

/** At most one line per `SAY_GAP_MS`: a line that comes sooner replaces the waiting one, said when the gap is over. */
function createVoice(show: (line: string) => void) {
  let on = false;
  let last = Number.NEGATIVE_INFINITY;
  let next = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => {
    timer = undefined;
    last = Date.now();
    show(next);
  };
  return {
    set(v: boolean) {
      on = v;
      clearTimeout(timer);
      timer = undefined;
      if (!v) show('');
    },
    say(line: string) {
      if (!on) return;
      next = line;
      const wait = last + SAY_GAP_MS - Date.now();
      if (wait <= 0) emit();
      else timer ??= setTimeout(emit, wait);
    },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const signed = (s: number) => `${s > 0 ? '+' : '−'}${Math.abs(s)}`;
const nudgeLabel = (s: number) =>
  `${Math.abs(s)} ${Math.abs(s) === 1 ? 'second' : 'seconds'} ${s < 0 ? 'earlier' : 'later'}`;
const hhmm = (t: number) => fmtClock(t).slice(0, 5);
const FAILING = 5; // consecutive errors without a snapshot before the reload hint

const MARK_NAME: Record<MarkKind, string> = { start: 'Start', ...KIND_NAME, chequered: 'Chequered flag' };
/** The chips, in this order: one per kind, for its latest mark at or before T. */
const CHIPS: [MarkKind, string][] = [
  ['start', 'Start'],
  ['sc', KIND_LABEL.sc],
  ['vsc', KIND_LABEL.vsc],
  ['red', KIND_NAME.red],
  ['chequered', 'Chequered flag'],
];
const isBand = (k: MarkKind): k is Kind => k === 'sc' || k === 'vsc' || k === 'red';
const markClass = (m: Mark) =>
  isBand(m.kind) ? `marker m-band m-${m.kind}${m.open ? ' open' : ''}` : `marker m-${m.kind}`;

/** The clock line: T, ticking locally, the time left and the lap (from the strip's values), then the mode. */
function Clock({
  now,
  stateNow,
  playing,
  strip,
  children,
}: {
  now: () => number;
  /** The T the state stands at, for the time left (as the strip's LEFT). */
  stateNow: () => number;
  playing: boolean;
  strip: StripData | undefined;
  children: ReactNode;
}) {
  useTick(playing);
  const T = now();
  return (
    <p className="clockline" aria-live="off">
      <time dateTime={new Date(T).toISOString()}>{fmtClock(T)}</time>
      {strip?.clock && <span className="left">{fmtLeft(leftAt(strip.clock, stateNow()))} left</span>}
      {strip?.lap && (
        <span className="lap">
          Lap {strip.lap.current}
          {strip.lap.total !== undefined && `/${strip.lap.total}`}
        </span>
      )}
      {children}
    </p>
  );
}

/** The seek bar over [lo, hi()], ticking with the clock; the marks at or before T inside it, from the parsed series. */
function Seek({
  now,
  playing,
  lo,
  hi,
  series,
  onSeek,
  ref,
}: {
  now: () => number;
  playing: boolean;
  lo: number;
  hi: () => number;
  series: Status[];
  onSeek(t: number): void;
  ref: Ref<HTMLInputElement>;
}) {
  useTick(playing);
  const T = now();
  const top = Math.max(lo, hi());
  const pct = (t: number) => ((clamp(t, lo, top) - lo) / Math.max(1, top - lo)) * 100;
  return (
    <div className="seek">
      <input
        ref={ref}
        type="range"
        aria-label="Position"
        // Per minute while playing (a per-second change would be read out), per second while paused.
        aria-valuetext={playing ? hhmm(T) : fmtClock(T)}
        min={lo}
        max={top}
        step={1000}
        value={clamp(T, lo, top)}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      {/* A mark outside the recording (a status left over from the day before) is not drawn. */}
      <div className="marks">
        {markersUpTo(series, T, [lo, top]).map((m) => (
          <span
            key={`${m.kind}:${m.t}`}
            className={markClass(m)}
            style={
              {
                '--x': `${pct(m.t)}%`,
                ...(m.end !== undefined && { '--w': `${pct(m.end) - pct(m.t)}%` }),
              } as CSSProperties
            }
            title={`${MARK_NAME[m.kind]} ${fmtClock(m.t)}`}
          />
        ))}
      </div>
    </div>
  );
}

/** "Back to": the latest mark of each kind at or before T, and the focused driver's last stop; seeks only go back. */
function BackTo({
  now,
  playing,
  lo,
  hi,
  series,
  laps,
  focused,
  onSeek,
}: {
  now: () => number;
  playing: boolean;
  lo: number;
  hi: () => number;
  series: Status[];
  laps: Snap['laps'];
  focused: { n: number; tla: string } | null;
  onSeek(t: number): void;
}) {
  useTick(playing);
  const T = now();
  // Sorted by time, so the last of each kind wins.
  const latest = new Map(markersUpTo(series, T, [lo, Math.max(lo, hi())]).map((m) => [m.kind, m.t]));
  const stop = focused && lastStop(laps, focused.n, T);
  if (latest.size === 0 && !stop) return null;
  return (
    <fieldset className="chips" aria-label="Back to">
      <span className="label" aria-hidden="true">
        Back to
      </span>
      {CHIPS.map(([kind, label]) => {
        const t = latest.get(kind);
        return (
          t !== undefined && (
            <button key={kind} type="button" onClick={() => onSeek(t)}>
              {label} {hhmm(t)}
            </button>
          )
        );
      })}
      {stop && (
        <button type="button" onClick={() => onSeek(stop.t)}>
          {focused?.tla} stop L{stop.lap}
        </button>
      )}
    </fieldset>
  );
}

/**
 * The rain map up to T (P5c): the one part of the Weather tab that ticks, as its own component. It re-derives only
 * when T crosses a frame (RainMapCard memoises on the last frame at or before T), so the panels above never redraw.
 */
function PlayerRain({
  detail,
  live,
  now,
  playing,
}: {
  detail: SessionDetail;
  live: boolean;
  now: () => number;
  playing: boolean;
}) {
  useTick(playing);
  return <RainMapCard detail={detail} live={live} cap={now()} />;
}

type Open = { at: number | 'live' | null; still?: true };

export type PlayerRecording = { id: number; started_at: string; ended_at: string | null };

/** The screen stays on while the player plays and the page is visible (A§13); a refusal or no API changes nothing. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !navigator.wakeLock) return;
    let lock: WakeLockSentinel | null = null;
    let gone = false;
    const request = async () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const l = await navigator.wakeLock.request('screen');
        // A second grant while one is held (two quick requests) or after cleanup is let go at once.
        if (gone || (lock && !lock.released)) void l.release().catch(() => {});
        else lock = l;
      } catch {
        // refused (Low Power mode, not visible): the screen may lock, the player plays on
      }
    };
    void request();
    document.addEventListener('visibilitychange', request);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', request);
      lock?.release().catch(() => {});
    };
  }, [on]);
}

export function Player({
  recording,
  sessionKey,
  start,
  detail,
  keepT = false,
}: {
  recording: PlayerRecording;
  /** The recording's session: the tower waits until the feed shows it. */
  sessionKey?: number;
  /** 'live', or the replay's first T in epoch ms; read on mount only. */
  start: number | 'live';
  /** The session from the API; without it there is only the tower. */
  detail: SessionDetail | undefined;
  /** The replay keeps T in the URL (`?t=`) and resumes from it on load; `/live` never does. */
  keepT?: boolean;
}) {
  // A valid ?t, read once on mount: the player resumes paused there (a still frame) until Play.
  const [resumed, setResumed] = useState(() =>
    keepT ? parseT(new URLSearchParams(location.search).get('t'), recording) : null,
  );
  const [delay, setDelay] = useState(readDelay); // shown at once
  const [streamDelay, setStreamDelay] = useState(delay); // the open stream's, 400 ms later
  // A new object (re)opens the stream, even at the same `at` (a reopen after an error).
  const [open, setOpen] = useState<Open>(() => (resumed === null ? { at: start } : { at: resumed, still: true }));
  const at = open.at;
  const playing = at !== null && !open.still;
  useWakeLock(playing);
  const [seek, setSeek] = useState<number | null>(null); // a pending seek, shown on the bar
  const [tab, setTab] = useState<'tower' | 'laps' | 'weather'>('tower');
  // The focused driver's number (a tap on the tower's driver cell); page state that the player bar reads.
  const [focus, setFocus] = useState<string | null>(null);
  const [fails, setFails] = useState(0); // errors since the last snapshot
  const [since, setSince] = useState<string | null>(null); // what the last forward seek skipped
  const [announce, setAnnounce] = useState(readAnnounce);
  // Minimized, the bar keeps only its head (the clock line, Play/Pause and the toggle); the stream is untouched.
  const [minimized, setMinimized] = useState(readMinimized);
  const controlsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState('');
  const [voice] = useState(() => createVoice(setSaid));
  const [store] = useState(() => createStore());
  const snap = useSyncExternalStore(store.subscribe, store.get);
  // T = clock.t + the wall time since clock.wall while playing; resynced to every event's t.
  const clock = useRef({ t: resumed ?? (start === 'live' ? Date.now() - delay * 1000 : start), wall: Date.now() });
  // The T the state stands at while not playing: the pause, the end, or a still frame's snapshot.
  const stood = useRef(clock.current.t);
  const lastFeed = useRef<Feed | undefined>(undefined);
  // Set by a seek commit for its snapshot: `from` is the feed before the seek (its stream is closed by then); `skipped`
  // counts only when the seek went forward.
  const jump = useRef<{ from: Feed | undefined } | undefined>(undefined);
  const backoff = useRef(1000);
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; seek?: ReturnType<typeof setTimeout> }>({});
  // The bounds for a reopen after an error, without reopening when a refetch changes the row.
  const rec = useRef(recording);
  useEffect(() => {
    rec.current = recording;
  }, [recording]);
  const liveDelay = at === 'live' ? streamDelay : 0;

  const nowT = () => (playing ? clock.current.t + Math.max(0, Date.now() - clock.current.wall) : clock.current.t);
  const lo = Date.parse(recording.started_at);
  // A replay ignores the delay (A§13): an open recording's bar ends at now, or now − delay while live.
  const hi = () =>
    recording.ended_at === null ? Date.now() - (at === 'live' ? delay : 0) * 1000 : Date.parse(recording.ended_at);
  const position = useRef<HTMLInputElement>(null);
  const freeze = (t: number) => {
    clock.current = { t, wall: Date.now() };
  };

  useEffect(() => {
    const { at: from, still } = open;
    if (from === null) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const close = openStream(
      { recording: recording.id, at: from, delay: liveDelay },
      {
        onData(feed, kind) {
          clock.current = { t: feed.t, wall: Date.now() };
          stood.current = feed.t;
          store.update(feed, kind);
          lastFeed.current = feed;
          if (kind !== 'snapshot') return;
          backoff.current = 1000;
          setFails(0);
          const j = jump.current;
          if (j) {
            jump.current = undefined;
            const s = j.from && skipped(j.from, feed);
            const text = s ? skippedText(s) : '';
            setSince(text || null);
            voice.say(`At ${fmtClock(feed.t)}.${text ? ` Before this point: ${text}.` : ''}`);
          }
          // A still frame has what it came for: it closes itself (the cleanup's second close is a no-op).
          if (still) {
            close();
            setOpen({ at: null });
          }
        },
        onError() {
          setFails((n) => n + 1);
          const wait = backoff.current;
          backoff.current = Math.min(wait * 2, 30_000);
          retry = setTimeout(() => {
            const t = clock.current.t + Math.max(0, Date.now() - clock.current.wall);
            const { started_at, ended_at } = rec.current;
            const end = ended_at === null ? Date.now() : Date.parse(ended_at);
            // A still frame retries as a still at its own T, which does not run.
            setOpen(
              still
                ? { at: from, still }
                : { at: from === 'live' ? 'live' : Math.round(clamp(t, Date.parse(started_at), end)) },
            );
          }, wait);
        },
        onEnd(t) {
          clock.current = { t, wall: Date.now() };
          stood.current = t;
          setOpen({ at: null });
        },
      },
    );
    return () => {
      close();
      clearTimeout(retry);
    };
  }, [recording.id, open, liveDelay, store, voice]);

  useEffect(
    () => () => {
      clearTimeout(timers.current.delay);
      clearTimeout(timers.current.seek);
    },
    [],
  );
  useEffect(() => {
    voice.set(announce);
    return () => voice.set(false);
  }, [voice, announce]);

  // While playing, the replay's URL follows T every 15 s (a reload then resumes near it).
  useEffect(() => {
    if (!keepT || !playing) return;
    const id = setInterval(() => writeT(clock.current.t + Math.max(0, Date.now() - clock.current.wall)), WRITE_T_MS);
    return () => clearInterval(id);
  }, [keepT, playing]);

  const changeDelay = (s: number) => {
    const v = clamp(Math.round(s), 0, MAX_DELAY);
    setDelay(v);
    writeDelay(v);
    clearTimeout(timers.current.delay);
    timers.current.delay = setTimeout(() => setStreamDelay(v), DEBOUNCE_MS);
  };

  // A seek, a nudge or a chip: shown at once; 400 ms after the last one, T moves there and the stream reopens there,
  // or, while paused, a still frame fetches the state at that T. A pending still frame closes at the first input.
  const seekTo = (t: number) => {
    const v = Math.round(clamp(t, lo, hi()));
    setSeek(v);
    setOpen((o) => (o.still ? { at: null } : o));
    clearTimeout(timers.current.seek);
    timers.current.seek = setTimeout(() => {
      jump.current = { from: lastFeed.current };
      freeze(v);
      setSeek(null);
      setSince(null);
      setResumed(null); // the note would name an old time
      setOpen((o) => (o.at === null ? { at: v, still: true } : { at: v }));
      if (keepT) writeT(v); // last: nothing it does can lose the seek
    }, DEBOUNCE_MS);
  };

  const pause = () => {
    const t = nowT();
    freeze(t);
    stood.current = t;
    setOpen({ at: null });
    if (keepT) writeT(t);
  };
  // A reopen starts T where the stream opens, so it does not jump by the pause before the first event.
  const play = () => {
    const t = Math.round(clamp(nowT(), lo, hi()));
    freeze(t);
    setResumed(null);
    setOpen({ at: t });
  };
  const goLive = () => {
    freeze(Date.now() - delay * 1000);
    setResumed(null);
    setOpen({ at: 'live' });
  };
  // Live, a nudge moves the delay: earlier is more delay. In replay it moves T.
  const nudge = (s: number) => (at === 'live' ? changeDelay(delay - s) : seekTo(now() + s * 1000));
  const toggleAnnounce = (on: boolean) => {
    setAnnounce(on);
    writeAnnounce(on);
  };
  // The toggle takes the focus itself: Safari does not focus a tapped or clicked button, and a focused control in the
  // part that goes (the Position range, the head's Play/Pause) would otherwise drop the focus to the page.
  const toggleMinimized = () => {
    toggleRef.current?.focus();
    setMinimized(!minimized);
    writeMinimized(!minimized);
  };

  const now = () => seek ?? nowT();
  // The strip and LEFT show the time the state stands at: T while playing, else where the last state landed.
  const stateNow = () => (playing ? now() : stood.current);
  const feed = snap.feed;
  const state = feed?.state;
  // Rebuilt only when the lap rows change (a snapshot or a `laps` event), so the lap table skips deltas.
  const lapTable = useMemo(
    () => detail && feed && <Laps detail={streamDetail(detail, feed.state)} laps={snap.laps} />,
    [detail, feed, snap.laps],
  );
  // The state is mutated in place: what is derived from it is keyed on the snapshot, a new object per store flush.
  const tower = useMemo(() => {
    const s = snap.feed?.state;
    return (
      s && (
        <Tower state={s} sessionKey={sessionKey} focus={focus} onFocus={(n) => setFocus((f) => (f === n ? null : n))} />
      )
    );
  }, [snap, sessionKey, focus]);
  // The pit wall, once the feed shows this session (as the tower waits): the previous session's chequered flag would
  // otherwise light up.
  const wall = useMemo(() => {
    const s = snap.feed?.state;
    if (!s || (sessionKey !== undefined && view(s, 'SessionInfo')?.Key !== sessionKey)) return undefined;
    const type = view(s, 'SessionInfo')?.Type ?? null;
    return {
      strip: stripOf(s),
      running: running(view(s, 'SessionStatus')?.Status),
      type,
      race: type === 'Race',
      rc: raceControl(s),
      pairs: withinASecond(s),
      fastest: fastestSoFar(s),
    };
  }, [snap, sessionKey]);
  // The series is parsed once per flush; the ticking bar only filters it at T.
  const series = useMemo(() => (snap.feed ? statusSeries(snap.feed.state) : []), [snap]);
  const focused = useMemo(() => {
    const s = snap.feed?.state;
    return s === undefined || focus === null
      ? null
      : { n: Number(focus), tla: driverOf(view(s, 'DriverList') ?? {}, focus).acronym };
  }, [snap, focus]);
  // The tab title carries the light while the session runs (D1); App writes it.
  const word = wall?.running ? LIGHT[wall.strip.light].word : null;
  useEffect(() => setTitleWord(word), [word]);
  useEffect(() => () => setTitleWord(null), []);

  // Announcements, per flush: what changed since the last one within the same feed. A snapshot (a new feed) only sets
  // the baseline; a seek's own line comes with its snapshot (onData).
  const heard = useRef<{ feed: Feed; starts: number; light?: string | undefined; fastest?: string | undefined }>(
    undefined,
  );
  useEffect(() => {
    const feed = snap.feed;
    if (!feed) return;
    const facts = {
      feed,
      starts: markersUpTo(series, feed.t, [lo, Number.POSITIVE_INFINITY]).filter((m) => m.kind === 'start').length,
      light: wall && LIGHT[wall.strip.light].word,
      fastest: wall?.fastest && `Fastest lap: ${wall.fastest.driver.acronym} ${wall.fastest.value}`,
    };
    const prev = heard.current;
    heard.current = facts;
    if (prev?.feed !== feed) return;
    const parts = [
      facts.starts > prev.starts && 'Start',
      facts.light !== prev.light && facts.light,
      facts.fastest !== prev.fastest && facts.fastest,
    ].filter((p) => typeof p === 'string');
    if (parts.length > 0) voice.say(parts.join('. '));
  }, [snap, series, wall, lo, voice]);

  const live = at === 'live';
  const mode = live
    ? delay === 0
      ? 'LIVE · Delay not set'
      : `LIVE, ${delay} s behind`
    : playing
      ? 'Replay'
      : 'Paused';
  const nudgeButton = (s: number) => (
    <button key={s} type="button" aria-label={nudgeLabel(s)} onClick={() => nudge(s)}>
      {signed(s)}
    </button>
  );
  const playButton = (
    <button type="button" className="play" onClick={playing ? pause : play}>
      {playing ? 'Pause' : 'Play'}
    </button>
  );

  return (
    <>
      {at !== null && fails >= FAILING ? (
        <p role="status">The stream keeps failing. Reload the page (your Access session may have expired).</p>
      ) : (
        at !== null &&
        fails > 0 && (
          <p role="status" className="muted">
            Reconnecting…
          </p>
        )
      )}
      {resumed !== null && <p className="muted">Resumed at {fmtClock(resumed)}: press Play when the video is there.</p>}
      {wall && <Strip strip={wall.strip} now={stateNow} playing={playing} />}
      {since !== null && (
        <p className="since">
          <b>Before this point</b> <span>{since}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              // Before the button goes, so focus is not lost to the page; a minimized bar has no Position range.
              (minimized ? toggleRef : position).current?.focus();
              setSince(null);
            }}
          >
            ×
          </button>
        </p>
      )}
      {detail && (
        <fieldset className="segmented" aria-label="View">
          <button type="button" aria-pressed={tab === 'tower'} onClick={() => setTab('tower')}>
            Tower
          </button>
          <button type="button" aria-pressed={tab === 'laps'} onClick={() => setTab('laps')}>
            Laps
          </button>
          <button type="button" aria-pressed={tab === 'weather'} onClick={() => setTab('weather')}>
            Weather
          </button>
        </fieldset>
      )}
      {!state ? (
        <p className="muted">Connecting…</p>
      ) : tab === 'laps' && lapTable ? (
        lapTable
      ) : tab === 'weather' ? (
        // Gated as the strip is, so the two agree: nothing from the previous session.
        <>
          {wall && snap.weather.rows.length > 0 ? (
            <WeatherPanels rows={snap.weather.rows} laps={snap.weather.laps} type={wall.type} source="the feed" />
          ) : (
            <p className="muted">No weather in the feed yet.</p>
          )}
          {detail && <PlayerRain detail={detail} live={live} now={now} playing={playing} />}
        </>
      ) : wall ? (
        <div className="pitwall">
          <div>{tower}</div>
          <Panel rc={wall.rc} pairs={wall.pairs} fastest={wall.fastest} race={wall.race} />
        </div>
      ) : (
        tower
      )}
      <section className={minimized ? 'player min' : 'player'} aria-label="Playback controls">
        {/* The head stays when minimized: the clock line, Play/Pause (from the transport) and the toggle. */}
        <div className="barhead">
          <Clock now={now} stateNow={stateNow} playing={playing} strip={wall?.strip}>
            <span className={live ? 'pill live' : 'pill'}>
              <span className="dot" aria-hidden="true" />
              <span className="mode">{mode}</span>
            </span>
          </Clock>
          {minimized && playButton}
          <button
            ref={toggleRef}
            type="button"
            className="bartoggle"
            aria-expanded={!minimized}
            aria-controls={controlsId}
            onClick={toggleMinimized}
          >
            <span className="chev" aria-hidden="true" />
            Controls
          </button>
        </div>
        {/* Minimized, the rest is not rendered (nothing hidden is focusable, and nothing hidden ticks). */}
        <div className="barbody" id={controlsId} hidden={minimized}>
          {!minimized && (
            <>
              <Seek now={now} playing={playing} lo={lo} hi={hi} series={series} onSeek={seekTo} ref={position} />
              {/* Seven buttons, Play in the middle; in replay of an open recording a Live button (a mode switch) follows. */}
              <div className="transport">
                {NUDGES.slice(0, 3).map(nudgeButton)}
                {playButton}
                {NUDGES.slice(3).map(nudgeButton)}
                {!live && recording.ended_at === null && (
                  <button type="button" className="golive" onClick={goLive}>
                    Live
                  </button>
                )}
              </div>
              <BackTo
                now={now}
                playing={playing}
                lo={lo}
                hi={hi}
                series={series}
                laps={snap.laps}
                focused={focused}
                onSeek={seekTo}
              />
              {live && (
                <label className="delay">
                  Delay {delay} s
                  <input
                    type="range"
                    aria-label="Delay"
                    min={0}
                    max={MAX_DELAY}
                    step={1}
                    value={delay}
                    onChange={(e) => changeDelay(Number(e.target.value))}
                  />
                </label>
              )}
              <label className="announce">
                <input type="checkbox" checked={announce} onChange={(e) => toggleAnnounce(e.target.checked)} />
                Announce events
              </label>
            </>
          )}
        </div>
      </section>
      <p className="vh" role="status">
        {said}
      </p>
    </>
  );
}
