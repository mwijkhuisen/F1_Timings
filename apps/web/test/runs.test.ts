import type { Lap, Stints } from '@f1/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paceRuns, REASON_WORDS, REASONS, runPlan } from '../src/lib/runs.ts';
import type { Driver } from '../src/lib/session.ts';
import type { ClockPeriod, Period } from '../src/lib/track.ts';
import { lap } from './laps.ts';

// lib/runs.ts (#114): the pace runs and the practice run plan, on synthetic laps only.

const T0 = Date.parse('2026-10-24T12:00:00Z'); // 14:00 in Amsterdam (CEST)
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** A lap `s` seconds after T0. */
const at = (s: number) => iso(T0 + s * 1000);
const stint = (driver: number, n: number, lo: number | null, hi: number | null, extra = {}): Stints[number] => ({
  driver_number: driver,
  stint_number: n,
  lap_start: lo,
  lap_end: hi,
  compound: 'MEDIUM',
  tyre_age_at_start: 0,
  ...extra,
});
/** Race laps `from`..`to` of a driver, 90 s each unless `ms` says otherwise. */
const lapsOf = (driver: number, from: number, to: number, ms: (n: number) => number | null = () => 90_000): Lap[] =>
  Array.from({ length: to - from + 1 }, (_, i) => lap(driver, from + i, { lap_ms: ms(from + i) }));
const counted = (laps: Lap[], stints: Stints, type: string, ctx = {}) =>
  paceRuns(laps, stints, type, ctx).map((r) => r.counted.map((l) => l.lap_number));

describe('paceRuns, race', () => {
  it('makes a run of each stint with both bounds, and none for a stint without', () => {
    const laps = lapsOf(1, 1, 20);
    const runs = paceRuns(laps, [stint(1, 2, 11, 20), stint(1, 1, 1, 10), stint(1, 3, null, null)], 'Race');
    expect(runs.map((r) => [r.n, r.laps.length])).toEqual([
      [1, 10],
      [2, 10],
    ]);
    expect(paceRuns(laps, [stint(1, 1, 1, null), stint(1, 2, null, 20)], 'Race')).toEqual([]);
  });

  it('takes the stint’s compound and age, and leaves other drivers’ laps out', () => {
    const [run] = paceRuns(
      [...lapsOf(1, 1, 5), ...lapsOf(2, 1, 5)],
      [stint(1, 1, 1, 5, { tyre_age_at_start: 3 })],
      'Race',
    );
    expect(run).toMatchObject({ driver: 1, compound: 'MEDIUM', age: 3 });
    expect(run?.laps.every((l) => l.driver_number === 1)).toBe(true);
  });

  it('gives qualifying and other types no runs', () => {
    expect(paceRuns(lapsOf(1, 1, 5), [stint(1, 1, 1, 5)], 'Qualifying')).toEqual([]);
    expect(paceRuns(lapsOf(1, 1, 5), [stint(1, 1, 1, 5)], null)).toEqual([]);
  });

  it('leaves out each lap with its first reason', () => {
    const laps = [
      lap(1, 1, { lap_ms: 100_000 }), // lap 1
      lap(1, 2, { lap_ms: 90_000, is_pit_out: true, deleted: true }), // pit before deleted
      lap(1, 3, { lap_ms: 90_000, is_pit_in: true }), // pit
      lap(1, 4, { lap_ms: 90_000, deleted: true }), // deleted
      lap(1, 5, { lap_ms: 90_000 }), // under a period
      lap(1, 6, { lap_ms: null }), // untimed
      ...lapsOf(1, 7, 12), // counted
      lap(1, 13, { lap_ms: 110_000 }), // slow
    ];
    const periods: Period[] = [{ kind: 'sc', from: 5, to: 5 }];
    const [run] = paceRuns(laps, [stint(1, 1, 1, 13)], 'Race', { periods });
    expect(run?.left).toEqual({
      lap1: [laps[0]],
      pit: [laps[1], laps[2]],
      deleted: [laps[3]],
      period: [laps[4]],
      untimed: [laps[5]],
      slow: [laps[12]],
    });
    expect(run?.counted).toEqual(laps.slice(6, 12));
    expect(REASONS.map((r) => REASON_WORDS[r])).toEqual([
      'lap 1',
      'in- or out-lap',
      'deleted',
      'under SC, VSC or red flag',
      'no time',
      "over 107 % of the run's median (a cool-down or traffic)",
    ]);
  });

  it('applies "period" before "untimed": an untimed lap under the SC is a period lap', () => {
    const laps = [lap(1, 2, { lap_ms: null }), lap(1, 3, { lap_ms: null })];
    const [run] = paceRuns(laps, [stint(1, 1, 1, 5)], 'Race', { periods: [{ kind: 'sc', from: 2, to: 2 }] });
    expect(run?.left.period).toEqual([laps[0]]);
    expect(run?.left.untimed).toEqual([laps[1]]);
  });

  it('leaves lap 1 out in a race', () => {
    expect(counted(lapsOf(1, 1, 4), [stint(1, 1, 1, 4)], 'Race')).toEqual([[2, 3, 4]]);
  });

  it('cuts at 107 % of the median: exactly 107 % is counted, one ms above is cut', () => {
    // Median of 100 s × 5 = 100 s; the cut is 107 s.
    const at107 = [...lapsOf(1, 2, 6, () => 100_000), lap(1, 7, { lap_ms: 107_000 }), lap(1, 8, { lap_ms: 107_001 })];
    const [run] = paceRuns(at107, [stint(1, 1, 2, 8)], 'Race');
    expect(run?.counted.map((l) => l.lap_number)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(run?.left.slow.map((l) => l.lap_number)).toEqual([8]);
    expect(run).toMatchObject({ median: 100_000, best: 100_000 });
  });

  it('reports the median and best of the counted laps, after the cut', () => {
    const times = [100_000, 102_000, 101_000, 99_000, 150_000];
    const laps = times.map((ms, i) => lap(1, i + 2, { lap_ms: ms }));
    const [run] = paceRuns(laps, [stint(1, 1, 2, 6)], 'Race');
    expect(run?.left.slow).toHaveLength(1);
    expect(run?.median).toBe(100_500); // even: the mean of 100 000 and 101 000
    expect(run?.best).toBe(99_000);
  });

  it('rounds an even median to the ms and takes the middle of an odd count', () => {
    const run = (times: number[]) =>
      paceRuns(
        times.map((ms, i) => lap(1, i + 2, { lap_ms: ms })),
        [stint(1, 1, 2, times.length + 1)],
        'Race',
      )[0];
    expect(run([100_000, 100_001, 100_003, 100_004])?.median).toBe(100_002); // (100 001 + 100 003) / 2
    expect(run([100_000, 100_001, 100_002, 100_004])?.median).toBe(100_002); // 100 001.5 rounds up
    expect(run([100_005, 100_000, 100_001])?.median).toBe(100_001);
  });

  it('has no median or best below 3 counted laps', () => {
    const [two] = paceRuns(lapsOf(1, 2, 3), [stint(1, 1, 2, 3)], 'Race');
    expect(two).toMatchObject({ median: null, best: null });
    expect(two?.counted).toHaveLength(2);
    const [none] = paceRuns([lap(1, 2)], [stint(1, 1, 2, 2)], 'Race');
    expect(none).toMatchObject({ median: null, best: null });
    const [three] = paceRuns(lapsOf(1, 2, 4), [stint(1, 1, 2, 4)], 'Race');
    expect(three?.median).toBe(90_000);
  });

  it('keeps a null lap time null, never estimating it from the sectors', () => {
    const laps = [
      lap(1, 2, { lap_ms: 90_000 }),
      lap(1, 3, { lap_ms: null, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000 }),
    ];
    const [run] = paceRuns(laps, [stint(1, 1, 2, 3)], 'Race');
    expect(run?.left.untimed).toEqual([laps[1]]);
    expect(run?.counted).toEqual([laps[0]]);
    expect(run?.laps[1]?.lap_ms).toBeNull();
  });

  it('puts laps under a safety car, VSC or red flag by lap number', () => {
    const periods: Period[] = [
      { kind: 'vsc', from: 4, to: 5 },
      { kind: 'red', from: 9, to: 9 },
    ];
    expect(counted(lapsOf(1, 2, 10), [stint(1, 1, 2, 10)], 'Race', { periods })).toEqual([[2, 3, 6, 7, 8, 10]]);
  });
});

describe('paceRuns, practice', () => {
  /** Out-lap, three flying laps and an in-lap, 100 s each, from `first` at `s` seconds after T0. */
  const run = (driver: number, first: number, s: number, flying = 3): Lap[] => {
    const rows: Lap[] = [lap(driver, first, { is_pit_out: true, date_start: at(s), lap_ms: 120_000 })];
    for (let i = 1; i <= flying; i++)
      rows.push(lap(driver, first + i, { date_start: at(s + 120 + (i - 1) * 100), lap_ms: 100_000 }));
    rows.push(
      lap(driver, first + flying + 1, { is_pit_in: true, date_start: at(s + 120 + flying * 100), lap_ms: 130_000 }),
    );
    return rows;
  };

  it('splits runs at out-laps and in-laps, starting at the first row', () => {
    // The first run starts at the driver's first row (lap 1, no out-lap), and the last has no in-lap.
    const laps = [
      lap(1, 1, { date_start: at(0), lap_ms: 100_000 }),
      lap(1, 2, { date_start: at(100), lap_ms: 100_000, is_pit_in: true }),
      ...run(1, 3, 600),
      lap(1, 8, { is_pit_out: true, date_start: at(1500) }),
      lap(1, 9, { date_start: at(1600), lap_ms: 100_000 }),
      lap(1, 10, { date_start: at(1700), lap_ms: 100_000 }),
    ];
    const runs = paceRuns(laps, [], 'Practice');
    expect(runs.map((r) => [r.n, r.laps.map((l) => l.lap_number)])).toEqual([
      [1, [1, 2]],
      [2, [3, 4, 5, 6, 7]],
      [3, [8, 9, 10]],
    ]);
  });

  it('splits where the covering stint changes, when a missing out-lap row lost the in-lap mark', () => {
    // Laps 1–5 are a run (the in-lap 5 is not flagged: the out-lap 6 row is missing), laps 7–10 are on stint 2.
    const laps = [
      ...run(1, 1, 0).map((l) => (l.lap_number === 5 ? { ...l, is_pit_in: false } : l)),
      ...[7, 8, 9, 10].map((n) => lap(1, n, { date_start: at(900 + n * 100), lap_ms: 100_000 })),
    ];
    const two: Stints = [
      stint(1, 1, 1, 6, { compound: 'SOFT', tyre_age_at_start: 0 }),
      stint(1, 2, 7, 10, { compound: 'HARD', tyre_age_at_start: 2 }),
    ];
    const runs = paceRuns(laps, two, 'Practice');
    expect(runs.map((r) => [r.laps.map((l) => l.lap_number), r.compound, r.age])).toEqual([
      [[1, 2, 3, 4, 5], 'SOFT', 0],
      [[7, 8, 9, 10], 'HARD', 2],
    ]);
    // A lap that no stint covers never splits: a hole in the stints leaves the run whole.
    expect(paceRuns(laps, [stint(1, 1, 1, 6)], 'Practice')).toHaveLength(1);
    expect(paceRuns(laps, [stint(1, 1, 1, 5), stint(1, 2, 8, 10)], 'Practice')).toHaveLength(1);
  });

  it('starts a run at an out-lap that follows an in-lap, and runs per driver', () => {
    const runs = paceRuns([...run(44, 2, 0), ...run(1, 2, 0), ...run(44, 7, 900)], [], 'Practice');
    expect(runs.map((r) => [r.driver, r.n])).toEqual([
      [44, 1],
      [44, 2],
      [1, 1],
    ]);
  });

  it('leaves the out-lap and in-lap out and has no lap 1 reason', () => {
    const [r] = paceRuns(run(1, 1, 0), [], 'Practice');
    expect(r?.left.pit.map((l) => l.lap_number)).toEqual([1, 5]);
    expect(r?.left.lap1).toEqual([]);
    expect(r?.counted.map((l) => l.lap_number)).toEqual([2, 3, 4]);
    expect(r).toMatchObject({ median: 100_000, best: 100_000 });
  });

  it('adds the laps since the stint start to its tyre age', () => {
    const laps = [...run(1, 3, 0)];
    const [r] = paceRuns(laps, [stint(1, 1, 1, 8, { tyre_age_at_start: 4, compound: 'HARD' })], 'Practice');
    expect(r).toMatchObject({ compound: 'HARD', age: 4 + (3 - 1) });
  });

  it('falls back to the lap’s compound with no age when no stint covers the first lap', () => {
    const laps = run(1, 3, 0).map((l) => ({ ...l, compound: 'SOFT' }));
    for (const stints of [[], [stint(1, 1, 9, 12)], [stint(2, 1, 1, 8)], [stint(1, 1, 1, null)]]) {
      expect(paceRuns(laps, stints, 'Practice')[0]).toMatchObject({ compound: 'SOFT', age: null });
    }
    expect(paceRuns(laps, [stint(1, 1, 1, 8, { tyre_age_at_start: null })], 'Practice')[0]?.age).toBeNull();
  });

  it('puts a lap under a clock period by time overlap, never one without a date_start', () => {
    const clock: ClockPeriod[] = [{ kind: 'red', from: T0 + 220_000, to: T0 + 320_000 }];
    // Flying laps: 120–220 s (touches only), 220–320 s (inside), 320–420 s (touches only).
    const [r] = paceRuns(run(1, 1, 0), [], 'Practice', { clock });
    expect(r?.left.period.map((l) => l.lap_number)).toEqual([3]);
    const noDate = run(1, 1, 0).map((l) => (l.lap_number === 3 ? { ...l, date_start: null } : l));
    const [r2] = paceRuns(noDate, [], 'Practice', { clock });
    expect(r2?.left.period).toEqual([]);
    expect(r2?.counted.map((l) => l.lap_number)).toEqual([2, 3, 4]);
    // The race's lap periods mean nothing in practice, and the clock nothing in a race.
    expect(
      paceRuns(run(1, 1, 0), [], 'Practice', { periods: [{ kind: 'sc', from: 1, to: 9 }] })[0]?.left.period,
    ).toEqual([]);
  });

  it('ends a lap at the next row’s start: a garage lap 1 without a time ends at lap 2’s start', () => {
    const laps = [
      lap(1, 1, { is_pit_out: true }), // no date_start, no lap_ms
      lap(1, 2, { date_start: at(60), lap_ms: 100_000 }),
      lap(1, 3, { date_start: at(160), lap_ms: 100_000 }),
      lap(1, 4, { date_start: at(260), lap_ms: 90_000, is_pit_in: true }),
    ];
    const [r] = paceRuns(laps, [], 'Practice');
    expect(r?.start).toBe(T0 + 60_000); // the first known start
    expect(r?.end).toBe(T0 + 350_000); // the in-lap: date_start + lap_ms
    const [garage] = paceRuns([laps[0] as Lap, laps[1] as Lap], [], 'Practice');
    expect(garage?.start).toBe(T0 + 60_000);
    expect(garage?.end).toBe(T0 + 160_000);
  });

  it('takes the first known end when no lap has a start, and null when nothing is dated', () => {
    expect(paceRuns([lap(1, 1, { lap_ms: 100_000 })], [], 'Practice')[0]).toMatchObject({ start: null, end: null });
    const [r] = paceRuns([lap(1, 1), lap(1, 2, { date_start: at(60) })], [], 'Practice');
    expect(r).toMatchObject({ start: T0 + 60_000, end: T0 + 60_000 }); // lap 1 ends at lap 2's start
  });
});

describe('paceRuns, property', () => {
  const anyLap = fc.record({
    ms: fc.option(fc.integer({ min: 60_000, max: 200_000 }), { nil: null }),
    start: fc.option(fc.integer({ min: 0, max: 7200 }), { nil: null }),
    in: fc.boolean(),
    out: fc.option(fc.boolean(), { nil: null }),
    deleted: fc.boolean(),
  });
  const ctx = fc.record({
    type: fc.constantFrom('Race', 'Practice', 'Qualifying'),
    from: fc.integer({ min: 0, max: 7200 }),
    len: fc.integer({ min: 0, max: 600 }),
    first: fc.integer({ min: 1, max: 30 }),
  });

  it('splits every run’s laps exactly into counted and left out', () => {
    fc.assert(
      fc.property(fc.array(anyLap, { maxLength: 30 }), ctx, (specs, { type, from, len, first }) => {
        const laps = specs.map((s, i) =>
          lap(1 + (i % 2), 1 + (i >> 1), {
            lap_ms: s.ms,
            date_start: s.start === null ? null : at(s.start),
            is_pit_in: s.in,
            is_pit_out: s.out,
            deleted: s.deleted,
          }),
        );
        const clock = [{ kind: 'red' as const, from: T0 + from * 1000, to: T0 + (from + len) * 1000 }];
        const periods = [{ kind: 'sc' as const, from: first, to: first + 3 }];
        const stints = [stint(1, 1, first, first + 10), stint(2, 1, 1, 30)];
        for (const run of paceRuns(laps, stints, type, { periods, clock })) {
          const left = REASONS.flatMap((r) => run.left[r]);
          expect(run.counted.length + left.length).toBe(run.laps.length);
          for (const l of run.laps) {
            expect(run.counted.filter((c) => c === l).length + left.filter((c) => c === l).length).toBe(1);
          }
          expect(run.median === null).toBe(run.counted.length < 3);
          expect(run.best === null).toBe(run.counted.length < 3);
        }
      }),
    );
  });
});

describe('paceRuns, practice property', () => {
  it('partitions each driver’s laps: every lap in exactly one run, none repeated', () => {
    const anyLap = fc.record({
      in: fc.boolean(),
      out: fc.option(fc.boolean(), { nil: null }),
      driver: fc.constantFrom(1, 2, 3),
    });
    const anyStints = fc.array(
      fc.record({
        driver: fc.constantFrom(1, 2, 3),
        lo: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
        len: fc.integer({ min: 0, max: 10 }),
      }),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(fc.array(anyLap, { maxLength: 40 }), anyStints, (specs, ss) => {
        const next = new Map<number, number>();
        const laps = specs.map((x) => {
          const n = (next.get(x.driver) ?? 0) + 1;
          next.set(x.driver, n);
          return lap(x.driver, n, { lap_ms: 90_000, is_pit_in: x.in, is_pit_out: x.out });
        });
        const st = ss.map((x, i) => stint(x.driver, i + 1, x.lo, x.lo === null ? null : x.lo + x.len));
        const got = paceRuns([...laps].reverse(), st, 'Practice').flatMap((r) => r.laps);
        expect(got).toHaveLength(laps.length);
        for (const l of laps) expect(got.filter((g) => g === l)).toHaveLength(1);
      }),
    );
  });
});

describe('runPlan', () => {
  const drivers: Driver[] = [
    { number: 4, acronym: 'NOR', name: null, team: null },
    { number: 1, acronym: 'VER', name: null, team: null },
    { number: 63, acronym: 'RUS', name: null, team: null },
  ];
  const flying = (driver: number, first: number, s: number, compound: string | null): Lap[] => [
    lap(driver, first, { is_pit_out: true, date_start: at(s), lap_ms: 120_000, compound }),
    lap(driver, first + 1, { date_start: at(s + 120), lap_ms: 100_000, compound }),
    lap(driver, first + 2, { date_start: at(s + 220), lap_ms: 100_000, compound }),
    lap(driver, first + 3, { date_start: at(s + 320), lap_ms: 100_000, compound }),
    lap(driver, first + 4, { date_start: at(s + 420), lap_ms: 130_000, compound, is_pit_in: true }),
  ];
  const from = T0;
  const to = T0 + 2 * 3_600_000;
  const weather = [
    {
      date: at(0),
      air_temperature: 25,
      track_temperature: 40,
      humidity: null,
      pressure: null,
      rainfall: null,
      wind_direction: null,
      wind_speed: null,
    },
    {
      date: at(1800),
      air_temperature: 25,
      track_temperature: 44,
      humidity: null,
      pressure: null,
      rainfall: null,
      wind_direction: null,
      wind_speed: null,
    },
  ];

  it('lists lanes in the given driver order, with fractions of the span', () => {
    const laps = [...flying(1, 2, 1800, 'SOFT'), ...flying(4, 2, 0, 'MEDIUM'), ...flying(4, 7, 3600, null)];
    const runs = paceRuns(laps, [], 'Practice');
    const plan = runPlan(drivers, runs, from, to, [], weather, 2026);
    expect(plan.lanes.map((l) => [l.driver.acronym, l.segments.length])).toEqual([
      ['NOR', 2],
      ['VER', 1],
    ]); // RUS has no runs: no lane
    const [nor, ver] = plan.lanes;
    const first = nor?.segments[0];
    expect(first).toMatchObject({ x: 0, laps: 5, counted: 3, start: T0, end: T0 + 550_000 });
    expect(first?.w).toBeCloseTo(550 / 7200);
    expect(first?.compound?.letter).toBe('M');
    expect(first?.track).toBe(40);
    expect(nor?.segments[1]?.compound).toBeNull();
    expect(nor?.segments[1]?.x).toBeCloseTo(3600 / 7200);
    expect(ver?.segments[0]?.compound?.letter).toBe('S');
    expect(ver?.segments[0]?.track).toBe(44); // the sample at 1800 s, exactly at the start
  });

  it('lists a run without a start or an end under its lane and does not draw it', () => {
    const laps = [...flying(4, 2, 0, 'SOFT'), lap(4, 7, { is_pit_out: true }), lap(4, 8, { lap_ms: 100_000 })];
    const runs = paceRuns(laps, [], 'Practice');
    expect(runs).toHaveLength(2);
    const [lane] = runPlan(drivers, runs, from, to, [], weather).lanes;
    expect(lane?.segments).toHaveLength(1);
    expect(lane?.undrawn).toEqual([runs[1]]);
  });

  it('draws a garage lap 1 without a time from lap 2’s start', () => {
    const laps = [lap(4, 1, { is_pit_out: true }), lap(4, 2, { date_start: at(600), lap_ms: 100_000 })];
    const [lane] = runPlan(drivers, paceRuns(laps, [], 'Practice'), from, to, [], []).lanes;
    expect(lane?.segments[0]).toMatchObject({ start: T0 + 600_000, end: T0 + 700_000, track: null });
  });

  it('ticks every 15 minutes up to a 2 h span, else hourly, labelled in Amsterdam time', () => {
    const quarter = runPlan(drivers, [], T0 + 5 * MIN, T0 + 50 * MIN, [], []);
    expect(quarter.ticks.map((t) => t.label)).toEqual(['14:15', '14:30', '14:45']);
    expect(quarter.ticks[0]?.x).toBeCloseTo(10 / 45);
    expect(runPlan(drivers, [], from, to, [], []).ticks.map((t) => t.label)).toHaveLength(9); // 14:00 … 16:00
    const hourly = runPlan(drivers, [], from, to + 1, [], []);
    expect(hourly.ticks.map((t) => t.label)).toEqual(['14:00', '15:00', '16:00']);
  });

  it('keeps at most 49 ticks when a malformed date_start stretches the span to years', () => {
    const { ticks } = runPlan(drivers, [], Date.parse('0001-01-01T00:00:00Z'), to, [], []);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(49);
  });

  it('clamps a red band to the span and drops one entirely outside', () => {
    const red: ClockPeriod[] = [
      { kind: 'red', from: from - 600_000, to: from + 450_000 },
      { kind: 'red', from: to - 450_000, to: to + 600_000 },
      { kind: 'red', from: from - 900_000, to: from - 600_000 },
      { kind: 'red', from: to + 600_000, to: to + 900_000 },
    ];
    const { red: bands } = runPlan(drivers, [], from, to, red, []);
    expect(bands.map((b) => [b.from, b.to])).toEqual([
      [from, from + 450_000],
      [to - 450_000, to],
    ]);
    for (const b of bands) expect(b.x >= 0 && b.x + b.w <= 1 + 1e-9 && b.w >= 0).toBe(true);
  });

  it('gives the red bands’ x and w, and only red ones', () => {
    const red: ClockPeriod[] = [
      { kind: 'red', from: T0 + 1800_000, to: T0 + 2700_000 },
      { kind: 'vsc', from: T0, to: T0 + 60_000 },
    ];
    const plan = runPlan(drivers, [], from, to, red, []);
    expect(plan.red).toHaveLength(1);
    expect(plan.red[0]?.x).toBeCloseTo(0.25);
    expect(plan.red[0]?.w).toBeCloseTo(0.125);
  });
});
