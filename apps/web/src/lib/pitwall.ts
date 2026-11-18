import {
  type Lap,
  type Obj,
  type Overtakes as OvRows,
  overtakesOf,
  type RaceControl as RcRows,
  type Views,
  view,
  weatherRow,
} from '@f1/contracts';
import { driverOf, towerRows } from '../views/Tower.tsx';
import type { Driver } from './session.ts';
import { utc } from './stream.ts';
import { fmtClock } from './time.ts';
import { reading } from './weather.ts';

// The pit wall (A§13, P4d): the session light, the status strip and the side panel, derived from the feed state once
// per store flush (views/Player.tsx). Pure: nothing here ticks; `leftAt` turns a derived clock into a time left at T.

export type Lamp = 'r' | 'y' | 'g' | 'chq';

/** Each state of the session light: the lit lamp (none when off or unknown) and the word that names it. */
export const LIGHT = {
  clear: { lamp: 'g', word: 'Track clear' },
  yellow: { lamp: 'y', word: 'Yellow flag' },
  sc: { lamp: 'y', word: 'Safety car' },
  vsc: { lamp: 'y', word: 'VSC' },
  vscEnding: { lamp: 'y', word: 'VSC ending' },
  red: { lamp: 'r', word: 'Red flag' },
  stopped: { lamp: 'r', word: 'Stopped' },
  finished: { lamp: 'chq', word: 'Chequered flag' },
  off: { lamp: null, word: 'Not started' },
  unknown: { lamp: null, word: 'Track status unknown' },
} as const satisfies Record<string, { lamp: Lamp | null; word: string }>;

export type Light = keyof typeof LIGHT;

const TRACK: Record<string, Light> = {
  '1': 'clear',
  '2': 'yellow',
  '4': 'sc',
  '5': 'red',
  '6': 'vsc',
  '7': 'vscEnding',
};

/**
 * The light for a SessionStatus and a TrackStatus code (A§11.1). A session that is not running shows its own state;
 * while it runs, a code without a meaning here (3, or none) is "unknown", never a guessed "clear".
 */
export function lightOf(sessionStatus: string | undefined, trackStatus: string | undefined): Light {
  if (sessionStatus === 'Finished' || sessionStatus === 'Finalised' || sessionStatus === 'Ends') return 'finished';
  if (sessionStatus === 'Aborted') return 'stopped';
  if (sessionStatus !== 'Started') return 'off';
  return (trackStatus !== undefined && Object.hasOwn(TRACK, trackStatus) && TRACK[trackStatus]) || 'unknown';
}

/** A session runs while it is Started, or Aborted (stopped under a red flag): the tab title then carries the light. */
export const running = (sessionStatus: string | undefined): boolean =>
  sessionStatus === 'Started' || sessionStatus === 'Aborted';

/** ExtrapolatedClock: the time left at `utcMs`, counting down from there while `extrapolating`. */
export type Clock = { remainingS: number; utcMs: number; extrapolating: boolean };

export type Strip = {
  light: Light;
  lap?: { current: number; total?: number | undefined } | undefined;
  clock?: Clock | undefined;
  weather?: string | undefined;
  /** The latest race-control message. */
  latest?: { lap?: number | undefined; text: string } | undefined;
};

const HMS = /^(\d{1,2}):(\d{2}):(\d{2})$/;
const KEY = /^\d{1,6}$/;

function clockOf(state: Obj): Clock | undefined {
  const c = view(state, 'ExtrapolatedClock');
  const m = HMS.exec(c?.Remaining ?? '');
  const utcMs = utc(c?.Utc);
  if (!m || Number.isNaN(utcMs)) return undefined;
  const [, h, min, s] = m.map(Number) as [number, number, number, number];
  return { remainingS: h * 3600 + min * 60 + s, utcMs, extrapolating: c?.Extrapolating === true };
}

/** The latest reading as the Weather tab reads it (`weatherRow` + `reading`): numbers only, a 0 temperature left out. */
function weatherOf(state: Obj): string | undefined {
  const w = reading(weatherRow(view(state, 'WeatherData'), 0));
  const parts = [
    w.air_temperature !== null && `${w.air_temperature.toFixed(1)}° air`,
    w.track_temperature !== null && `${w.track_temperature.toFixed(1)}° track`,
    w.rainfall !== null && (w.rainfall > 0 ? 'rain' : 'dry'),
  ].filter((p) => typeof p === 'string');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The race-control messages with a text, by numeric key, oldest first. */
function messages(state: Obj) {
  return Object.entries(view(state, 'RaceControlMessages')?.Messages ?? {})
    .flatMap(([key, m]) =>
      m?.Message !== undefined && KEY.test(key) ? [{ key: Number(key), m, text: m.Message }] : [],
    )
    .sort((a, b) => a.key - b.key);
}

/** The status strip's values: the light, and each cell only when the feed has it. */
export function stripOf(state: Obj): Strip {
  const lapCount = view(state, 'LapCount');
  const latest = messages(state).at(-1);
  return {
    light: lightOf(view(state, 'SessionStatus')?.Status, view(state, 'TrackStatus')?.Status),
    lap: lapCount?.CurrentLap === undefined ? undefined : { current: lapCount.CurrentLap, total: lapCount.TotalLaps },
    clock: clockOf(state),
    weather: weatherOf(state),
    latest: latest && { lap: latest.m.Lap, text: latest.text },
  };
}

/** Seconds left at T: counting down from the clock's Utc while it extrapolates, held otherwise; within [0, remaining]. */
export const leftAt = (clock: Clock, T: number): number =>
  clock.extrapolating
    ? Math.min(clock.remainingS, Math.max(0, clock.remainingS - (T - clock.utcMs) / 1000))
    : clock.remainingS;

const two = (n: number) => String(n).padStart(2, '0');

/** `MM:SS`, or `H:MM:SS` from one hour; whole seconds, rounded down. */
export function fmtLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mmss = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** The race-control kinds (D2): the filter chips. A message of no kind shows under All only. */
export type Kind = 'flags' | 'sc' | 'incidents' | 'limits' | 'other' | 'overtake';
export type RcItem = {
  key: number;
  /** The clock time (Amsterdam) of an OpenF1 row; the feed's messages carry none. */
  time?: string | undefined;
  lap?: number | undefined;
  kind: Kind;
  tag?: string | undefined;
  text: string;
  /** An `overtake` item (#236): the car, the places it gained and, once the card knows the cars, who it is. */
  driver_number?: number | null | undefined;
  places?: number | undefined;
  driver?: Driver | undefined;
};
/** `overtakes`: the feed has the OvertakeSeries topic for this race, so the card offers its chip (#236). */
export type RaceControl = { items: RcItem[]; counts: Record<Kind | 'all', number>; overtakes: boolean };

/**
 * The race lap at `t` (#236), like a message's `Lap` (the leader's): the highest `lap_number` of any driver whose
 * `date_start` is at or before t. Before every start it is lap 1 when the earliest known lap is 1 or 2, else unknown
 * (a recording joined mid-race, or a hole in the laps). The starts are sorted once, here.
 */
export function lapAt(laps: readonly Pick<Lap, 'lap_number' | 'date_start'>[]) {
  const starts = laps
    .flatMap((l) => {
      const s = l.date_start === null ? Number.NaN : Date.parse(l.date_start);
      return Number.isNaN(s) ? [] : [{ n: l.lap_number, s }];
    })
    .sort((a, b) => a.s - b.s);
  let high = 0;
  const upTo = starts.map((x) => (high = Math.max(high, x.n))); // the highest lap started by each start
  return (t: number): number | undefined => {
    const i = starts.findLastIndex((x) => x.s <= t);
    if (i >= 0) return upTo[i];
    return (starts[0]?.n ?? 3) <= 2 ? 1 : undefined; // no start at all: unknown
  };
}

type Timed = [t: number, item: RcItem];

/** An overtake item: no text, the lap from `at`; a negative key never meets a message's. */
const overtake = (
  i: number,
  o: { driver_number: number; t: number; places: number },
  at: ReturnType<typeof lapAt>,
  timed = false,
): Timed => [
  o.t,
  {
    key: -1 - i,
    time: timed ? fmtClock(o.t) : undefined,
    lap: at(o.t),
    kind: 'overtake',
    text: '',
    driver_number: o.driver_number,
    places: o.places,
  },
];

/** The messages oldest first with each overtake before the first message that is later; an untimed message (NaN) keeps its place. */
function interleave(msgs: Timed[], ovs: Timed[]): RcItem[] {
  const out: RcItem[] = [];
  let i = 0;
  for (const [t, item] of msgs) {
    while (i < ovs.length && (ovs[i] as Timed)[0] < t) out.push((ovs[i++] as Timed)[1]);
    out.push(item);
  }
  return out.concat(ovs.slice(i).map(([, item]) => item));
}

/** A message's kind and tag, first match wins. The incidents, track limits and 2026's red-flag text are Category Other. */
export function kindOf(category: string | undefined, text: string): { kind: Kind; tag?: string } {
  if (category === 'SafetyCar') return { kind: 'sc', tag: /VIRTUAL/.test(text) ? 'VSC' : 'SC' };
  if (category === 'Flag' || /\bRED FLAG\b/.test(text)) return { kind: 'flags', tag: 'FLAG' };
  if (/TRACK LIMITS|\bDELETED\b/.test(text)) return { kind: 'limits', tag: 'LIMITS' };
  if (/INCIDENT|INVESTIGAT|PENALTY|STEWARDS/.test(text)) return { kind: 'incidents', tag: 'INCIDENT' };
  return { kind: 'other' };
}

/**
 * The race-control messages newest first, each with its kind, and the count per kind. "Up to T" is the state itself:
 * the stream sends nothing after T and replays from the first line on a seek (A§11.3). In a race whose state has the
 * OvertakeSeries, its places gained join the messages by time (#236); the messages' `Utc` places them.
 */
export function raceControl(
  state: Obj,
  laps: readonly Pick<Lap, 'driver_number' | 'lap_number' | 'date_start'>[],
): RaceControl {
  const overtakes = view(state, 'SessionInfo')?.Type === 'Race' && view(state, 'OvertakeSeries') !== undefined;
  const at = lapAt(laps);
  const drivers = overtakes ? (view(state, 'DriverList') ?? {}) : {};
  const items = interleave(
    messages(state).map(({ key, m, text }) => [utc(m.Utc), { key, lap: m.Lap, ...kindOf(m.Category, text), text }]),
    overtakes
      ? overtakesOf(state).map((o, i): Timed => {
          const [t, item] = overtake(i, o, at);
          return [t, { ...item, driver: driverOf(drivers, String(o.driver_number)) }];
        })
      : [],
  ).reverse();
  return { items, counts: countKinds(items), overtakes };
}

/** The number of items per kind, and all of them. */
export function countKinds(items: readonly { kind: Kind }[]): RaceControl['counts'] {
  const counts = { all: 0, flags: 0, sc: 0, incidents: 0, limits: 0, other: 0, overtake: 0 };
  for (const { kind } of items) {
    if (kind !== 'overtake') counts.all++; // the places gained are a toggle beside the kinds, never part of All (#236)
    counts[kind]++;
  }
  return counts;
}

export type RcLogItem = RcItem & { phase?: number | undefined; driver_number: number | null };

/**
 * An OpenF1 session's race-control rows with a message, in API order (A§6.1, #111). A row's phase is the last
 * non-null `qualifying_phase` at or before it (A§9's lap rule: deletions and stewards' notes carry none); in
 * qualifying, rows before a first phase row of 2 are Q1. Other rows before any phase row have none.
 */
export function rcLog(
  rows: RcRows,
  qualifying: boolean,
  overtakes: OvRows,
  laps: readonly Pick<Lap, 'driver_number' | 'lap_number' | 'date_start'>[],
): RcLogItem[] {
  const first = rows.find((r) => r.qualifying_phase !== null)?.qualifying_phase ?? undefined;
  let phase = qualifying && first !== undefined && first === 2 ? 1 : undefined;
  const msgs = rows.flatMap((r, key): [number, RcLogItem][] => {
    if (r.qualifying_phase !== null) phase = r.qualifying_phase;
    if (r.message === null) return [];
    const t = r.date === null ? Number.NaN : Date.parse(r.date);
    return [
      [
        t,
        {
          key,
          time: r.date === null ? '—' : fmtClock(t),
          lap: r.lap_number ?? undefined,
          phase,
          ...kindOf(r.category ?? undefined, r.message),
          text: r.message,
          driver_number: r.driver_number,
        },
      ],
    ];
  });
  // A qualifying session has no places gained (races only, #236).
  const at = lapAt(laps);
  const ovs = qualifying
    ? []
    : overtakes.map((o, i) =>
        overtake(i, { driver_number: o.driver_number, t: Date.parse(o.date), places: o.places }, at, true),
      );
  return interleave(msgs, ovs) as RcLogItem[];
}

const CAR_ACRONYM = /\b(\d{1,3}) \(([A-Z]{3})\)/g;

/**
 * Whether a row names the driver: its `driver_number`, or "CAR n (ABC)" in the text with both the number and the
 * acronym equal (A§9; `driver_number` is null on most rows). The acronym keeps "16:29:31 (PIT)" from reading as car 31.
 */
export const mentions = (row: { driver_number: number | null; text: string }, driver: Driver): boolean =>
  row.driver_number === driver.number ||
  [...row.text.matchAll(CAR_ACRONYM)].some((m) => Number(m[1]) === driver.number && m[2] === driver.acronym);

export type Pair = { place: string | undefined; ahead: Driver; behind: Driver; interval: string };

/** In a race, every car within a second of the one ahead (the tower's `close` rows), with that car and its place. */
export function withinASecond(state: Obj): Pair[] {
  const rows = towerRows(state);
  return rows.flatMap((r, i) => {
    const ahead = rows[i - 1];
    return r.close && ahead && 'value' in r.interval
      ? [{ place: ahead.position, ahead: ahead.driver, behind: r.driver, interval: r.interval.value }]
      : [];
  });
}

export type Fastest = { driver: Driver; value: string; lap?: number | undefined };

const LAP_TIME = /^(?:(?:(\d{1,2}):)?(\d{1,2}):)?(\d{1,2})\.(\d{3})$/;

/** `h:mm:ss.SSS`, `m:ss.SSS` or `ss.SSS` in ms; anything else Infinity (sorts last). */
const lapMs = (v: string): number => {
  const m = LAP_TIME.exec(v);
  if (!m) return Number.POSITIVE_INFINITY;
  const [h, min, s, ms] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number];
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
};

type Line = NonNullable<NonNullable<Views['TimingStats']['Lines']>[string]>;
type Ranked = { Value?: string | undefined; Position?: number | undefined };

/**
 * Over the TimingStats lines, the picked value ranked 1 with a text, the lowest `score` winning: the feed ranks it, but
 * may leave a stale 1 on the driver just beaten. A tie (two Infinity too) keeps the first in key order.
 */
function first<T extends Ranked>(
  lines: Views['TimingStats']['Lines'],
  pick: (l: Line) => T | undefined,
  score: (value: string) => number,
) {
  let best: { n: string; v: T; value: string; s: number } | undefined;
  for (const [n, l] of Object.entries(lines ?? {})) {
    const v = l && pick(l);
    if (!/^\d{1,3}$/.test(n) || v?.Position !== 1 || !v.Value) continue;
    const s = score(v.Value);
    if (!best || s < best.s) best = { n, v, value: v.Value, s };
  }
  return best;
}

/** The fastest lap so far: the TimingStats line ranked 1 on its personal best (the feed ranks it, deletions included). */
export function fastestSoFar(state: Obj): Fastest | undefined {
  const best = first(view(state, 'TimingStats')?.Lines, (l) => l.PersonalBestLapTime, lapMs);
  return best && { driver: driverOf(view(state, 'DriverList') ?? {}, best.n), value: best.value, lap: best.v.Lap };
}

export type Best = { label: string; value: string; speed: boolean; driver: Driver };

const speed = (v: string): number => (/^\d{1,3}(\.\d+)?$/.test(v) ? -Number(v) : Number.POSITIVE_INFINITY);

/** The feed's bests so far, each with its holder: S1 to S3, then I1, I2, finish line and speed trap; none without a ranked value. */
export function bestsSoFar(state: Obj): Best[] {
  const drivers = view(state, 'DriverList') ?? {};
  const lines = view(state, 'TimingStats')?.Lines;
  const sectors = (['0', '1', '2'] as const).map((k, i) => ({
    label: `S${i + 1}`,
    speed: false,
    best: first(lines, (l) => l.BestSectors?.[k], lapMs),
  }));
  const speeds = (
    [
      ['I1', 'I1'],
      ['I2', 'I2'],
      ['FL', 'Finish line'],
      ['ST', 'Speed trap'],
    ] as const
  ).map(([k, label]) => ({ label, speed: true, best: first(lines, (l) => l.BestSpeeds?.[k], speed) }));
  return [...sectors, ...speeds].flatMap(({ label, speed: sp, best }) =>
    best
      ? [{ label, value: sp ? `${best.value} km/h` : best.value, speed: sp, driver: driverOf(drivers, best.n) }]
      : [],
  );
}
