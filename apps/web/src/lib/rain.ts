import type { Rain } from '@f1/contracts';
import { compass, type Point } from './weather.ts';

// The rain map's numbers (P5c, A§13), pure. A frame is Open-Meteo's 15-minute precipitation sum per grid point in mm,
// row-major from the north-west; the map shows it as mm/h (× 4) in three steps.

export type RainGrid = NonNullable<Rain['grid']>;
export type RainFrame = Rain['frames'][number];
export type Step = 0 | 1 | 2 | 3;

/** 15-minute mm as a step of mm/h: under 0.1 (or no value) nothing, then light, moderate (from 2.5) and heavy (from 7.6). */
export function rainStep(mm15: number | null): Step {
  if (mm15 === null) return 0;
  const perHour = mm15 * 4;
  return perHour < 0.1 ? 0 : perHour < 2.5 ? 1 : perHour < 7.6 ? 2 : 3;
}

const centre = (k: number, size: number, stepKm: number) => {
  const mid = (size - 1) / 2;
  return { cx: ((k % size) - mid) * stepKm, cy: (Math.floor(k / size) - mid) * stepKm };
};

/** Cell k's square in the map's km frame (x east, y south, the centre at 0 0): its top-left corner and its width. */
export function cellRect(k: number, size: number, stepM: number): { x: number; y: number; w: number } {
  const w = stepM / 1000;
  const { cx, cy } = centre(k, size, w);
  return { x: cx - w / 2, y: cy - w / 2, w };
}

const WORD: Record<Point, string> = {
  N: 'north',
  NE: 'north-east',
  E: 'east',
  SE: 'south-east',
  S: 'south',
  SW: 'south-west',
  W: 'west',
  NW: 'north-west',
};

/**
 * One frame in words, the map's text alternative: "No rain within 5 km", or "Rain in 12 of 49 cells, heaviest 3.2 mm/h,
 * 2 km north-west of the circuit" ("…, at the circuit" for the centre cell). A tie goes to the first cell row-major.
 */
export function rainSummary(mm: readonly (number | null)[], size: number, stepM: number): string {
  let wet = 0;
  let top = -1;
  mm.forEach((v, k) => {
    if (rainStep(v) === 0) return;
    wet++;
    if (top < 0 || (v ?? 0) > (mm[top] ?? 0)) top = k;
  });
  if (top < 0) return 'No rain within 5 km';
  const heaviest = `heaviest ${((mm[top] ?? 0) * 4).toFixed(1)} mm/h`;
  const { cx, cy } = centre(top, size, stepM / 1000);
  // North is −y: the bearing is clockwise from north.
  const where =
    cx === 0 && cy === 0
      ? 'at the circuit'
      : `${Math.round(Math.hypot(cx, cy))} km ${WORD[compass((Math.atan2(cx, -cy) * 180) / Math.PI)]} of the circuit`;
  return `Rain in ${wet} of ${size * size} cells, ${heaviest}, ${where}`;
}

/** The first frame at or after the session's start, else the last frame, else 0. */
export function firstFrameAt(frames: readonly RainFrame[], dateStartIso: string): number {
  const start = Date.parse(dateStartIso);
  const i = frames.findIndex((f) => Date.parse(f.date) >= start);
  return i >= 0 ? i : Math.max(0, frames.length - 1);
}

/** The last frame dated at or before `tMs` (frames in date order), −1 if none. */
export const lastFrameAtOrBefore = (frames: readonly RainFrame[], tMs: number): number =>
  frames.findLastIndex((f) => Date.parse(f.date) <= tMs);
