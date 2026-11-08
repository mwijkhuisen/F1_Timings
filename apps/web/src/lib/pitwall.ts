import { type Obj, view } from '@f1/contracts';
import { driverOf, towerRows } from '../views/Tower.tsx';
import type { Driver } from './session.ts';
import { utc } from './stream.ts';

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
const DEGREES = /^-?\d{1,3}(?:\.\d{1,2})?$/;
const KEY = /^\d{1,6}$/;

function clockOf(state: Obj): Clock | undefined {
  const c = view(state, 'ExtrapolatedClock');
  const m = HMS.exec(c?.Remaining ?? '');
  const utcMs = utc(c?.Utc);
  if (!m || Number.isNaN(utcMs)) return undefined;
  const [, h, min, s] = m.map(Number) as [number, number, number, number];
  return { remainingS: h * 3600 + min * 60 + s, utcMs, extrapolating: c?.Extrapolating === true };
}

function weatherOf(state: Obj): string | undefined {
  const w = view(state, 'WeatherData');
  const parts = [
    DEGREES.test(w?.AirTemp ?? '') && `${w?.AirTemp}° air`,
    DEGREES.test(w?.TrackTemp ?? '') && `${w?.TrackTemp}° track`,
    w?.Rainfall === '0' ? 'dry' : /^\d{1,3}$/.test(w?.Rainfall ?? '') && 'rain',
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
export type Kind = 'flags' | 'sc' | 'incidents' | 'limits' | 'other';
export type RcItem = { key: number; lap?: number | undefined; kind: Kind; tag?: string | undefined; text: string };
export type RaceControl = { items: RcItem[]; counts: Record<Kind | 'all', number> };

/** A message's kind and tag, first match wins. The incidents, track limits and 2026's red-flag text are Category Other. */
function kindOf(category: string | undefined, text: string): { kind: Kind; tag?: string } {
  if (category === 'SafetyCar') return { kind: 'sc', tag: /VIRTUAL/.test(text) ? 'VSC' : 'SC' };
  if (category === 'Flag' || /\bRED FLAG\b/.test(text)) return { kind: 'flags', tag: 'FLAG' };
  if (/TRACK LIMITS|\bDELETED\b/.test(text)) return { kind: 'limits', tag: 'LIMITS' };
  if (/INCIDENT|INVESTIGAT|PENALTY|STEWARDS/.test(text)) return { kind: 'incidents', tag: 'INCIDENT' };
  return { kind: 'other' };
}

/**
 * The race-control messages newest first, each with its kind, and the count per kind. "Up to T" is the state itself:
 * the stream sends nothing after T and replays from the first line on a seek (A§11.3).
 */
export function raceControl(state: Obj): RaceControl {
  const counts = { all: 0, flags: 0, sc: 0, incidents: 0, limits: 0, other: 0 };
  const items = messages(state)
    .reverse()
    .map(({ key, m, text }) => {
      const { kind, tag } = kindOf(m.Category, text);
      counts.all++;
      counts[kind]++;
      return { key, lap: m.Lap, kind, tag, text };
    });
  return { items, counts };
}

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

/** The fastest lap so far: the TimingStats line ranked 1 on its personal best (the feed ranks it, deletions included). */
export function fastestSoFar(state: Obj): Fastest | undefined {
  const lines = Object.entries(view(state, 'TimingStats')?.Lines ?? {});
  const hit = lines.find(([n, l]) => /^\d{1,3}$/.test(n) && l?.PersonalBestLapTime?.Position === 1);
  const pb = hit?.[1]?.PersonalBestLapTime;
  if (!hit || !pb?.Value) return undefined;
  return { driver: driverOf(view(state, 'DriverList') ?? {}, hit[0]), value: pb.Value, lap: pb.Lap };
}
