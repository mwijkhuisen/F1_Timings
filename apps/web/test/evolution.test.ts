import { describe, expect, it } from 'vitest';
import { evolution, evolutionSlots } from '../src/lib/evolution.ts';
import { lap } from './laps.ts';

// lib/evolution.ts (#114): the running best, the bands and the 5-minute slots, on synthetic laps.

const T0 = Date.parse('2026-10-24T12:00:00Z');
const MIN = 60_000;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const L = (driver: number, n: number, min: number, ms: number | null, extra = {}) =>
  lap(driver, n, { date_start: at(min), lap_ms: ms, ...extra });

describe('evolution', () => {
  it('steps only on strict improvements and closes at the last point', () => {
    const laps = [
      L(1, 2, 0, 90_000),
      L(2, 2, 1, 91_000), // slower
      L(1, 3, 2, 89_000), // improvement
      L(2, 3, 3, 89_000), // equal: not strict
      L(1, 4, 9, 90_500), // slower, the last point
    ];
    const e = evolution(laps, 'Practice', 'Practice 1', []);
    expect(e.steps).toEqual([
      { t: T0, ms: 90_000 },
      { t: T0 + 2 * MIN, ms: 89_000 },
      { t: T0 + 9 * MIN, ms: 89_000 },
    ]);
    expect(e.points).toHaveLength(5);
  });

  it('does not repeat a closing point when the last point is the best', () => {
    const e = evolution([L(1, 2, 0, 90_000), L(1, 3, 2, 89_000)], 'Practice', 'Practice 1', []);
    expect(e.steps).toEqual([
      { t: T0, ms: 90_000 },
      { t: T0 + 2 * MIN, ms: 89_000 },
    ]);
  });

  it('never lets a deleted lap set the best, but keeps it as a point marked deleted', () => {
    const e = evolution([L(1, 2, 0, 90_000), L(1, 3, 2, 80_000, { deleted: true })], 'Practice', 'Practice 1', []);
    expect(e.steps.map((s) => s.ms)).toEqual([90_000, 90_000]);
    expect(e.points.map((p) => [p.ms, p.deleted])).toEqual([
      [90_000, false],
      [80_000, true],
    ]);
    expect(evolution([L(1, 2, 0, 80_000, { deleted: true })], 'Practice', 'P', []).steps).toEqual([]);
  });

  it('leaves out in-laps, out-laps and untimed laps, and counts laps without a date_start', () => {
    const laps = [
      L(1, 1, 0, 100_000, { is_pit_out: true }),
      L(1, 2, 2, 90_000),
      L(1, 3, 4, 100_000, { is_pit_in: true }),
      L(1, 4, 6, null),
      lap(1, 5, { lap_ms: 91_000 }),
      lap(1, 6, { lap_ms: null }), // untimed and undated: not counted
    ];
    const e = evolution(laps, 'Practice', 'Practice 1', []);
    expect(e.points.map((p) => p.lap)).toEqual([2]);
    expect(e.noStart).toBe(1);
  });

  it('orders the points by parsed start', () => {
    const laps = [
      lap(2, 2, { lap_ms: 90_000, date_start: '2026-10-24T12:05:00.095000+00:00' }),
      lap(1, 2, { lap_ms: 90_000, date_start: '2026-10-24T12:05:00+00:00' }),
    ];
    expect(evolution(laps, 'Practice', 'P', []).points.map((p) => p.driver)).toEqual([1, 2]);
  });

  it('bands qualifying by quali_phase, first start to last end, named per session', () => {
    const laps = [
      L(1, 2, 0, 80_000, { quali_phase: 1 }),
      L(1, 4, 20, 80_000, { quali_phase: 1, is_pit_in: true }),
      L(2, 2, 10, 79_000, { quali_phase: 1 }),
      L(1, 6, 30, 78_000, { quali_phase: 2 }),
      lap(1, 8, { lap_ms: 77_000, quali_phase: 3 }), // no date: no band of its own
    ];
    const q = evolution(laps, 'Qualifying', 'Qualifying', []);
    expect(q.bands).toEqual([
      { label: 'Q1', from: T0, to: T0 + 20 * MIN + 80_000, red: false },
      { label: 'Q2', from: T0 + 30 * MIN, to: T0 + 30 * MIN + 78_000, red: false },
    ]);
    const sq = evolution(laps, 'Qualifying', 'Sprint Qualifying', []);
    expect(sq.bands.map((b) => b.label)).toEqual(['SQ1', 'SQ2']);
  });

  it('bands practice by its red clock periods only', () => {
    const clock = [
      { kind: 'red' as const, from: T0 + 5 * MIN, to: T0 + 12 * MIN },
      { kind: 'vsc' as const, from: T0, to: T0 + MIN },
    ];
    expect(evolution([L(1, 2, 0, 90_000)], 'Practice', 'Practice 2', clock).bands).toEqual([
      { label: 'RED', from: T0 + 5 * MIN, to: T0 + 12 * MIN, red: true },
    ]);
    expect(evolution([L(1, 2, 0, 90_000, { quali_phase: 1 })], 'Race', 'Race', clock).bands).toEqual([]);
  });
});

describe('evolutionSlots', () => {
  const pts = (laps: ReturnType<typeof L>[], type = 'Practice') => evolution(laps, type, 'S', []).points;

  it('lists the fastest non-deleted lap per 5-minute slot, with the best flag', () => {
    const slots = evolutionSlots(
      pts([
        L(1, 2, 1, 90_000), // slot 0, new best
        L(2, 2, 3, 90_500), // slot 0, slower
        L(2, 3, 7, 91_000), // slot 1, not a best
        L(1, 3, 11, 89_000), // slot 2, new best
        L(3, 2, 12, 89_500), // slot 2, slower
      ]),
    );
    expect(slots.map((s) => [s.slot, s.point.driver, s.point.lap, s.point.ms, s.best])).toEqual([
      [T0, 1, 2, 90_000, true],
      [T0 + 5 * MIN, 2, 3, 91_000, false],
      [T0 + 10 * MIN, 1, 3, 89_000, true],
    ]);
    expect(slots.every((s) => s.phase === null)).toBe(true);
  });

  it('flags the fastest of a slot only when it beat the running best by then', () => {
    // Both in slot 0: 90 s then 89 s. The fastest is the later one, and it beat the 90 s.
    const [one] = evolutionSlots(pts([L(1, 2, 0, 90_000), L(2, 2, 1, 89_000)]));
    expect([one?.point.ms, one?.best]).toEqual([89_000, true]);
    // An earlier slot already holds 85 s: slot 1's 89 s is no new best.
    const slots = evolutionSlots(pts([L(1, 2, 0, 85_000), L(2, 2, 6, 89_000)]));
    expect(slots.map((s) => s.best)).toEqual([true, false]);
  });

  it('does not list a slot that holds only deleted laps', () => {
    const slots = evolutionSlots(pts([L(1, 2, 1, 90_000), L(2, 2, 6, 80_000, { deleted: true })]));
    expect(slots).toHaveLength(1);
    // A deleted lap never beats the others in its own slot either.
    const mixed = evolutionSlots(pts([L(1, 2, 1, 90_000), L(2, 2, 2, 80_000, { deleted: true })]));
    expect(mixed[0]?.point.ms).toBe(90_000);
  });

  it('makes a slot per phase in qualifying', () => {
    const slots = evolutionSlots(
      pts(
        [
          L(1, 2, 1, 80_000, { quali_phase: 1 }),
          L(2, 2, 2, 79_500, { quali_phase: 2 }), // same slot, other phase
          L(1, 3, 3, 79_000, { quali_phase: 1 }),
        ],
        'Qualifying',
      ),
    );
    expect(slots.map((s) => [s.phase, s.point.ms, s.best])).toEqual([
      [1, 79_000, true],
      [2, 79_500, true],
    ]);
  });

  it('breaks an equal time by the earlier lap, and takes unsorted input', () => {
    const [a, b] = pts([L(1, 2, 1, 90_000), L(2, 2, 2, 90_000)]);
    const [slot] = evolutionSlots([b, a] as NonNullable<typeof a>[]);
    expect(slot?.point.driver).toBe(1);
  });
});
