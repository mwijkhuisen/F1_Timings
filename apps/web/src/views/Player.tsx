import { type Lap, type Obj, type SessionDetail, view, type Weather } from '@f1/contracts';
import {
  type CSSProperties,
  memo,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { markStale } from '../lib/api.ts';
import { closingAt } from '../lib/crossings.ts';
import {
  bestsSoFar,
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
import { feedReached, qualiPhases } from '../lib/quali.ts';
import {
  type CatchUpEvent,
  feedClock,
  feedRaceControl,
  lapPeriods,
  lastStop,
  type Mark,
  type MarkKind,
  markersUpTo,
  type Status,
  skippedEvents,
  skippedText,
  skippedWindow,
  statusSeries,
  tally,
} from '../lib/replay.ts';
import { type PlayerTab, parseFocus, parseTab, replayQuery, setTitleWord } from '../lib/routes.ts';
import { paceRuns } from '../lib/runs.ts';
import { orderDrivers } from '../lib/session.ts';
import {
  createStore,
  type Feed,
  openStream,
  type Pit,
  type Probe,
  probeStream,
  type Snap,
  type Stint,
  type Stream,
  streamUrl,
} from '../lib/stream.ts';
import { savedPicks } from '../lib/tables.ts';
import { fmtClock, parseT } from '../lib/time.ts';
import { type ClockPeriod, KIND_LABEL, KIND_NAME, type Kind, type Period, type Track } from '../lib/track.ts';
import { ErrorBoundary, ErrorView, OFFLINE } from '../ui/ErrorView.tsx';
import { CatchUp } from './CatchUp.tsx';
import { Comparison, PitCycles, TrackEvolution } from './Compare.tsx';
import { DriverPicker, picksOf } from './DriverPicker.tsx';
import { QualiSwitch } from './LapsTab.tsx';
import { LapTable } from './LapTable.tsx';
import { Order } from './Order.tsx';
import { PaceTable, RunPlan } from './Pace.tsx';
import { Panel, Strip, useTick } from './PitWall.tsx';
import { RainMapCard } from './RainMap.tsx';
import { SpeedTable } from './Speeds.tsx';
import { PitStops, pitStops, StintBars } from './Stints.tsx';
import { QualiTiles, SessionTiles } from './Tiles.tsx';
import { driverOf, gridOf, Tower, towerRows } from './Tower.tsx';
import { TrackMap } from './TrackMap.tsx';
import { WeatherPanels } from './Weather.tsx';

// The player (A§13): one playback stream at a time; the bar holds the clock line, the seek bar with the marks at or
// before T, the transport, the "Back to" chips, the delay slider (live) and the announcements toggle; minimized
// (`f1.minimized`), only the clock line, Play/Pause, Live and the Controls toggle, while the stream plays on. `open.at` is the
// open stream's start: 'live', epoch ms (replay), or null while paused; a `still` stream only fetches the state at a
// paused T and closes on its snapshot. Only the clock line, the seek bar, the Back to chips and the strip's LEFT cell
// (and, on the Weather tab, the rain map) tick each second, from values derived per flush (no state parsing per tick);
// the tower, the pit wall and everything else derived from the state render on a store flush. The tabs are Tower ·
// Laps (in qualifying By phase | Every lap, #113) · Order (races) · Compare · Stints · Weather, each in its own error
// boundary, the replay's in the URL (`?tab=`, #100); the Weather tab shows the feed's weather rows up to T (P5b),
// redrawn only when a row arrives, and the rain map's frames up to T (P5c). Laps (with the session tiles), Compare and
// Stints (#112) read the stream's rows up to T, and their SC, VSC and red bands come from the feed's status series
// (`lapPeriods`, and in practice `feedClock`): the player never asks `/race-control`, `/stints` or `/weather`, so
// nothing after T reaches the page. With the session page's components on those rows (#114) Laps adds the speed table,
// Compare the track evolution (qualifying and practice) and Stints the pace per run and the practice run plan.

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
            grid: null,
            dnf: null,
            dns: null,
            dsq: null,
            durations_ms: null,
            gaps_ms: null,
          },
        ]
      : [],
  );
  // Never the API's results: they are the final classification, after T.
  return { ...detail, drivers: [...drivers.values()], results: lines.length > 0 ? results : [] };
}

const Laps = memo(LapTable);

/**
 * The Laps tab as the session page lays it out, on the stream's rows up to T: in qualifying the phase tiles and By phase
 * | Every lap (#113), the session tiles, and the lap table with its bands (#112).
 */
function PlayerLaps({
  detail,
  laps,
  reached,
  track,
}: {
  detail: SessionDetail;
  laps: Lap[];
  reached: Map<number, number>;
  track: Track;
}) {
  const quali = detail.session.type === 'Qualifying' ? qualiPhases(laps, detail.results, reached) : null;
  const table = <Laps detail={detail} laps={laps} track={track} />;
  return (
    <>
      {quali && <QualiTiles detail={detail} quali={quali} />}
      <SessionTiles detail={detail} laps={laps} />
      {quali ? (
        <QualiSwitch detail={detail} quali={quali}>
          {table}
        </QualiSwitch>
      ) : (
        table
      )}
      <SpeedTable detail={detail} laps={laps} />
    </>
  );
}

/**
 * The Stints tab (#112, #114): the stint bars, then in races and practice the pace per run and, in practice, the run
 * plan, on the stream's rows up to T. `periods` are the race's lap periods (red included, so the pace leaves red laps
 * out; the bars draw SC and VSC only), `clock` the practice's clock periods. The runs are rebuilt only when these
 * change, which is when the rows change. In a race the pit stops follow the bars (#219): the server's derived rows, with
 * stop times from the live feed's PitStopSeries where it sends them, none shown without a row. The player has no
 * race-control or weather query, so nothing "did not load": `weather` is the feed's rows up to T. The run plan's axis ends at T (`end`), never at the
 * scheduled `date_end`, which in a live session is a guess.
 */
function PlayerStints({
  detail,
  laps,
  stints,
  pits,
  periods,
  clock,
  weather,
  end,
}: {
  detail: SessionDetail;
  laps: Lap[];
  stints: Stint[];
  pits: Pit[];
  periods: Period[];
  clock: ClockPeriod[];
  weather: Weather;
  end: number;
}) {
  const { type } = detail.session;
  const race = type === 'Race';
  const practice = type === 'Practice';
  const runs = useMemo(
    () => (race || practice ? paceRuns(laps, stints, type, { periods, clock }) : []),
    [race, practice, laps, stints, type, periods, clock],
  );
  // The bars draw SC and VSC only, and the pit rows read the same periods as the session page's.
  const drawn = useMemo(() => periods.filter((p) => p.kind !== 'red'), [periods]);
  const pitRows = useMemo(
    () => (race ? pitStops(orderDrivers(detail, laps), pits, stints, drawn) : []),
    [race, detail, laps, pits, stints, drawn],
  );
  return (
    <>
      <StintBars detail={detail} laps={laps} stints={stints} periods={drawn} pitRows={pitRows} pitSource="f1-live" />
      {practice && runs.length > 0 && (
        <RunPlan detail={detail} laps={laps} runs={runs} clock={clock} weather={weather} end={end} />
      )}
      {(race || practice) && (
        <PaceTable
          detail={detail}
          laps={laps}
          runs={runs}
          weather={weather}
          failed={false}
          unnumbered={race ? stints.filter((s) => s.lap_start === null || s.lap_end === null).length : 0}
        />
      )}
      {pitRows.length > 0 && <PitStops detail={detail} rows={pitRows} source="f1-live" />}
    </>
  );
}

/** Stable, so a weather row re-renders `SessionTabs` only on Stints, the one tab that reads it. */
const NO_WEATHER: Weather = [];

/**
 * The Laps, Compare and Stints tabs (#112), from the stream's rows up to T, shown inside the tab's error boundary. A
 * `memo` whose props change only on a snapshot, a `laps` event, a knock-out (qualifying), a pick or, on Stints, a weather row, so other deltas
 * render nothing here. What they read is rebuilt with the rows: the drivers and results from the stream, and the bands
 * up to T as the leader's laps, in races only. A SessionData change brings no `laps` event by itself, so a band shows with the next row change
 * (A§13). The state holds only applied events, so nothing is after T.
 */
const SessionTabs = memo(function SessionTabs({
  tab,
  detail,
  feed,
  laps,
  stints,
  pits,
  weather,
  lo,
  reached,
  chosen,
  onPick,
}: {
  tab: 'laps' | 'compare' | 'stints';
  detail: SessionDetail;
  feed: Feed;
  laps: Lap[];
  stints: Stint[];
  pits: Pit[];
  /** The feed's weather rows up to T (`snap.weather.rows`): a new array only when a row arrives. */
  weather: Weather;
  lo: number;
  /** The feed's knock-outs as a JSON key (`feedReached`), so an equal set keeps the memo. */
  reached: string;
  /** Compare's picks: page state held by the player, so they survive a tab switch, and never in the URL. */
  chosen: number[] | null;
  onPick: (numbers: number[]) => void;
}) {
  const rows = useMemo(() => {
    const series = statusSeries(feed.state);
    const { type } = detail.session;
    return {
      detail: streamDetail(detail, feed.state),
      track: { periods: lapPeriods(series, laps, feed.t, lo, type), unplaced: [], unmatched: 0 },
      // Practice only, as the session page's `clockPeriods` (qualifying draws phases, not flags).
      clock: type === 'Practice' ? feedClock(series, feed.t, lo) : [],
      // The T the bands were closed at: an open band's end, so the run plan's axis ends there too.
      t: feed.t,
    };
  }, [detail, feed, laps, lo]);
  // Compare's order, and the saved picks it has (#237 D1), read when the rows change, not on every render.
  const order = useMemo(() => orderDrivers(rows.detail, laps), [rows.detail, laps]);
  const saved = useMemo(() => (tab === 'compare' ? savedPicks(order) : null), [tab, order]);
  if (tab === 'laps')
    return (
      <PlayerLaps
        detail={rows.detail}
        laps={laps}
        reached={new Map(reached ? (JSON.parse(reached) as [number, number][]) : [])}
        track={rows.track}
      />
    );
  // Stints: the stream's stint rows, the SC and VSC bands (red flags are not drawn there, as on the session page), the
  // pace per run and the practice run plan (#114).
  if (tab === 'stints')
    return stints.length === 0 ? (
      <p className="muted">No stints in the feed yet.</p>
    ) : laps.length === 0 ? (
      <p className="muted">No laps in the feed yet.</p>
    ) : (
      <PlayerStints
        detail={rows.detail}
        laps={laps}
        stints={stints}
        pits={pits}
        periods={rows.track.periods}
        clock={rows.clock}
        weather={weather}
        end={rows.t}
      />
    );
  // No laps, no picker (as #99 on the session page).
  if (laps.length === 0) return <p className="muted">No laps in the feed yet.</p>;
  // Until the first pick the picks are the saved ones the session has (#237 D1), else the top 2 of the order at T. In a
  // race the pit cycles read the stream's stints and the feed's race-control texts, and list a cycle once its after line
  // is crossed (D1).
  const picks = picksOf(order, chosen, onPick, saved);
  return (
    <>
      <DriverPicker drivers={order} selected={picks.numbers} onToggle={picks.toggle} showReference />
      <Comparison
        detail={rows.detail}
        drivers={picks.selected}
        laps={laps}
        periods={rows.track.periods}
        onReference={picks.setReference}
      >
        {rows.detail.session.type === 'Race' && (
          <PitCycles
            drivers={picks.selected}
            laps={laps}
            periods={rows.track.periods}
            stints={stints}
            rc={feedRaceControl(feed.state)}
            failed={false}
            settled
          />
        )}
      </Comparison>
      {rows.detail.session.type !== 'Race' && <TrackEvolution detail={rows.detail} laps={laps} clock={rows.clock} />}
    </>
  );
});

/** The view switch, in the session page's order; Order only in a race. */
const TABS: [PlayerTab, string][] = [
  ['tower', 'Tower'],
  ['laps', 'Laps'],
  ['order', 'Order'],
  ['compare', 'Compare'],
  ['stints', 'Stints'],
  ['weather', 'Weather'],
  ['map', 'Map'],
];

/** The race-control card's id, the target of the strip's message (#237). */
const RC_ID = 'race-control';

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

/** Minimized when stored as '1'; with nothing stored (#238) on a phone, else expanded; expanded when storage throws. */
function readMinimized(): boolean {
  try {
    const stored = localStorage.getItem(MINIMIZED_KEY);
    if (stored === null) return typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
    return stored === '1';
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

/** T, the tab or the focus in the player's URL (`?t=HH:mm:ss&tab=…&focus=44`): replaceState only, so the route stays and nothing is dispatched. */
function writeQuery(set: { t?: string; tab?: PlayerTab; focus?: string | null }, search = location.search) {
  try {
    history.replaceState(history.state, '', `${location.pathname}${replayQuery(search, set)}`);
  } catch {
    // A browser that rate-limits replaceState throws (SecurityError): the URL just lags behind T.
  }
}

const writeT = (t: number) => writeQuery({ t: fmtClock(t) });

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
const PROBE_AT = 3; // the error that sends the one HEAD probe (#100)
const RELOAD = 'The stream keeps failing. Reload the page (your Access session may have expired).';
const RECONNECTING = 'Reconnecting…';
/** What the probe's answer says (#100, D3); `missing` stops the player. */
const PROBE_TEXT: Record<Probe, string> = {
  missing: "The recording's files are missing on the server: playback stopped. Press Play to try again.",
  expired: 'The stream keeps failing: your Access session has expired. Reload the page to sign in.',
  offline: OFFLINE,
  up: 'The stream keeps failing, but the server has the recording: still retrying.',
  error: 'The stream keeps failing: the server answered with an error. Still retrying.',
};

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

/**
 * The clock line: T, ticking locally, the time left and the lap (from the strip's values), then the pill. The pill's
 * word is a function, so it is read at each tick (#237: a hold counts down).
 */
function Clock({
  now,
  stateNow,
  playing,
  strip,
  pill,
  word,
}: {
  now: () => number;
  /** The T the state stands at, for the time left (as the strip's LEFT). */
  stateNow: () => number;
  playing: boolean;
  strip: StripData | undefined;
  /** The pill's class, and its word per tick. */
  pill: string;
  word: () => string;
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
      <span className={pill}>
        <span className="dot" aria-hidden="true" />
        <span className="mode">{word()}</span>
      </span>
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

/**
 * "Back to": first the T before the last seek (#237), then the latest mark of each kind at or before T and the focused
 * driver's last stop; the marks and the stop only go back.
 */
function BackTo({
  before,
  now,
  playing,
  lo,
  hi,
  series,
  laps,
  focused,
  onSeek,
}: {
  before: number | null;
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
  if (before === null && latest.size === 0 && !stop) return null;
  return (
    <fieldset className="chips" aria-label="Back to">
      <span className="label" aria-hidden="true">
        Back to
      </span>
      {before !== null && (
        <button type="button" onClick={() => onSeek(before)}>
          {fmtClock(before)}
        </button>
      )}
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

/**
 * The tower with its closing trend (A§13), in a race: the interval's change at the line over 1 and 3 laps, from the
 * crossings up to the state's T and the SC, VSC and red bands up to it. Its own component, so the tab's error boundary
 * covers the trend and it runs only while the tower is shown (#100).
 */
function TowerTab({
  snap,
  series,
  lo,
  sessionKey,
  year,
  starts,
  focus,
  onFocus,
}: {
  snap: Snap;
  series: Status[];
  lo: number;
  sessionKey: number | undefined;
  /** The session's `meeting.year`, for the tyre compounds; null until the detail arrives. */
  year: number | null;
  /** The session's `date_start`, for the waiting line. */
  starts: string | undefined;
  focus: string | null;
  onFocus(n: string): void;
}) {
  const state = snap.feed?.state;
  const trend = useMemo(() => {
    const feed = snap.feed;
    if (!feed || view(feed.state, 'SessionInfo')?.Type !== 'Race') return undefined;
    const bands = markersUpTo(series, feed.t, [lo, Number.POSITIVE_INFINITY]);
    return closingAt(
      snap.laps,
      towerRows(feed.state).map((r) => r.driver.number),
      feed.t,
      bands,
    );
  }, [snap, series, lo]);
  return (
    state && (
      <Tower
        state={state}
        sessionKey={sessionKey}
        focus={focus}
        onFocus={onFocus}
        trend={trend}
        year={year}
        starts={starts}
      />
    )
  );
}

/** `delay` is the open live stream's own (s): the page shows more by holding its events (#101). */
type Open = { at: number | 'live' | null; still?: true; delay?: number };

/** T at `wall` is `t`, running with the wall clock from there; never below `floor` (#101). */
type Clock = { t: number; wall: number; floor?: number };
const clockT = (c: Clock) => Math.max(c.floor ?? Number.NEGATIVE_INFINITY, c.t + Math.max(0, Date.now() - c.wall));

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
  detailError = null,
  retryDetail,
  keepT = false,
}: {
  recording: PlayerRecording;
  /** The recording's session: the tower waits until the feed shows it. */
  sessionKey?: number;
  /** 'live', or the replay's first T in epoch ms; read on mount only. */
  start: number | 'live';
  /** The session from the API; without it there is only the tower. */
  detail: SessionDetail | undefined;
  /** The session query's error: shown under the tower while there is no detail (#100). */
  detailError?: unknown;
  /** The session query's refetch, for the error's Try again. */
  retryDetail?: (() => void) | undefined;
  /** The replay keeps T and the tab in the URL (`?t=`, `?tab=`) and resumes from them on load; `/live` never does. */
  keepT?: boolean;
}) {
  // A valid ?t, read once on mount: the player resumes paused there (a still frame) until Play.
  const [resumed, setResumed] = useState(() =>
    keepT ? parseT(new URLSearchParams(location.search).get('t'), recording) : null,
  );
  const [delay, setDelay] = useState(readDelay); // shown at once, and the page's T while live
  const delayNow = useRef(delay); // the same, for the stream's handlers
  // A new object (re)opens the stream, even at the same `at` (a reopen after an error). A live one opens at the delay
  // shown then; a later increase holds its events instead (#101), and only a decrease below it opens another.
  const [open, setOpen] = useState<Open>(() =>
    resumed !== null ? { at: resumed, still: true } : start === 'live' ? { at: 'live', delay } : { at: start },
  );
  const at = open.at;
  const playing = at !== null && !open.still;
  const [seek, setSeek] = useState<number | null>(null); // a pending seek, shown on the bar
  const [before, setBefore] = useState<number | null>(null); // the T before the last committed seek (#237)
  const seekFrom = useRef<number | undefined>(undefined); // the T at the first seek of a burst: a drag or nudges move T on
  const [tab, setTab] = useState<PlayerTab>(() =>
    keepT ? parseTab(new URLSearchParams(location.search).get('tab')) : 'tower',
  );
  // The focused driver's number (a tap on the tower's driver cell); page state that the player bar reads. Kept in the
  // URL (`?focus=`, #237) on the replay and on /live, read once on mount.
  const [focus, setFocus] = useState(() => parseFocus(new URLSearchParams(location.search).get('focus')));
  const [chosen, setChosen] = useState<number[] | null>(null); // Compare's picks (#112), null until the first one
  const [stale, setStale] = useState(false); // an event failed its contract: reload, no retry
  const [fails, setFails] = useState(0); // errors since the last snapshot
  const failCount = useRef(0); // the same, for the stream's handlers
  const [probe, setProbe] = useState<Probe | null>(null); // the HEAD probe's answer since the last snapshot
  const probing = useRef<AbortController | undefined>(undefined);
  // The reload hint lets the screen lock (owner, 2026-11-13): an expired Access session never comes back by itself.
  useWakeLock(playing && fails < FAILING && !stale);
  // What the last forward seek skipped (#234): the counts' text, and the events for the catch-up dialog, kept as they
  // were at its snapshot (the feed is mutated in place after it, so they are never derived later).
  const [since, setSince] = useState<
    ({ text: string; events: CatchUpEvent[] } & ReturnType<typeof skippedWindow>) | null
  >(null);
  const [catchUp, setCatchUp] = useState(false); // the dialog is open; it never opens by itself
  const showRef = useRef<HTMLButtonElement>(null);
  const [announce, setAnnounce] = useState(readAnnounce);
  const hint = useId();
  // Minimized, the bar keeps only its head (the clock line, Play/Pause, Live and the toggle); the stream is untouched.
  const [minimized, setMinimized] = useState(readMinimized);
  const controlsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState('');
  const [voice] = useState(() => createVoice(setSaid));
  const [store] = useState(() => createStore());
  const snap = useSyncExternalStore(store.subscribe, store.get);
  // T = clock.t + the wall time since clock.wall while playing; resynced to every event's t.
  // A live delay increase moves `wall` on by the added hold, and `floor` keeps T from stepping back below what it showed
  // (#101); any new `clock` drops the floor.
  const clock = useRef<Clock>({
    t: resumed ?? (start === 'live' ? Date.now() - delay * 1000 : start),
    wall: Date.now(),
  });
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
  // The open stream and how long it holds each event (ms): the shown delay above the open stream's own.
  const stream = useRef<Stream | undefined>(undefined);
  const held = useRef(0);

  const nowT = () => (playing ? clockT(clock.current) : clock.current.t);
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
    // P7a, D1: positions on every tab, so a tab switch never reopens the stream.
    const params = { recording: recording.id, at: from, delay: open.delay ?? 0, still: still === true, pos: true };
    held.current = from === 'live' ? Math.max(0, delayNow.current - params.delay) * 1000 : 0;
    const opened = openStream(params, {
      onData(feed, kind) {
        // A position's t is behind the newest receive time: it moves neither the clock nor what the state stands at.
        if (kind === 'pos') {
          store.update(feed, kind);
          return;
        }
        clock.current = { t: feed.t, wall: Date.now() };
        stood.current = feed.t;
        store.update(feed, kind);
        lastFeed.current = feed;
        if (kind !== 'snapshot') return;
        backoff.current = 1000;
        failCount.current = 0;
        setFails(0);
        setProbe(null);
        probing.current?.abort();
        const j = jump.current;
        if (j) {
          jump.current = undefined;
          const from = j.from;
          const events = from && skippedEvents(from, feed);
          const text = events ? skippedText(tally(events)) : '';
          setSince(from && events && text ? { text, events, ...skippedWindow(from, feed) } : null);
          voice.say(`At ${fmtClock(feed.t)}.${text ? ` Before this point: ${text}.` : ''}`);
        }
        // A still frame has what it came for: it closes itself (the cleanup's second close is a no-op).
        if (still) {
          opened.close();
          setOpen({ at: null });
        }
      },
      onError() {
        failCount.current += 1;
        setFails(failCount.current);
        // EventSource cannot see the status: one HEAD tells an expired login from missing files (#100, D3).
        if (failCount.current === PROBE_AT) {
          probing.current?.abort();
          const ctl = new AbortController();
          probing.current = ctl;
          void probeStream(streamUrl(params), ctl.signal).then((p) => {
            if (ctl.signal.aborted) return;
            setProbe(p);
            if (p !== 'missing') return;
            // Stop at T, clamped as the retry does.
            backoff.current = 1000;
            const { started_at, ended_at } = rec.current;
            const end = ended_at === null ? Date.now() : Date.parse(ended_at);
            const now = still ? clock.current.t : clockT(clock.current);
            const t = Math.round(clamp(now, Date.parse(started_at), end));
            clock.current = { t, wall: Date.now() };
            stood.current = t;
            failCount.current = 0;
            setFails(0);
            setOpen({ at: null });
          });
        }
        const wait = backoff.current;
        backoff.current = Math.min(wait * 2, 30_000);
        retry = setTimeout(() => {
          const t = clockT(clock.current);
          const { started_at, ended_at } = rec.current;
          const end = ended_at === null ? Date.now() : Date.parse(ended_at);
          // A still frame retries as a still at its own T, which does not run.
          // Live reopens at the delay shown now, so the new stream holds nothing.
          setOpen(
            still
              ? { at: from, still }
              : from === 'live'
                ? { at: 'live', delay: delayNow.current }
                : { at: Math.round(clamp(t, Date.parse(started_at), end)) },
          );
        }, wait);
      },
      onStale() {
        markStale();
        setStale(true);
      },
      onEnd(t) {
        clock.current = { t, wall: Date.now() };
        stood.current = t;
        setOpen({ at: null });
      },
    });
    opened.hold(held.current); // 0 unless the delay moved before this open
    stream.current = opened;
    return () => {
      opened.close();
      if (stream.current === opened) stream.current = undefined;
      clearTimeout(retry);
    };
  }, [recording.id, open, store, voice]);

  useEffect(
    () => () => {
      clearTimeout(timers.current.delay);
      clearTimeout(timers.current.seek);
      probing.current?.abort();
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
    const id = setInterval(() => writeT(clockT(clock.current)), WRITE_T_MS);
    return () => clearInterval(id);
  }, [keepT, playing]);

  // Live, the open stream keeps its own delay (#101): at or above it, its events are held for the difference at once,
  // and T stands still for an increase (the clock's wall moves by the change in hold) until the held events come due;
  // below it, the hold drops to 0 and one stream opens at the new delay 400 ms after the last change.
  const changeDelay = (s: number) => {
    const v = clamp(Math.round(s), 0, MAX_DELAY);
    setDelay(v);
    writeDelay(v);
    delayNow.current = v;
    clearTimeout(timers.current.delay);
    if (open.at !== 'live') return;
    const from = open.delay ?? 0;
    const hold = Math.max(0, v - from) * 1000;
    if (hold !== held.current) {
      clock.current = { t: clock.current.t, wall: clock.current.wall + hold - held.current, floor: nowT() };
      held.current = hold;
      stream.current?.hold(hold);
    }
    // Not after a pause or a seek, nor when another open (Live, a reconnect) is at this delay already.
    if (v < from)
      timers.current.delay = setTimeout(
        () => setOpen((o) => (o.at === 'live' && o.delay !== v ? { at: 'live', delay: v } : o)),
        DEBOUNCE_MS,
      );
  };

  // A seek, a nudge or a chip: shown at once; 400 ms after the last one, T moves there and the stream reopens there,
  // or, while paused, a still frame fetches the state at that T. A pending still frame closes at the first input.
  const seekTo = (t: number) => {
    seekFrom.current ??= nowT();
    const v = Math.round(clamp(t, lo, hi()));
    setSeek(v);
    setOpen((o) => (o.still ? { at: null } : o));
    clearTimeout(timers.current.seek);
    timers.current.seek = setTimeout(() => {
      jump.current = { from: lastFeed.current };
      const was = seekFrom.current ?? nowT();
      seekFrom.current = undefined;
      const same = Math.floor(was / 1000) === Math.floor(v / 1000);
      setBefore((b) => (same ? b : Math.round(was))); // until the next seek; one into the same second keeps the chip
      freeze(v);
      setSeek(null);
      setSince(null);
      setCatchUp(false); // Show tapped while this seek was pending: the dialog goes with its line, never to reopen alone
      setResumed(null); // the note would name an old time
      setOpen((o) => (o.at === null ? { at: v, still: true } : { at: v }));
      if (keepT) writeT(v); // last: nothing it does can lose the seek
    }, DEBOUNCE_MS);
  };

  // A new stream starts a new streak of errors: the 3rd one probes again. A late 404 would stop at a T that ran on.
  const rearm = () => {
    probing.current?.abort();
    failCount.current = 0;
    backoff.current = 1000;
    setFails(0);
    setProbe(null);
  };
  const pause = () => {
    rearm();
    clearTimeout(timers.current.delay); // a pending live delay reopen: this open supersedes it
    const t = nowT();
    freeze(t);
    stood.current = t;
    setOpen({ at: null });
    if (keepT) writeT(t);
  };
  // A reopen starts T where the stream opens, so it does not jump by the pause before the first event.
  const play = () => {
    rearm();
    const t = Math.round(clamp(nowT(), lo, hi()));
    freeze(t);
    setResumed(null);
    setOpen({ at: t });
  };
  const goLive = () => {
    keepFocus(); // the Live button that was clicked goes
    rearm();
    clearTimeout(timers.current.delay); // a pending live delay reopen: this open supersedes it
    freeze(Date.now() - delay * 1000);
    setResumed(null);
    setOpen({ at: 'live', delay });
  };
  // Live, a nudge moves the delay: earlier is more delay. In replay it moves T.
  const nudge = (s: number) => (at === 'live' ? changeDelay(delay - s) : seekTo(now() + s * 1000));
  // The replay keeps the tab in the URL (`?tab=`, #100); `/live` never writes.
  const pick = (t: PlayerTab) => {
    setTab(t);
    if (keepT) writeQuery({ tab: t });
  };
  const toggleAnnounce = (on: boolean) => {
    setAnnounce(on);
    writeAnnounce(on);
  };
  // Before a button goes, so focus is not lost to the page; a minimized bar has no Position range.
  const keepFocus = () => (minimized ? toggleRef : position).current?.focus();
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
  // The feed's knock-outs, per flush: a part switch moves By phase while no lap row changes. The key keeps the lap table
  // tabs rebuilt only on row or knock-out changes. They count once the feed shows this recording's session (as `wall` waits).
  const reachedKey = useMemo(
    () =>
      detail?.session.type === 'Qualifying' &&
      snap.feed &&
      (sessionKey === undefined || view(snap.feed.state, 'SessionInfo')?.Key === sessionKey)
        ? JSON.stringify([...feedReached(snap.feed.state)])
        : '',
    [snap, detail, sessionKey],
  );
  // The series is parsed once per flush; the ticking bar only filters it at T.
  const series = useMemo(() => (snap.feed ? statusSeries(snap.feed.state) : []), [snap]);
  const year = detail?.meeting.year ?? null;
  const starts = detail?.session.date_start;
  // The state is mutated in place: what is derived from it is keyed on the snapshot, a new object per store flush.
  const tower = useMemo(
    () =>
      snap.feed && (
        <TowerTab
          snap={snap}
          series={series}
          lo={lo}
          sessionKey={sessionKey}
          year={year}
          starts={starts}
          focus={focus}
          onFocus={(n) => {
            const next = focus === n ? null : n;
            setFocus(next);
            // /live keeps nothing else in its URL: the other params are not read there.
            writeQuery({ focus: next }, keepT ? location.search : '');
          }}
        />
      ),
    [snap, series, lo, sessionKey, year, starts, focus, keepT],
  );
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
      rc: raceControl(s, snap.laps),
      pairs: withinASecond(s),
      fastest: fastestSoFar(s),
      bests: bestsSoFar(s),
    };
  }, [snap, sessionKey]);
  // The tab shown: Order falls back to the Tower when the session is not (or no longer) a race.
  const shown = tab === 'order' && !wall?.race ? 'tower' : tab;
  // The map's drivers: the DriverList, read only while the map is shown and once per flush.
  const drivers = useMemo(
    () => (shown === 'map' && snap.feed ? (view(snap.feed.state, 'DriverList') ?? {}) : {}),
    [shown, snap],
  );
  // The running order (races only) from the stream's lap rows up to T, built only on its tab and, as the lap table, only
  // when the lap rows change (the DriverList and the grid it reads are set before the first lap). Its drivers are the
  // whole DriverList: the Grid row names a car that never set a lap.
  const onOrder = shown === 'order';
  const order = useMemo(() => {
    const s = feed?.state;
    return (
      onOrder &&
      detail &&
      s && (
        <Order
          drivers={Object.keys(view(s, 'DriverList') ?? {})
            .filter((n) => /^\d{1,3}$/.test(n))
            .map((n) => driverOf(view(s, 'DriverList') ?? {}, n))}
          laps={snap.laps}
          grid={gridOf(s)}
          noGrid="No grid position in the feed"
        />
      )
    );
  }, [onOrder, detail, feed, snap.laps]);
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
  // The pill says when the stream is not delivering (#237): stale wins; the reconnect line stays as the detail.
  const stopped = probe === 'missing' && at === null;
  const warning = stale ? 'Stale' : stopped ? 'Stopped' : at !== null && fails > 0 ? 'Reconnecting' : null;
  // A live delay increase holds T (`floor`, #101): the seconds left of it, rounded up, read at each tick.
  const holding = () => {
    const c = clock.current;
    // No clamp at 0, unlike `clockT`: `wall` is ahead of now for the length of the hold.
    return live && c.floor !== undefined ? Math.ceil((c.floor - (c.t + Date.now() - c.wall)) / 1000) : 0;
  };
  const pillWord = () => {
    if (warning) return warning;
    const n = holding();
    return n > 0 ? `LIVE, holding ${n} s` : mode;
  };
  // Live, a nudge that would move nothing (later at no delay, earlier at the most) is off (#237): aria-disabled, not
  // `disabled`, so a focused button keeps the focus; the click does nothing at the clamp.
  const nudgeButton = (s: number) => (
    <button
      key={s}
      type="button"
      aria-label={nudgeLabel(s)}
      aria-disabled={live && (s > 0 ? delay === 0 : delay === MAX_DELAY) ? 'true' : undefined}
      onClick={() => nudge(s)}
    >
      {signed(s)}
    </button>
  );
  const playButton = (
    <button type="button" className="play" onClick={playing ? pause : play}>
      {playing ? 'Pause' : 'Play'}
    </button>
  );

  // In replay of an open recording: a mode switch, in the transport and, minimized, in the head after Play (#237).
  const liveButton = !live && recording.ended_at === null && (
    <button type="button" className="golive" onClick={goLive}>
      Live
    </button>
  );

  // The reconnect line (A§13): a 404 stops the player and says so until Play; then the probe's answer, the reload
  // hint after FAILING errors, or "Reconnecting…".
  const line = stale
    ? null
    : stopped
      ? PROBE_TEXT.missing
      : at === null || fails === 0
        ? null
        : probe !== null && probe !== 'missing'
          ? navigator.onLine === false
            ? OFFLINE // offline wins over the probe's answer
            : PROBE_TEXT[probe]
          : fails >= FAILING
            ? navigator.onLine === false
              ? OFFLINE
              : RELOAD
            : RECONNECTING;

  return (
    <>
      {line !== null && (
        <p role="status" className={line === RECONNECTING ? 'muted' : undefined}>
          {line}
        </p>
      )}
      {resumed !== null && <p className="muted">Resumed at {fmtClock(resumed)}: press Play when the video is there.</p>}
      {/* The strip's message links to the race-control card only where the card is on the page: the Tower tab's pit wall (#237). */}
      {wall && (
        <Strip
          strip={wall.strip}
          now={stateNow}
          playing={playing}
          target={state && shown === 'tower' ? RC_ID : undefined}
        />
      )}
      {since !== null && (
        <p className="since">
          <b>Before this point</b> <span>{since.text}</span>
          <button ref={showRef} type="button" aria-haspopup="dialog" onClick={() => setCatchUp(true)}>
            Show
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              keepFocus();
              setSince(null);
            }}
          >
            ×
          </button>
        </p>
      )}
      {catchUp && since !== null && (
        <CatchUp
          events={since.events}
          laps={since.laps}
          minutes={since.minutes}
          year={year}
          onReplay={(t) => {
            // The seek commit drops the line and its Show button: the focus goes where Dismiss sends it.
            setCatchUp(false);
            keepFocus();
            seekTo(t);
          }}
          onClose={() => {
            setCatchUp(false);
            showRef.current?.focus(); // the browser restores it too; happy-dom does not
          }}
        />
      )}
      {detail && (
        <fieldset className="segmented views" aria-label="View">
          {TABS.filter(([t]) => t !== 'order' || wall?.race).map(([t, label]) => (
            <button key={t} type="button" aria-pressed={shown === t} onClick={() => pick(t)}>
              {label}
            </button>
          ))}
        </fieldset>
      )}
      {/* A boundary per tab (#100): a crash in one leaves the strip, the bar, the stream and the other tabs; a switch resets it. */}
      <ErrorBoundary key={shown}>
        {!state ? (
          <p className="muted">Connecting…</p>
        ) : shown === 'map' ? (
          <TrackMap
            circuit={detail?.meeting.circuit_short_name}
            positions={store.pos}
            ended={recording.ended_at !== null}
            drivers={drivers}
            focus={focus}
            now={now}
            playing={playing}
          />
        ) : detail && feed && (shown === 'laps' || shown === 'compare' || shown === 'stints') ? (
          <SessionTabs
            tab={shown}
            detail={detail}
            feed={feed}
            laps={snap.laps}
            stints={snap.stints}
            pits={snap.pits}
            weather={shown === 'stints' ? snap.weather.rows : NO_WEATHER}
            lo={lo}
            reached={reachedKey}
            chosen={chosen}
            onPick={setChosen}
          />
        ) : order ? (
          order
        ) : shown === 'weather' ? (
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
            <Panel
              rc={wall.rc}
              pairs={wall.pairs}
              fastest={wall.fastest}
              bests={wall.bests}
              race={wall.race}
              id={RC_ID}
            />
          </div>
        ) : (
          tower
        )}
      </ErrorBoundary>
      {!detail && detailError != null && <ErrorView error={detailError} retry={retryDetail} />}
      <section className={minimized ? 'player min' : 'player'} aria-label="Playback controls">
        {/* The head stays when minimized: the clock line, Play/Pause and Live (from the transport) and the toggle. */}
        <div className="barhead">
          <Clock
            now={now}
            stateNow={stateNow}
            playing={playing}
            strip={wall?.strip}
            pill={warning ? 'pill warn' : live ? 'pill live' : 'pill'}
            word={pillWord}
          />
          {minimized && playButton}
          {minimized && liveButton}
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
                {liveButton}
              </div>
              <BackTo
                before={before}
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
                <input
                  type="checkbox"
                  aria-describedby={hint}
                  checked={announce}
                  onChange={(e) => toggleAnnounce(e.target.checked)}
                />
                Announce events to a screen reader
                <span className="muted" id={hint} aria-hidden="true">
                  The start, track status, fastest laps and what a skip passes over.
                </span>
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
