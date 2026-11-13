import type { Lap, Weather } from '@f1/contracts';
import { fmtHm } from './time.ts';

// The Weather tab's numbers (P5a, A§13), pure. Rows are the station's samples (about one a minute), every row OpenF1
// lists for the session, the hour before a race's start included (owner, 2026-11-09).

export type WeatherRow = Weather[number];
export type Range = { min: number; max: number };
export const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Point = (typeof POINTS)[number];

export type Summary = {
  air: Range | null;
  track: Range | null;
  humidity: Range | null;
  pressure: Range | null;
  /** Wind speed in m/s. */
  wind: { mean: number; max: number } | null;
  /** The most frequent of the 8 compass points; a tie goes to the one seen first. */
  direction: Point | null;
  /** `rain` when any sample had rainfall > 0, `dry` when every reading was 0, null without a reading. */
  rain: 'dry' | 'rain' | null;
};

/** A run of samples with rainfall > 0, as epoch ms of its first and last sample. */
export type RainPeriod = { from: number; to: number };

const dropout = (v: number | null) => (v === 0 ? null : v);

/**
 * A sample as the tab reads it (owner, 2026-11-09; A§6.1): OpenF1 sends a sensor dropout as 0, not null (11388 at
 * 11:32:56 has a track temperature of 0 between 43 °C samples), so a 0 air or track temperature, humidity or pressure
 * is no reading; and a calm sample (wind speed 0) has no direction. The stored rows keep what OpenF1 sent.
 */
export const reading = (r: WeatherRow): WeatherRow => ({
  ...r,
  air_temperature: dropout(r.air_temperature),
  track_temperature: dropout(r.track_temperature),
  humidity: dropout(r.humidity),
  pressure: dropout(r.pressure),
  wind_direction: r.wind_speed === 0 ? null : r.wind_direction,
});

/** 8 points, each 45° wide and centred on its direction: 0° and 359° are both N, 22.5° is NE. */
export const compass = (deg: number): Point => POINTS[((Math.round(deg / 45) % 8) + 8) % 8] ?? 'N';

const range = (values: (number | null)[]): Range | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : { min: Math.min(...known), max: Math.max(...known) };
};

/** Every sample through `reading`, so a dropout never sets a minimum. */
export function summarise(samples: readonly WeatherRow[]): Summary {
  const rows = samples.map(reading);
  const speeds = rows.map((r) => r.wind_speed).filter((v): v is number => v !== null);
  // A Map keeps first-seen order, so the strict > below gives a tie to the point seen first.
  const counts = new Map<Point, number>();
  for (const r of rows) {
    if (r.wind_direction === null) continue;
    const p = compass(r.wind_direction);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let direction: Point | null = null;
  for (const [p, n] of counts) if (direction === null || n > (counts.get(direction) ?? 0)) direction = p;
  const rainfall = rows.map((r) => r.rainfall).filter((v): v is number => v !== null);
  return {
    air: range(rows.map((r) => r.air_temperature)),
    track: range(rows.map((r) => r.track_temperature)),
    humidity: range(rows.map((r) => r.humidity)),
    pressure: range(rows.map((r) => r.pressure)),
    wind:
      speeds.length === 0
        ? null
        : { mean: speeds.reduce((a, b) => a + b, 0) / speeds.length, max: Math.max(...speeds) },
    direction,
    rain: rainfall.length === 0 ? null : rainfall.some((v) => v > 0) ? 'rain' : 'dry',
  };
}

/** A gap between samples longer than this ends a rain period (about five missed samples). */
export const RAIN_GAP_MS = 5 * 60_000;

/**
 * Consecutive samples with rainfall > 0, in date order. A dry sample, a sample without a rainfall reading or a gap
 * over 5 min between two wet samples ends a period.
 */
export function rainPeriods(rows: readonly WeatherRow[]): RainPeriod[] {
  const out: RainPeriod[] = [];
  let open: RainPeriod | null = null;
  const sorted = rows.map((r) => ({ t: Date.parse(r.date), wet: r.rainfall !== null && r.rainfall > 0 }));
  sorted.sort((a, b) => a.t - b.t);
  for (const { t, wet } of sorted) {
    if (open && (!wet || t - open.to > RAIN_GAP_MS)) {
      out.push(open);
      open = null;
    }
    if (!wet) continue;
    if (open) open.to = t;
    else open = { from: t, to: t };
  }
  if (open) out.push(open);
  return out;
}

/**
 * The leader's lap at `at` (epoch ms): the highest lap number any driver had started by then (`date_start ≤ at`), as
 * A§6.1 found race control's lap numbers to be. Null before the first lap starts, and outside `Race`-type sessions,
 * where laps are no race distance; a sprint is `Race`-type, so it counts.
 */
export function leaderLap(
  laps: readonly Pick<Lap, 'lap_number' | 'date_start'>[],
  at: number,
  type: string | null,
): number | null {
  if (type !== 'Race') return null;
  let best: number | null = null;
  for (const l of laps) {
    if (l.date_start === null || Date.parse(l.date_start) > at) continue;
    if (best === null || l.lap_number > best) best = l.lap_number;
  }
  return best;
}

/** "24.1–27.3", or one value when both ends read the same at that precision. */
export const fmtRange = (r: Range, digits: number): string => {
  const [lo, hi] = [r.min.toFixed(digits), r.max.toFixed(digits)];
  return lo === hi ? lo : `${lo}–${hi}`;
};

/** The session head's line (A§13): "Air 24–27 °C · Track 38–45 °C · Dry", or null when nothing is known. */
export function headLine(s: Summary): string | null {
  const parts = [
    s.air && `Air ${fmtRange(s.air, 0)} °C`,
    s.track && `Track ${fmtRange(s.track, 0)} °C`,
    s.rain === 'dry' ? 'Dry' : s.rain === 'rain' ? 'Rain at times' : null,
  ].filter((p): p is string => typeof p === 'string');
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * A rain period in Amsterdam time, "16:31–17:12", and in a race the leader's laps: "· laps 3–12", "· lap 3", or
 * "· before the start" when the rain stopped before lap 1; rain from before the start counts from lap 1.
 */
export function periodText(
  p: RainPeriod,
  laps: readonly Pick<Lap, 'lap_number' | 'date_start'>[] | null,
  type: string | null,
): string {
  const [from, to] = [fmtHm(p.from), fmtHm(p.to)];
  const time = from === to ? from : `${from}–${to}`;
  if (type !== 'Race' || laps === null || laps.length === 0) return time;
  const last = leaderLap(laps, p.to, type);
  if (last === null) return `${time} · before the start`;
  const first = leaderLap(laps, p.from, type) ?? 1;
  return first === last ? `${time} · lap ${first}` : `${time} · laps ${first}–${last}`;
}
