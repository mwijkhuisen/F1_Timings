import { type Obj, type SessionDetail, view } from '@f1/contracts';
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { fastestSoFar, LIGHT, raceControl, running, stripOf, withinASecond } from '../lib/pitwall.ts';
import { setTitleWord } from '../lib/routes.ts';
import { createStore, type Marker, openStream } from '../lib/stream.ts';
import { fmtClock } from '../lib/time.ts';
import { LapTable } from './LapTable.tsx';
import { Panel, Strip, useTick } from './PitWall.tsx';
import { Tower } from './Tower.tsx';

// The player (A§13): one playback stream at a time, the clock, the delay slider (live), the seek bar with markers
// and play/pause. `at` is the open stream's start: 'live', epoch ms (replay), or null while paused. Only the clock line
// and the seek bar tick each second (and the strip's LEFT cell, from values derived per flush); the tower, the pit wall
// and everything else derived from the state render on a store flush.

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
const SidePanel = memo(Panel);

export const MAX_DELAY = 120;
const DELAY_KEY = 'f1.delay';
const DEBOUNCE_MS = 400;
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const signed = (s: number) => `${s > 0 ? '+' : '−'}${Math.abs(s)} s`;
const FAILING = 5; // consecutive errors without a snapshot before the reload hint

/** The clock line: T, ticking locally; `children` is the rest of the line, from the state. */
function Clock({ now, playing, children }: { now: () => number; playing: boolean; children: ReactNode }) {
  useTick(playing);
  const T = now();
  return (
    <p className="clock" aria-live="off">
      <time dateTime={new Date(T).toISOString()}>{fmtClock(T)}</time>
      {children}
    </p>
  );
}

/** The seek bar over [lo, hi()], ticking with the clock; only markers inside it are drawn. */
function Seek({
  now,
  playing,
  lo,
  hi,
  marks,
  onSeek,
}: {
  now: () => number;
  playing: boolean;
  lo: number;
  hi: () => number;
  marks: Marker[];
  onSeek(t: number): void;
}) {
  useTick(playing);
  const T = now();
  const top = Math.max(lo, hi());
  const x = (t: number) => ({ '--x': `${((clamp(t, lo, top) - lo) / Math.max(1, top - lo)) * 100}%` }) as CSSProperties;
  return (
    <div className="seek">
      <input
        type="range"
        aria-label="Position"
        aria-valuetext={fmtClock(T)}
        min={lo}
        max={top}
        step={1000}
        value={clamp(T, lo, top)}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      {/* A marker outside the recording (a status left over from the day before) is not drawn. */}
      <div className="marks">
        {marks
          .filter((m) => m.t >= lo && m.t <= top)
          .map((m) => (
            <span
              key={`${m.kind}:${m.t}`}
              className={`marker m-${m.kind}`}
              style={x(m.t)}
              title={`${m.kind === 'start' ? 'Start' : m.kind === 'red' ? 'Red flag' : 'Chequered flag'} ${fmtClock(m.t)}`}
            />
          ))}
      </div>
    </div>
  );
}

export type PlayerRecording = { id: number; started_at: string; ended_at: string | null };

export function Player({
  recording,
  sessionKey,
  start,
  detail,
}: {
  recording: PlayerRecording;
  /** The recording's session: the tower waits until the feed shows it. */
  sessionKey?: number;
  /** 'live', or the replay's first T in epoch ms; read on mount only. */
  start: number | 'live';
  /** The session from the API; without it there is only the tower. */
  detail: SessionDetail | undefined;
}) {
  const [delay, setDelay] = useState(readDelay); // shown at once
  const [streamDelay, setStreamDelay] = useState(delay); // the open stream's, 400 ms later
  // A new object (re)opens the stream, even at the same `at` (a reopen after an error).
  const [open, setOpen] = useState<{ at: number | 'live' | null }>({ at: start });
  const at = open.at;
  const setAt = (a: number | 'live' | null) => setOpen({ at: a });
  const [seek, setSeek] = useState<number | null>(null); // a pending seek, shown on the bar
  const [tab, setTab] = useState<'tower' | 'laps'>('tower');
  // The focused driver's number (a tap on the tower's driver cell); page state that the player bar reads (P4e).
  const [focus, setFocus] = useState<string | null>(null);
  const [fails, setFails] = useState(0); // errors since the last snapshot
  const [held, setHeld] = useState<number | null>(null); // T at a pause or `end`: where the tower stands
  const [store] = useState(() => createStore());
  const snap = useSyncExternalStore(store.subscribe, store.get);
  // T = clock.t + the wall time since clock.wall while playing; resynced to every event's t.
  const clock = useRef({ t: start === 'live' ? Date.now() - delay * 1000 : start, wall: Date.now() });
  const backoff = useRef(1000);
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; seek?: ReturnType<typeof setTimeout> }>({});
  // The bounds for a reopen after an error, without reopening when a refetch changes the row.
  const rec = useRef(recording);
  useEffect(() => {
    rec.current = recording;
  }, [recording]);
  const liveDelay = at === 'live' ? streamDelay : 0;

  const playing = at !== null;
  const nowT = () => (playing ? clock.current.t + Math.max(0, Date.now() - clock.current.wall) : clock.current.t);
  const lo = Date.parse(recording.started_at);
  // A replay ignores the delay (A§13): an open recording's bar ends at now, or now − delay while live.
  const hi = () =>
    recording.ended_at === null ? Date.now() - (at === 'live' ? delay : 0) * 1000 : Date.parse(recording.ended_at);
  const freeze = (t: number) => {
    clock.current = { t, wall: Date.now() };
  };

  useEffect(() => {
    const from = open.at;
    if (from === null) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const close = openStream(
      { recording: recording.id, at: from, delay: liveDelay },
      {
        onData(feed, kind) {
          if (kind === 'snapshot') {
            backoff.current = 1000;
            setFails(0);
          }
          clock.current = { t: feed.t, wall: Date.now() };
          store.update(feed, kind);
        },
        onError() {
          setFails((n) => n + 1);
          const wait = backoff.current;
          backoff.current = Math.min(wait * 2, 30_000);
          retry = setTimeout(() => {
            const t = clock.current.t + Math.max(0, Date.now() - clock.current.wall);
            const { started_at, ended_at } = rec.current;
            const end = ended_at === null ? Date.now() : Date.parse(ended_at);
            setOpen({ at: from === 'live' ? 'live' : Math.round(clamp(t, Date.parse(started_at), end)) });
          }, wait);
        },
        onEnd(t) {
          clock.current = { t, wall: Date.now() };
          setHeld(t);
          setOpen({ at: null });
        },
      },
    );
    return () => {
      close();
      clearTimeout(retry);
    };
  }, [recording.id, open, liveDelay, store]);

  useEffect(
    () => () => {
      clearTimeout(timers.current.delay);
      clearTimeout(timers.current.seek);
    },
    [],
  );

  const changeDelay = (s: number) => {
    const v = clamp(Math.round(s), 0, MAX_DELAY);
    setDelay(v);
    writeDelay(v);
    clearTimeout(timers.current.delay);
    timers.current.delay = setTimeout(() => setStreamDelay(v), DEBOUNCE_MS);
  };

  // A seek or a nudge: shown at once; 400 ms after the last one, T moves there and, while playing, the stream reopens.
  const seekTo = (t: number) => {
    const v = Math.round(clamp(t, lo, hi()));
    setSeek(v);
    clearTimeout(timers.current.seek);
    timers.current.seek = setTimeout(() => {
      freeze(v);
      setSeek(null);
      setOpen((o) => (o.at === null ? o : { at: v }));
    }, DEBOUNCE_MS);
  };

  const pause = () => {
    const t = nowT();
    freeze(t);
    setHeld(t);
    setAt(null);
  };
  const play = () => setAt(Math.round(clamp(nowT(), lo, hi())));

  const now = () => seek ?? nowT();
  // A seek while paused only moves T (the sync flow: pause, seek, Play on both screens); the tower stays at `held`.
  const moved = !playing && held !== null && now() !== held;
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
    return {
      strip: stripOf(s),
      running: running(view(s, 'SessionStatus')?.Status),
      race: view(s, 'SessionInfo')?.Type === 'Race',
      rc: raceControl(s),
      pairs: withinASecond(s),
      fastest: fastestSoFar(s),
    };
  }, [snap, sessionKey]);
  // The tab title carries the light while the session runs (D1); App writes it.
  const word = wall?.running ? LIGHT[wall.strip.light].word : null;
  useEffect(() => setTitleWord(word), [word]);
  useEffect(() => () => setTitleWord(null), []);
  const info = useMemo(() => {
    const s = snap.feed?.state;
    if (!s) return null;
    const remaining = view(s, 'ExtrapolatedClock')?.Remaining;
    const lapCount = view(s, 'LapCount');
    const track = view(s, 'TrackStatus')?.Message;
    return (
      <>
        {remaining && <span> · {remaining} left</span>}
        {lapCount?.CurrentLap !== undefined && (
          <span>
            {' '}
            · Lap {lapCount.CurrentLap}
            {lapCount.TotalLaps !== undefined && `/${lapCount.TotalLaps}`}
          </span>
        )}
        {track && <span> · {track}</span>}
      </>
    );
  }, [snap]);

  return (
    <>
      <Clock now={now} playing={playing}>
        {info}
        {at === 'live' ? <span> · Live</span> : !playing && <span> · Paused</span>}
      </Clock>
      {playing && fails >= FAILING ? (
        <p role="status">The stream keeps failing. Reload the page (your Access session may have expired).</p>
      ) : (
        ((playing && fails > 0) || moved) && (
          <p role="status" className="muted">
            {moved ? 'Press Play to load this position.' : 'Reconnecting…'}
          </p>
        )
      )}
      {wall && <Strip strip={wall.strip} now={now} playing={playing} />}
      {detail && (
        <fieldset className="segmented" aria-label="View">
          <button type="button" aria-pressed={tab === 'tower'} onClick={() => setTab('tower')}>
            Tower
          </button>
          <button type="button" aria-pressed={tab === 'laps'} onClick={() => setTab('laps')}>
            Laps
          </button>
        </fieldset>
      )}
      {!state ? (
        <p className="muted">Connecting…</p>
      ) : tab === 'laps' && lapTable ? (
        lapTable
      ) : wall ? (
        <div className="pitwall">
          <div>{tower}</div>
          <SidePanel rc={wall.rc} pairs={wall.pairs} fastest={wall.fastest} race={wall.race} />
        </div>
      ) : (
        tower
      )}
      <section className="player" aria-label="Playback controls">
        <Seek now={now} playing={playing} lo={lo} hi={hi} marks={snap.marks} onSeek={seekTo} />
        {at === 'live' && (
          <label>
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
        {/* One row of equal buttons at 390 px: Play/Pause and the six nudges (a Live button wraps to its own row). */}
        <div className="controls">
          {playing ? (
            <button type="button" onClick={pause}>
              Pause
            </button>
          ) : (
            <button type="button" onClick={play}>
              Play
            </button>
          )}
          {at === 'live' ? (
            NUDGES.map((s) => (
              <button key={s} type="button" aria-label={`Delay ${signed(s)}`} onClick={() => changeDelay(delay + s)}>
                {signed(s)}
              </button>
            ))
          ) : (
            <>
              {NUDGES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`Position ${signed(s)}`}
                  onClick={() => seekTo(now() + s * 1000)}
                >
                  {signed(s)}
                </button>
              ))}
              {recording.ended_at === null && (
                <button type="button" onClick={() => setAt('live')}>
                  Live
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
