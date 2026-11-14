import type { Lap, RaceControl, Stints } from '@f1/contracts';
import type { Mark } from './replay.ts';
import type { Kind, Period } from './track.ts';

// The race story (#115) from the times each car crosses the line: the running order after each lap, the places won on
// lap 1, the pit cycles of two cars and the live tower's closing trend. Pure: no React, no ECharts, so the Tower and
// the Order view in the main chunk can use it; each call builds a driver's crossings once.

export type CrossLap = Pick<Lap, 'driver_number' | 'lap_number' | 'date_start' | 'lap_ms'>;
export type PitLap = CrossLap & Pick<Lap, 'is_pit_in' | 'is_pit_out'>;

/**
 * When a driver crossed the line after each of its laps, in epoch ms: lap n+1's `date_start`, else lap n's
 * `date_start + lap_ms`, else null. `date_start` is approximate (A§6.1); on the dev DB it is null only on lap 1
 * (6 of 525 laps) and agrees with the previous start + lap time to a median of 51 ms.
 */
export function crossings(laps: readonly CrossLap[]): (number | null)[] {
  const start = new Map<number, number>();
  const time = new Map<number, number>();
  let last = 0;
  for (const l of laps) {
    last = Math.max(last, l.lap_number);
    if (l.date_start !== null) start.set(l.lap_number, Date.parse(l.date_start));
    if (l.lap_ms !== null) time.set(l.lap_number, l.lap_ms);
  }
  return Array.from({ length: last }, (_, i) => {
    const next = start.get(i + 2);
    if (next !== undefined) return next;
    const s = start.get(i + 1);
    const t = time.get(i + 1);
    return s !== undefined && t !== undefined ? s + t : null;
  });
}

/**
 * The driver's gap to the reference after each of its laps, in ms (index n − 1 for lap n): its crossing − the
 * reference's crossing at the same lap count, so a lapped driver shows a gap over one lap. Nothing is interpolated:
 * null where either crossing is unknown, which breaks the line.
 */
export function gapFromCrossings(reference: readonly CrossLap[], driver: readonly CrossLap[]): (number | null)[] {
  const ref = crossings(reference);
  return crossings(driver).map((c, i) => {
    const r = ref[i];
    return c === null || r == null ? null : c - r;
  });
}

function byDriver<L extends CrossLap>(laps: readonly L[]): Map<number, L[]> {
  const out = new Map<number, L[]>();
  for (const l of laps) {
    const own = out.get(l.driver_number);
    if (own) own.push(l);
    else out.set(l.driver_number, [l]);
  }
  return out;
}

/** Driver numbers after lap `lap`: `order` ranked, `missing` (by number) completed a lap whose crossing is unknown. */
export type OrderRow = { lap: number; order: number[]; missing: number[] };

/**
 * The order after each lap (index n − 1 for lap n, up to the last lap some driver completed): by laps completed, then
 * by the time the car crossed the line after them, so a lapped or retired car falls behind by laps, and on the newest
 * lap of a live replay a car still on it ranks behind those that crossed. A lap counts as completed once its crossing
 * is known or the next lap has a row; a car whose latest completed lap has no crossing is `missing`, never ranked
 * into a gap, and a car that never crossed the line is in neither list. Trailing rows nobody completed are dropped:
 * the lap a live replay is on (it would repeat the row before), and OpenF1's cool-down rows (dev DB, 2026-11-13: 21 of
 * 113 races have lap rows past the most laps any result lists, 50 rows, each with a `date_start` and no `lap_ms`).
 */
export function runningOrder(laps: readonly CrossLap[]): OrderRow[] {
  const drivers = [...byDriver(laps)].map(([number, own]) => {
    const rows = new Set(own.map((l) => l.lap_number));
    return { number, cross: crossings(own), rows };
  });
  const last = laps.reduce((n, l) => Math.max(n, l.lap_number), 0);
  const done = new Map<number, number>(); // completed(d, n − 1), carried from row to row
  const rows: OrderRow[] = [];
  let completed = 0; // the last lap some driver completed
  for (let n = 1; n <= last; n++) {
    const ranked: { number: number; c: number; t: number }[] = [];
    const missing: number[] = [];
    for (const d of drivers) {
      const c = d.cross[n - 1] != null || d.rows.has(n + 1) ? n : (done.get(d.number) ?? 0);
      done.set(d.number, c);
      if (c === n) completed = n;
      if (c === 0) continue;
      const t = d.cross[c - 1];
      if (t == null) missing.push(d.number);
      else ranked.push({ number: d.number, c, t });
    }
    ranked.sort((x, y) => y.c - x.c || x.t - y.t || x.number - y.number);
    rows.push({ lap: n, order: ranked.map((r) => r.number), missing: missing.sort((x, y) => x - y) });
  }
  return rows.slice(0, completed);
}

/** Places won on lap 1 (grid − position after lap 1; positive: gained). Empty when lap 1's order is incomplete. */
export function lapOneGains(row1: OrderRow | undefined, grid: ReadonlyMap<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  if (!row1 || row1.missing.length > 0) return out;
  row1.order.forEach((d, i) => {
    const g = grid.get(d);
    if (g !== undefined && Number.isInteger(g) && g >= 1) out.set(d, g - (i + 1));
  });
  return out;
}

/** Whether a stint starts after in-lap n: from n + 1, or from n itself (lap > 1; see `stops`). A pit-lane pass has none. */
export const startsStint = (starts: ReadonlySet<number>, n: number): boolean =>
  starts.has(n + 1) || (n > 1 && starts.has(n));

/**
 * The driver's stops, as in-lap numbers: an in-lap n with a new stint from lap n + 1, or from n itself (lap > 1).
 * Dev DB, 2026-11-13, OpenF1 races 2023–2026, 3,533 race in-laps: 2,998 have the stint from n + 1; 374 in 12 sessions
 * (7787, 9094, 9110, 9488, 9523, 9531, 9693, 9963, 9979, 11286, 11291, 11299) from n (OpenF1 numbers those stints from
 * the in-lap); 74 have no stint nearby (drive-throughs, pit-lane passes under SC: no stop); 87 are 1–2 laps off
 * (missed on purpose).
 * ponytail: a drive-through on the lap after a stop can count as a stop here; consume each stint once, as
 * `pitStops` (views/Stints.tsx) does, if a pit cycle ever pairs one.
 */
export function stops(driver: number, laps: readonly PitLap[], stints: Stints): number[] {
  const starts = new Set<number>();
  for (const s of stints) if (s.driver_number === driver && s.lap_start !== null) starts.add(s.lap_start);
  return laps
    .filter((l) => l.driver_number === driver && l.is_pit_in)
    .map((l) => l.lap_number)
    .filter((n) => startsStint(starts, n))
    .sort((x, y) => x - y);
}

/** ponytail: a fixed window of in-laps at most 3 apart; tunable if the owner wants another. */
export const PIT_WINDOW = 3;

export type Reason = { kind: 'period'; period: Kind } | { kind: 'crossing' } | { kind: 'penalty' };
/** Gaps in ms, first − second at the line (positive: first behind); `reason` set when the pair is not comparable. */
export type Cycle = {
  first: number;
  second: number;
  firstIn: number;
  secondIn: number;
  before: number | null;
  after: number | null;
  reason?: Reason;
};

const PENALTY = /\bPENALTY\b/;
const CAR = /(\d{1,2}) \([A-Z]{3}\)/g;

/**
 * Every stop of a paired with every stop of b at most `PIT_WINDOW` in-laps apart, by first in-lap. `before` is the
 * gap after the lap before the first in-lap, `after` the gap after the second car's out-lap. Not comparable: an SC,
 * VSC or red flag in laps firstIn − 1 … secondIn + 1 (the leader's laps, one more at the top), a missing crossing, or a penalty naming either car between those lines.
 */
export function pitCycles(
  a: number,
  b: number,
  laps: readonly PitLap[],
  stints: Stints,
  periods: readonly Period[],
  rc: RaceControl,
): Cycle[] {
  const cross = new Map([a, b].map((d) => [d, crossings(laps.filter((l) => l.driver_number === d))]));
  const at = (d: number, n: number) => (n >= 1 ? (cross.get(d)?.[n - 1] ?? null) : null);
  // The times of the penalty messages naming either car.
  const penalties = rc.flatMap((r) =>
    r.date !== null &&
    PENALTY.test(r.message ?? '') &&
    [...(r.message ?? '').matchAll(CAR)].some((m) => Number(m[1]) === a || Number(m[1]) === b)
      ? [Date.parse(r.date)]
      : [],
  );
  const stopsB = stops(b, laps, stints);
  const out: Cycle[] = [];
  for (const x of stops(a, laps, stints))
    for (const y of stopsB) {
      if (Math.abs(x - y) > PIT_WINDOW) continue;
      const [first, firstIn, second, secondIn] = x <= y ? ([a, x, b, y] as const) : ([b, y, a, x] as const);
      const f0 = at(first, firstIn - 1);
      const s0 = at(second, firstIn - 1);
      const f1 = at(first, secondIn + 1);
      const s1 = at(second, secondIn + 1);
      const before = f0 === null || s0 === null ? null : f0 - s0;
      const after = f1 === null || s1 === null ? null : f1 - s1;
      const cycle: Cycle = { first, second, firstIn, secondIn, before, after };
      // Lap firstIn − 1 holds the before line; +1 at the top because a lead-lap car's lap m ends in the leader's lap m
      // or m + 1 (periods are the leader's laps, the window the cars' own).
      const period = periods.find((p) => p.from <= secondIn + 2 && p.to >= firstIn - 1);
      if (period) cycle.reason = { kind: 'period', period: period.kind };
      else if (f0 === null || s0 === null || f1 === null || s1 === null) cycle.reason = { kind: 'crossing' };
      else {
        const lo = Math.min(f0, s0);
        const hi = Math.max(f1, s1);
        if (penalties.some((t) => t >= lo && t <= hi)) cycle.reason = { kind: 'penalty' };
      }
      out.push(cycle);
    }
  return out.sort((p, q) => p.firstIn - q.firstIn || p.secondIn - q.secondIn);
}

const PERIOD_TEXT: Record<Kind, string> = { sc: 'safety car', vsc: 'VSC', red: 'red flag' };

const side = (gap: number) => (Math.abs(gap) < 50 ? 'level' : gap > 0 ? 'behind' : 'ahead');
const rel = (gap: number) => (side(gap) === 'level' ? 'level' : `${(Math.abs(gap) / 1000).toFixed(1)} s ${side(gap)}`);

/** "VER pitted L22, NOR L24: VER 1.2 s behind before, 0.8 s ahead after (undercut)", or why it is not comparable. */
export function cycleText(c: Cycle, acronym: (n: number) => string): string {
  const f = acronym(c.first);
  const s = acronym(c.second);
  const head =
    c.firstIn === c.secondIn ? `${f} and ${s} pitted L${c.firstIn}` : `${f} pitted L${c.firstIn}, ${s} L${c.secondIn}`;
  const r = c.reason;
  if (r || c.before === null || c.after === null) {
    const why =
      r?.kind === 'period'
        ? `${PERIOD_TEXT[r.period]} in the window`
        : r?.kind === 'penalty'
          ? `a penalty names ${f} or ${s} in the window`
          : 'a line crossing is missing';
    return `${head}: not comparable (${why})`;
  }
  const was = side(c.before);
  const now = side(c.after);
  // Pitting on the same lap, a swap is pit-lane speed, not an undercut.
  const label =
    c.firstIn === c.secondIn
      ? ''
      : was === 'behind' && now === 'ahead'
        ? ' (undercut)'
        : was === 'ahead' && now === 'behind'
          ? ' (overcut)'
          : '';
  return `${head}: ${f} ${rel(c.before)} before, ${rel(c.after)} after${label}`;
}

/** The change in the interval to the car ahead (ms, negative: closing), the first lap without a crossing, or blank. */
export type Trend = { delta: number } | { missing: number } | null;

/**
 * The live tower's trend per car behind the leader (the leader has no entry): the change of its interval to the car
 * ahead in `order` over its last 1 and 3 laps (to n, its last lap completed by T: a lap without a crossing is
 * `missing`, as in runningOrder), from crossings at or before T only. Blank across an in- or out-lap of
 * either car and across an SC, VSC or red band (open bands run to T).
 */
export function closingAt(
  laps: readonly PitLap[],
  order: readonly number[],
  T: number,
  bands: readonly Mark[],
): Map<number, { one: Trend; three: Trend }> {
  const seen = byDriver(laps.filter((l) => l.date_start === null || Date.parse(l.date_start) <= T));
  const cars = new Map(
    order.map((d) => {
      const own = seen.get(d) ?? [];
      const cross = crossings(own).map((c) => (c !== null && c <= T ? c : null));
      const pits = new Set(own.filter((l) => l.is_pit_in || l.is_pit_out).map((l) => l.lap_number));
      // The last lap completed by T, by runningOrder's rule: its crossing is known, or the next lap has a row by T.
      const rows = new Set(own.map((l) => l.lap_number));
      let n = cross.length;
      while (n > 0 && cross[n - 1] == null && !rows.has(n + 1)) n--;
      return [d, { cross, pits, n }];
    }),
  );
  const out = new Map<number, { one: Trend; three: Trend }>();
  order.forEach((d, i) => {
    const ahead = i > 0 ? cars.get(order[i - 1] as number) : undefined;
    const me = cars.get(d);
    if (!ahead || !me) return;
    const n = me.n;
    const trend = (k: number): Trend => {
      if (n - k < 1) return null;
      const mTo = me.cross[n - 1];
      const aTo = ahead.cross[n - 1];
      if (mTo == null || aTo == null) return { missing: n };
      const mFrom = me.cross[n - k - 1];
      const aFrom = ahead.cross[n - k - 1];
      if (mFrom == null || aFrom == null) return { missing: n - k };
      for (let m = n - k + 1; m <= n; m++) if (me.pits.has(m) || ahead.pits.has(m)) return null;
      const lo = Math.min(mFrom, aFrom);
      const hi = Math.max(mTo, aTo);
      if (bands.some((b) => b.kind !== 'start' && b.kind !== 'chequered' && b.t <= hi && (b.end ?? T) >= lo))
        return null;
      return { delta: mTo - aTo - (mFrom - aFrom) };
    };
    out.set(d, { one: trend(1), three: trend(3) });
  });
  return out;
}
