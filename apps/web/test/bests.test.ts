import { describe, expect, it } from 'vitest';
import { bestOf, deltaStep, isValid, ownBests, sessionBests } from '../src/lib/bests.ts';
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
