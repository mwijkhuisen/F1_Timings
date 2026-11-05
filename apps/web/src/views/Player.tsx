import { type Obj, type SessionDetail, view } from '@f1/contracts';
import {
  type CSSProperties,
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createStore, openStream } from '../lib/stream.ts';
import { fmtClock } from '../lib/time.ts';
import { LapTable } from './LapTable.tsx';
import { Tower } from './Tower.tsx';

// The player (A§13): one playback stream at a time, the clock, the delay slider (live), the seek bar with markers
// and play/pause. `at` is the open stream's start: 'live', epoch ms (replay), or null while paused.

export type Marker = { kind: 'start' | 'red' | 'chequered'; t: number };

// A feed Utc as UTC, with or without its Z.
const utc = (v: string | undefined) => (v === undefined ? Number.NaN : Date.parse(v.endsWith('Z') ? v : `${v}Z`));

/** The session's start, red flags and chequered flags so far. A Started followed within 60 s by another status is the race's 2 s blip (A§11.1). */
export function markers(state: Obj): Marker[] {
  const out: Marker[] = [];
  const statuses = Object.values(view(state, 'SessionData')?.StatusSeries ?? {})
    .flatMap((s) => (s?.SessionStatus === undefined ? [] : [{ status: s.SessionStatus, t: utc(s.Utc) }]))
    .filter((s) => !Number.isNaN(s.t))
    .sort((a, b) => a.t - b.t);
  statuses.forEach((s, i) => {
    const next = statuses[i + 1];
    if (s.status === 'Started' && !(next && next.t - s.t <= 60_000)) out.push({ kind: 'start', t: s.t });
  });
  for (const m of Object.values(view(state, 'RaceControlMessages')?.Messages ?? {})) {
    const kind = m?.Flag === 'RED' ? 'red' : m?.Flag === 'CHEQUERED' ? 'chequered' : null;
    const t = utc(m?.Utc);
    if (kind && !Number.isNaN(t)) out.push({ kind, t });
  }
  return out;
}

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
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [store] = useState(() => createStore());
  const snap = useSyncExternalStore(store.subscribe, store.get);
  // T = clock.t + the wall time since clock.wall while playing; resynced to every event's t.
  const clock = useRef({ t: start === 'live' ? Date.now() - delay * 1000 : start, wall: Date.now() });
  const backoff = useRef(1000);
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; seek?: ReturnType<typeof setTimeout> }>({});
  const seen = useRef(new Map<string, Marker>());
  // The bounds for a reopen after an error, without reopening when a refetch changes the row.
  const rec = useRef(recording);
  rec.current = recording;
  const liveDelay = at === 'live' ? streamDelay : 0;

  const playing = at !== null;
  const nowT = () => (playing ? clock.current.t + Math.max(0, Date.now() - clock.current.wall) : clock.current.t);
  const lo = Date.parse(recording.started_at);
  const hi = () => (recording.ended_at === null ? Date.now() - delay * 1000 : Date.parse(recording.ended_at));
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
          if (kind === 'snapshot') backoff.current = 1000;
          clock.current = { t: feed.t, wall: Date.now() };
          store.update(feed, kind);
        },
        onError() {
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
          setOpen({ at: null });
        },
      },
    );
    return () => {
      close();
      clearTimeout(retry);
    };
  }, [recording.id, open, liveDelay, store]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [playing]);

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
    freeze(nowT());
    setAt(null);
  };
  const play = () => setAt(Math.round(clamp(nowT(), lo, hi())));

  const T = seek ?? nowT();
  const feed = snap.feed;
  const state = feed?.state;
  // Every marker seen during the visit; the stream delivers nothing ahead of T, so none is a spoiler.
  if (state) for (const m of markers(state)) seen.current.set(`${m.kind}:${m.t}`, m);
  const marks = [...seen.current.values()];
  // Rebuilt only when the lap rows change (a snapshot or a `laps` event), so the lap table skips deltas.
  const lapTable = useMemo(
    () => detail && feed && <Laps detail={streamDetail(detail, feed.state)} laps={snap.laps} />,
    [detail, feed, snap.laps],
  );

  const top = Math.max(lo, hi());
  const x = (t: number) => ({ '--x': `${((clamp(t, lo, top) - lo) / Math.max(1, top - lo)) * 100}%` }) as CSSProperties;
  const remaining = state && view(state, 'ExtrapolatedClock')?.Remaining;
  const lapCount = state && view(state, 'LapCount');
  const track = state && view(state, 'TrackStatus')?.Message;

  return (
    <>
      <p className="clock" aria-live="off">
        <time>{fmtClock(T)}</time>
        {remaining && <span> · {remaining} left</span>}
        {lapCount?.CurrentLap !== undefined && (
          <span>
            {' '}
            · Lap {lapCount.CurrentLap}
            {lapCount.TotalLaps !== undefined && `/${lapCount.TotalLaps}`}
          </span>
        )}
        {track && <span> · {track}</span>}
        {at === 'live' ? <span> · Live</span> : !playing && <span> · Paused</span>}
      </p>
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
      ) : (
        <Tower state={state} sessionKey={sessionKey} />
      )}
      <section className="player" aria-label="Playback controls">
        <div className="seek">
          <input
            type="range"
            aria-label="Position"
            min={lo}
            max={top}
            step={1000}
            value={clamp(T, lo, top)}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          {marks.map((m) => (
            <span
              key={`${m.kind}:${m.t}`}
              className={`marker m-${m.kind}`}
              style={x(m.t)}
              title={`${m.kind === 'start' ? 'Start' : m.kind === 'red' ? 'Red flag' : 'Chequered flag'} ${fmtClock(m.t)}`}
            />
          ))}
        </div>
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
            <>
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
              {NUDGES.map((s) => (
                <button key={s} type="button" aria-label={`Delay ${signed(s)}`} onClick={() => changeDelay(delay + s)}>
                  {signed(s)}
                </button>
              ))}
            </>
          ) : (
            <>
              {NUDGES.map((s) => (
                <button key={s} type="button" aria-label={`Position ${signed(s)}`} onClick={() => seekTo(T + s * 1000)}>
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
