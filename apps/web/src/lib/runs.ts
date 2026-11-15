import type { Lap, Stints, Weather } from '@f1/contracts';
import { type Compound, compoundOf } from './compound.ts';
import type { Driver } from './session.ts';
import { fmtHm } from './time.ts';
import { type ClockPeriod, kindsAt, type Period } from './track.ts';
import { trackAt } from './weather.ts';

// Pace per run (#114, A§13): a race run is a stint, a practice run the laps from an out-lap to an in-lap. Laps that
// say little about pace are left out, each with its first reason; a null `lap_ms` stays null, never estimated from
// the sectors. The median and the best are statistics of real laps, never a fit.

export type Reason = 'lap1' | 'pit' | 'deleted' | 'period' | 'untimed' | 'slow';

/** In the order the rules apply. */
export const REASONS: readonly Reason[] = ['lap1', 'pit', 'deleted', 'period', 'untimed', 'slow'];

export const REASON_WORDS: Record<Reason, string> = {
  lap1: 'lap 1',
  pit: 'in- or out-lap',
  deleted: 'deleted',
  period: 'under SC, VSC or red flag',
  untimed: 'no time',
  slow: "over 107 % of the run's median (a cool-down or traffic)",
};

/**
 * `laps`: every lap of the run in order; `counted` and `left` (by reason) split them exactly. `median` and `best`
 * (ms) are null below 3 counted laps. `compound` is the feed's name, `age` the tyre's laps at the first lap (null when
 * unknown; may be wrong for a used set). `start` and `end` are epoch ms, null when no lap has a date.
 */
export type Run = {
  driver: number;
  n: number;
  laps: Lap[];
  counted: Lap[];
  left: Record<Reason, Lap[]>;
  median: number | null;
  best: number | null;
  compound: string | null;
  age: number | null;
  start: number | null;
  end: number | null;
};

/** The middle value, or the mean of the two middle ones rounded to the ms (D6). */
const median = (values: number[]): number | null => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  const [lo, hi] = [v[mid - 1], v[mid]];
  return hi === undefined ? null : v.length % 2 === 1 || lo === undefined ? hi : Math.round((lo + hi) / 2);
};

const parse = (l: Lap) => (l.date_start === null ? null : Date.parse(l.date_start));

/** The run's first known start (else first known end) and last known end (else last known start). */
function span(laps: readonly Lap[]): [number | null, number | null] {
  const starts = laps.map(parse);
  const ends = laps.map((l, i) => {
    const next = starts[i + 1] ?? null;
    const own = starts[i] ?? null;
    return next ?? (own !== null && l.lap_ms !== null ? own + l.lap_ms : null);
  });
  const known = (v: (number | null)[]) => v.filter((t): t is number => t !== null);
  const [s, e] = [known(starts), known(ends)];
  return [s[0] ?? e[0] ?? null, e.at(-1) ?? s.at(-1) ?? null];
}

type Context = { type: string | null; periods: readonly Period[]; clock: readonly ClockPeriod[] };

function reasonOf(l: Lap, { type, periods, clock }: Context): Reason | null {
  if (type === 'Race' && l.lap_number === 1) return 'lap1';
  if (l.is_pit_in || l.is_pit_out) return 'pit';
  if (l.deleted) return 'deleted';
  if (type === 'Race') {
    if (kindsAt(periods, l.lap_number).length > 0) return 'period';
  } else if (l.date_start !== null) {
    const [from, to] = [Date.parse(l.date_start), Date.parse(l.date_start) + (l.lap_ms ?? 0)];
    if (clock.some((p) => from < p.to && to > p.from)) return 'period';
  }
  return l.lap_ms === null ? 'untimed' : null;
}

function build(driver: number, n: number, laps: Lap[], compound: string | null, age: number | null, ctx: Context): Run {
  const left: Record<Reason, Lap[]> = { lap1: [], pit: [], deleted: [], period: [], untimed: [], slow: [] };
  const kept: Lap[] = [];
  for (const l of laps) {
    const r = reasonOf(l, ctx);
    if (r === null) kept.push(l);
    else left[r].push(l);
  }
  // `kept` has a time: `untimed` caught the others.
  const mid = median(kept.map((l) => l.lap_ms ?? 0));
  const counted: Lap[] = [];
  for (const l of kept) {
    if (mid !== null && (l.lap_ms ?? 0) * 100 > mid * 107) left.slow.push(l);
    else counted.push(l);
  }
  const times = counted.map((l) => l.lap_ms ?? 0);
  const [start, end] = span(laps);
  return {
    driver,
    n,
    laps,
    counted,
    left,
    median: counted.length < 3 ? null : median(times),
    best: counted.length < 3 ? null : Math.min(...times),
    compound,
    age,
    start,
    end,
  };
}

/**
 * Race type: one run per stint with both lap bounds. Practice: per driver, from an out-lap (or the first row) to an
 * in-lap (or the last row), or to where the covering stint changes. Qualifying and the rest: none. `periods` are the race's lap periods, `clock` the
 * practice's clock periods.
 */
export function paceRuns(
  laps: readonly Lap[],
  stints: Stints,
  type: string | null,
  { periods = [], clock = [] }: { periods?: readonly Period[]; clock?: readonly ClockPeriod[] } = {},
): Run[] {
  const ctx = { type, periods, clock };
  const byNumber = (a: Lap, b: Lap) => a.lap_number - b.lap_number;
  const byDriver = new Map<number, Lap[]>();
  for (const l of laps) {
    const own = byDriver.get(l.driver_number);
    if (own) own.push(l);
    else byDriver.set(l.driver_number, [l]);
  }
  const runs: Run[] = [];
  if (type === 'Race') {
    const sorted = [...stints].sort((a, b) => a.driver_number - b.driver_number || a.stint_number - b.stint_number);
    for (const s of sorted) {
      const { lap_start: lo, lap_end: hi } = s;
      if (lo === null || hi === null) continue;
      const own = (byDriver.get(s.driver_number) ?? []).filter((l) => lo <= l.lap_number && l.lap_number <= hi);
      if (own.length > 0)
        runs.push(build(s.driver_number, s.stint_number, own.sort(byNumber), s.compound, s.tyre_age_at_start, ctx));
    }
  } else if (type === 'Practice') {
    for (const [driver, rows] of byDriver) {
      rows.sort(byNumber);
      const cover = (l: Lap) =>
        stints.find(
          (s) =>
            s.driver_number === driver &&
            s.lap_start !== null &&
            s.lap_end !== null &&
            s.lap_start <= l.lap_number &&
            l.lap_number <= s.lap_end,
        );
      // A new run at an out-lap, after an in-lap, or when the covering stint changes (a missing out-lap row loses
      // the in-lap mark too: 61 of 232 practice sessions on the dev DB have such a hole).
      const groups: Lap[][] = [];
      let before: Stints[number] | undefined;
      for (const l of rows) {
        const cur = groups.at(-1);
        const now = cover(l);
        if (cur === undefined || l.is_pit_out || cur.at(-1)?.is_pit_in || (now && before && now !== before))
          groups.push([l]);
        else cur.push(l);
        before = now;
      }
      groups.forEach((g, i) => {
        const first = g[0];
        if (first === undefined) return;
        const stint = cover(first);
        const age =
          stint?.tyre_age_at_start == null || stint.lap_start === null
            ? null
            : stint.tyre_age_at_start + (first.lap_number - stint.lap_start);
        runs.push(build(driver, i + 1, g, stint ? stint.compound : first.compound, age, ctx));
      });
    }
  }
  return runs;
}

/** A drawn run: `x` and `w` are fractions of the plan's span. */
export type Segment = {
  run: Run;
  x: number;
  w: number;
  compound: Compound | null;
  laps: number;
  counted: number;
  start: number;
  end: number;
  /** The track temperature at the run's start, null when unknown. */
  track: number | null;
};
/** `undrawn`: the driver's runs without a start or an end, listed with a count and never drawn. */
export type Lane = { driver: Driver; segments: Segment[]; undrawn: Run[] };
export type Tick = { t: number; x: number; label: string };
export type RedBand = { from: number; to: number; x: number; w: number };
export type RunPlan = { lanes: Lane[]; ticks: Tick[]; red: RedBand[] };

/**
 * The practice run plan over [from, to] (epoch ms): a lane per driver that has runs, in the given order; ticks every
 * 15 min up to a 2 h span, else hourly (UTC quarter-hours are whole in Amsterdam time too); the red bands.
 */
export function runPlan(
  drivers: readonly Driver[],
  runs: readonly Run[],
  from: number,
  to: number,
  red: readonly ClockPeriod[],
  weather: Weather,
  year: number | null = null,
): RunPlan {
  const size = Math.max(1, to - from);
  const x = (t: number) => (t - from) / size;
  const lanes: Lane[] = [];
  for (const driver of drivers) {
    const own = runs.filter((r) => r.driver === driver.number);
    if (own.length === 0) continue;
    const lane: Lane = { driver, segments: [], undrawn: [] };
    for (const run of own) {
      if (run.start === null || run.end === null) {
        lane.undrawn.push(run);
        continue;
      }
      lane.segments.push({
        run,
        x: x(run.start),
        w: (run.end - run.start) / size,
        compound: compoundOf(run.compound, year),
        laps: run.laps.length,
        counted: run.counted.length,
        start: run.start,
        end: run.end,
        track: trackAt(weather, run.start),
      });
    }
    lanes.push(lane);
  }
  const step = to - from <= 2 * 3_600_000 ? 900_000 : 3_600_000;
  const ticks: Tick[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push({ t, x: x(t), label: fmtHm(t) });
  return {
    lanes,
    ticks,
    red: red
      .filter((p) => p.kind === 'red' && p.to > from && p.from < to)
      .map((p) => {
        const [a, b] = [Math.max(p.from, from), Math.min(p.to, to)];
        return { from: a, to: b, x: x(a), w: (b - a) / size };
      }),
  };
}
