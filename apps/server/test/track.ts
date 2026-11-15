import { deflateRawSync } from 'node:zlib';
import { type Frame, outlinePoints, type Pt } from '../src/live/fit.ts';

// A synthetic practice session on a circuit outline (P7a), every value invented (A§12.1 invariant 3): cars drive the
// outline at a constant speed per lap, put into the F1 frame through the inverse of a known Frame. The Position lines
// follow the recorded format (A§6.2): base64 raw deflate of `Position[].{Timestamp, Entries.<n>.{Status, X, Y, Z}}` in
// 0.1 m units, an entry every 250 ms and a line every second, its F1 timestamp the newest entry's and its receivedAt
// 1.7 s later. Each entry also holds the non-car id 241, and car `cars[0]` sends X = Y = 0 once, 500 ms after t0.

/** A feed.jsonl line: [receivedAt, topic, payload, F1 timestamp]. */
export type Value = [number, string, unknown, string];

export type Car = {
  driver: number;
  /** Each lap's ms. Lap 1 starts at t0 and is an out-lap (PitOut); a last count starts the lap after the last one. */
  laps: readonly number[];
  /** [from, to) in ms after t0 without this car's Position samples. */
  gaps?: readonly (readonly [number, number])[];
  /** [from, to) in ms after t0 with Status OffTrack. */
  offTrack?: readonly (readonly [number, number])[];
};

const ENTRY_MS = 250;
const PER_LINE = 4;
const POSITION_LAG_MS = 1_700;
const TIMING_LAG_MS = 200;
const TAIL_MS = 5_000; // Position data after the last lap's end, past the finder's wait of 1.5 s

const iso = (ms: number) => new Date(ms).toISOString();
const inside = (spans: Car['gaps'], ms: number) => (spans ?? []).some(([a, b]) => ms >= a && ms < b);

/** Outline metres → F1 0.1 m units, through the inverse of `frame`. */
export function toF1(frame: Frame, [X, Y]: Pt): Pt {
  const [u, v] = [(X - frame.tx) / frame.s, (Y - frame.ty) / frame.s];
  const [c, sn] = [Math.cos(frame.theta), Math.sin(frame.theta)];
  const [x, y] = [Math.round((c * u + sn * v) * 10), Math.round(frame.m * (-sn * u + c * v) * 10)];
  if (Math.max(Math.abs(x), Math.abs(y)) > 32_767) throw new Error('the frame puts the track outside int16');
  return [x, y];
}

/** The point at arc length `s` metres (wrapped) along the closed outline, from its first vertex. */
export function along(path: string): { length: number; at(s: number): Pt } {
  const pts = outlinePoints(path);
  const cum = [0];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length] as Pt;
    cum.push((cum[i] as number) + Math.hypot(q[0] - p[0], q[1] - p[1]));
  });
  const length = cum.at(-1) as number;
  return {
    length,
    at(s) {
      const w = ((s % length) + length) % length;
      const i = Math.max(0, cum.findLastIndex((c) => c <= w) % pts.length);
      const [p, q] = [pts[i] as Pt, pts[(i + 1) % pts.length] as Pt];
      const u = (w - (cum[i] as number)) / ((cum[i + 1] as number) - (cum[i] as number) || 1);
      return [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1])];
    },
  };
}

/** The session's lines in receivedAt order: SessionInfo, TimingAppData stints, a count per lap and the Position lines. */
export function session(o: { outline: string; frame: Frame; sessionKey: number; t0: number; cars: readonly Car[] }) {
  const track = along(o.outline);
  const { t0 } = o;
  const values: Value[] = [
    [t0 - 60_000, 'SessionInfo', { Key: o.sessionKey, Type: 'Practice', Name: 'Practice 1' }, iso(t0 - 60_000)],
    [
      t0 - 30_000,
      'TimingAppData',
      { Lines: Object.fromEntries(o.cars.map((c) => [c.driver, { Stints: [{ Compound: 'SOFT', StartLaps: 0 }] }])) },
      iso(t0 - 30_000),
    ],
  ];
  const starts = o.cars.map((c) => {
    let sum = 0;
    return [0, ...c.laps.map((ms) => (sum += ms))];
  });
  o.cars.forEach((c, k) => {
    (starts[k] as number[]).forEach((start, i) => {
      const line = i === 0 ? { NumberOfLaps: 1, PitOut: true } : { NumberOfLaps: i + 1 };
      values.push([t0 + start + TIMING_LAG_MS, 'TimingData', { Lines: { [c.driver]: line } }, iso(t0 + start)]);
    });
  });
  // Arc length at `ms` after t0: lap i at its own pace, the last lap's pace after it.
  const distance = (k: number, ms: number) => {
    const [own, laps] = [starts[k] as number[], (o.cars[k] as Car).laps];
    const i = Math.min(
      Math.max(
        0,
        own.findLastIndex((s) => s <= ms),
      ),
      laps.length - 1,
    );
    return (track.length * (ms - (own[i] as number))) / (laps[i] as number);
  };
  const end = Math.max(...starts.map((s) => s.at(-1) as number)) + TAIL_MS;
  const [cx, cy] = toF1(o.frame, [0, 0]);
  for (let j = 0; j * ENTRY_MS <= end; j += PER_LINE) {
    const entries = Array.from({ length: PER_LINE }, (_, e) => {
      const ms = (j + e) * ENTRY_MS;
      const cars = o.cars.flatMap((c, k) => {
        if (inside(c.gaps, ms)) return [];
        const [X, Y] = k === 0 && ms === 2 * ENTRY_MS ? [0, 0] : toF1(o.frame, track.at(distance(k, ms)));
        return [[c.driver, { Status: inside(c.offTrack, ms) ? 'OffTrack' : 'OnTrack', X, Y, Z: 61 }]];
      });
      const Entries = Object.fromEntries([...cars, [241, { Status: 'OnTrack', X: cx, Y: cy, Z: 0 }]]);
      return { Timestamp: iso(t0 + ms), Entries };
    });
    const newest = t0 + (j + PER_LINE - 1) * ENTRY_MS;
    const payload = deflateRawSync(JSON.stringify({ Position: entries })).toString('base64');
    values.push([newest + POSITION_LAG_MS, 'Position.z', payload, iso(newest)]);
  }
  return values.sort((a, b) => a[0] - b[0]);
}
