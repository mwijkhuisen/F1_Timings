import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bestOf,
  colouredBests,
  deltaStep,
  isValid,
  ownBests,
  ownTop,
  type Speed,
  sessionBests,
  speedTable,
  speedTops,
} from '../src/lib/bests.ts';
import { fmtDelta } from '../src/lib/time.ts';
import { lap } from './laps.ts';

// A§9's valid laps and tie order, on synthetic laps only.

const t = (s: string) => `2026-10-25T20:${s}+00:00`;

describe('sessionBests', () => {
  // Best S1 on 1/L2, best S2 on 44/L3, best S3 on 1/L4: three different laps.
  const clean = [
    lap(1, 2, { lap_ms: 90_000, s1_ms: 28_000, s2_ms: 31_000, s3_ms: 31_000, st_kph: 310 }),
    lap(44, 3, { lap_ms: 89_500, s1_ms: 28_500, s2_ms: 30_000, s3_ms: 31_000, st_kph: 318 }),
    lap(1, 4, { lap_ms: 89_800, s1_ms: 28_800, s2_ms: 31_000, s3_ms: 30_000, st_kph: 305, is_pit_out: null }),
  ];
  // Faster on every field, but none of them valid.
  const invalid = [
    lap(16, 5, { lap_ms: 80_000, s1_ms: 25_000, s2_ms: 25_000, s3_ms: 25_000, st_kph: 340, deleted: true }),
    lap(16, 6, { lap_ms: 80_000, s1_ms: 25_000, s2_ms: 25_000, s3_ms: 25_000, st_kph: 340, is_pit_in: true }),
    lap(16, 7, { lap_ms: 80_000, s1_ms: 25_000, s2_ms: 25_000, s3_ms: 25_000, st_kph: 340, is_pit_out: true }),
  ];

  it('sums the best sectors from three different laps', () => {
    const b = sessionBests(clean);
    expect([b.s1, b.s2, b.s3, b.lap]).toEqual([clean[0], clean[1], clean[2], clean[1]]);
    expect(b.sum).toBe(28_000 + 30_000 + 30_000);
  });

  it('leaves out deleted laps, in-laps and out-laps even when they are faster', () => {
    expect(invalid.some(isValid)).toBe(false);
    expect(sessionBests([...invalid, ...clean])).toEqual(sessionBests(clean));
  });

  it('has no sum when a sector has no valid value', () => {
    const b = sessionBests([
      lap(1, 2, { lap_ms: 90_000, s1_ms: 28_000, s3_ms: 31_000 }),
      lap(1, 3, { s2_ms: 25_000, deleted: true }),
    ]);
    expect([b.s2, b.sum]).toEqual([null, null]);
    expect(b.lap).not.toBeNull();
    expect(sessionBests([])).toEqual({ lap: null, s1: null, s2: null, s3: null, sum: null, top: null });
  });

  it('takes the top speed on valid laps only, ties to the earlier lap', () => {
    expect(sessionBests([...invalid, ...clean]).top).toBe(clean[1]);
    const late = lap(4, 9, { st_kph: 318, date_start: t('30:00') });
    const early = lap(81, 12, { st_kph: 318, date_start: t('20:00') });
    expect(sessionBests([late, early]).top).toBe(early);
  });

  it('breaks ties by earlier start (parsed, nulls last), then lap number, then driver number', () => {
    const v = { lap_ms: 90_000 };
    const noDate = lap(1, 1, v);
    const later = lap(2, 1, { ...v, date_start: t('10:00.095000') });
    const earlier = lap(3, 9, { ...v, date_start: t('10:00') });
    expect(bestOf([noDate, later, earlier], 'lap_ms')).toBe(earlier);
    expect(bestOf([noDate, later], 'lap_ms')).toBe(later);
    expect(bestOf([lap(5, 7, v), lap(6, 3, v)], 'lap_ms')?.driver_number).toBe(6);
    expect(bestOf([lap(55, 3, v), lap(4, 3, v)], 'lap_ms')?.driver_number).toBe(4);
  });

  it("keeps each driver's own best", () => {
    const own = ownBests([...invalid, ...clean], 's3_ms');
    expect([...own]).toEqual([
      [1, clean[2]],
      [44, clean[1]],
    ]);
  });
});

describe('colouredBests (#112)', () => {
  const c = (lap: 'purple' | 'green' | 'yellow' | null) => ({ colour: { lap, s1: null, s2: null, s3: null } });
  it("keeps each driver's fastest purple or green lap: a lap without a time last, the first of a tie", () => {
    const laps = [
      lap(1, 1, { ...c('green'), lap_ms: null }), // coloured, no time: never ahead of a timed one
      lap(1, 2, { ...c('green'), lap_ms: 90_000 }),
      lap(1, 3, { ...c('purple'), lap_ms: 89_000 }),
      lap(1, 4, { ...c('yellow'), lap_ms: 80_000 }), // faster, not coloured
      lap(44, 2, { ...c('green'), lap_ms: 89_500 }),
      lap(44, 3, { ...c('green'), lap_ms: 89_500 }),
      lap(16, 1, { ...c('green'), lap_ms: null }),
      lap(16, 2, { ...c(null), lap_ms: 85_000 }),
    ];
    expect([...colouredBests(laps)].map(([n, l]) => [n, l.lap_number])).toEqual([
      [1, 3],
      [44, 2],
      [16, 1],
    ]);
  });
});

describe('deltaStep (D3)', () => {
  it.each([
    [0, 0],
    [-50, 0],
    [499, 0],
    [500, 1],
    [999, 1],
    [1000, 2],
    [1999, 2],
    [2000, 3],
  ])('%i ms on a 100 s best is step %i', (diff, step) => {
    expect(deltaStep(diff, 100_000)).toBe(step);
  });

  it('formats the Δ with two digits', () => {
    expect([fmtDelta(412, 2), fmtDelta(-46, 2), fmtDelta(412)]).toEqual(['+0.41', '−0.05', '+0.412']);
  });
});

describe('ownTop', () => {
  it('takes the fastest reading on valid laps, in the A§9 tie order', () => {
    const slow = lap(1, 2, { st_kph: 300 });
    const late = lap(2, 5, { st_kph: 320, date_start: t('30:00') });
    const early = lap(3, 9, { st_kph: 320, date_start: t('20:00') });
    expect(ownTop([slow, late, early], 'st_kph')).toBe(early);
    expect(ownTop([lap(5, 7, { st_kph: 320 }), lap(6, 3, { st_kph: 320 })], 'st_kph')?.driver_number).toBe(6);
    expect(ownTop([lap(55, 3, { st_kph: 320 }), lap(4, 3, { st_kph: 320 })], 'st_kph')?.driver_number).toBe(4);
    expect(ownTop([slow], 'i1_kph')).toBeNull();
  });

  it('ignores deleted laps, in-laps and out-laps', () => {
    const bad = [{ deleted: true }, { is_pit_in: true }, { is_pit_out: true }].map((x, i) =>
      lap(1, i + 2, { st_kph: 340, i1_kph: 340, ...x }),
    );
    expect(ownTop([...bad, lap(1, 9, { st_kph: 300 })], 'st_kph')?.st_kph).toBe(300);
    expect(ownTop(bad, 'st_kph')).toBeNull();
  });
});

describe('speedTable', () => {
  const laps = [
    lap(1, 2, { lap_ms: 90_000, s1_ms: 28_000, s2_ms: 31_000, s3_ms: 31_000, i1_kph: 290, i2_kph: 300, st_kph: 310 }),
    lap(1, 3, { lap_ms: 90_500, s1_ms: 28_500, s2_ms: 30_500, s3_ms: 30_900, st_kph: 312, quali_phase: 2 }),
    lap(44, 2, { lap_ms: 89_000, s1_ms: 28_200, s2_ms: 30_000, s3_ms: 30_800, st_kph: 318, quali_phase: 1 }),
    lap(63, 2, { lap_ms: 91_000, s1_ms: 28_000, s2_ms: 31_000 }), // no S3, no speeds
    lap(16, 2, { lap_ms: 80_000, st_kph: 340, deleted: true }),
  ];
  const row = (d: number, phase: number | null = null) => speedTable(laps, phase).find((r) => r.driver === d);

  it('takes the speeds from valid laps only', () => {
    expect(row(16)?.st).toBeNull();
    expect(row(1)?.st).toBe(laps[1]);
    expect(row(1)?.i1).toBe(laps[0]);
  });

  it('leaves a missing reading null', () => {
    expect([row(63)?.i1, row(63)?.i2, row(63)?.st]).toEqual([null, null, null]);
  });

  it('sums the own best sectors from different laps, only with all three', () => {
    expect(row(1)?.sum).toBe(28_000 + 30_500 + 30_900);
    expect(row(63)?.sum).toBeNull();
    expect(row(16)?.sum).toBeNull();
  });

  it('applies the phase to the lap and the sum, not to the speeds', () => {
    const r = row(1, 2);
    expect(r?.lap).toBe(laps[1]);
    expect(r?.sum).toBe(28_500 + 30_500 + 30_900);
    expect(r?.st).toBe(laps[1]);
    expect(row(1, 1)).toMatchObject({ lap: null, sum: null, i1: laps[0] }); // laps[0] has no phase, speeds stay
    expect(speedTable(laps, 1).map((x) => x.driver)).toEqual(speedTable(laps, null).map((x) => x.driver));
  });

  it('sorts by ST descending, nulls last, then driver number', () => {
    expect(speedTable(laps, null).map((r) => r.driver)).toEqual([44, 1, 16, 63]);
    const tied = [lap(9, 2, { st_kph: 300 }), lap(3, 2, { st_kph: 300 }), lap(7, 2)];
    expect(speedTable(tied, null).map((r) => r.driver)).toEqual([3, 9, 7]);
  });

  it('boxes one cell per column: the session top by the same tie order', () => {
    const a = lap(1, 2, { st_kph: 320, date_start: t('30:00') });
    const b = lap(2, 2, { st_kph: 320, date_start: t('20:00') });
    expect(speedTops([a, b]).st_kph).toBe(b);
    expect(speedTable([a, b], null).filter((r) => r.st === speedTops([a, b]).st_kph)).toHaveLength(1);
  });

  it('has exactly one top per column when a valid reading exists, none otherwise', () => {
    const speed = fc.option(fc.integer({ min: 200, max: 360 }), { nil: null });
    const anyLap = fc.record({
      driver: fc.integer({ min: 1, max: 5 }),
      i1: speed,
      i2: speed,
      st: speed,
      top: speed,
      deleted: fc.boolean(),
      in: fc.boolean(),
      out: fc.boolean(),
      start: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(anyLap, { maxLength: 30 }), (specs) => {
        const laps = specs.map((s, i) =>
          lap(s.driver, i + 1, {
            i1_kph: s.i1,
            i2_kph: s.i2,
            st_kph: s.st,
            top_kph: s.top,
            deleted: s.deleted,
            is_pit_in: s.in,
            is_pit_out: s.out,
            date_start: s.start === null ? null : t(`0${s.start}:00`),
          }),
        );
        const tops = speedTops(laps);
        const rows = speedTable(laps, null);
        for (const [field, key] of [
          ['i1_kph', 'i1'],
          ['i2_kph', 'i2'],
          ['st_kph', 'st'],
          ['top_kph', 'top'],
        ] as const satisfies readonly (readonly [Speed, 'i1' | 'i2' | 'st' | 'top'])[]) {
          const any = laps.some((l) => isValid(l) && l[field] !== null);
          const boxed = rows.filter((r) => r[key] !== null && r[key] === tops[field]);
          expect(boxed).toHaveLength(any ? 1 : 0);
          expect(tops[field] !== null).toBe(any);
        }
      }),
    );
  });
});
