import { describe, expect, it } from 'vitest';
import { type MergedPit, mergePits, type PitValues, type StoredPit } from '../src/merge/pits.ts';

// The pit merge (#219, A§7) on invented rows: the feed over OpenF1, fills with `filled`, legacy rows, removal.

const D = Date.parse('2026-10-11T13:30:00Z');
const v = (o: Partial<PitValues>): PitValues => ({ date: null, pit_ms: null, lane_ms: null, stop_ms: null, ...o });
/** A row as writePits stores it (its merged values, its sources). */
const stored = (r: MergedPit): StoredPit => r;
/** A row an image before #219 wrote: its own values, `sources` {}. */
const legacy = (driver_number: number, lap_number: number, source: string, o: Partial<PitValues>): StoredPit => ({
  driver_number,
  lap_number,
  source,
  ...v(o),
  sources: {},
});
const openf1 = [
  { driver_number: 4, lap_number: 18, ...v({ date: D + 2000, pit_ms: 22_100, lane_ms: 22_100 }) },
  { driver_number: 44, lap_number: 10, ...v({ date: D + 60_000, pit_ms: 21_000, lane_ms: 21_000, stop_ms: 2500 }) },
];
const archive = [
  { driver_number: 3, lap_number: 3, ...v({ date: D - 5000, lane_ms: 21_600 }) },
  { driver_number: 4, lap_number: 18, ...v({ date: D, lane_ms: 21_937, stop_ms: 2200 }) },
];

describe('mergePits', () => {
  const first = mergePits([], 'openf1', openf1);
  const both = mergePits(first.rows.map(stored), 'f1-archive', archive);

  it('the feed wins over OpenF1 for a value both have, OpenF1 fills what the feed lacks, marked in `filled`', () => {
    expect(both.rows).toEqual([
      {
        driver_number: 3,
        lap_number: 3,
        source: 'f1-archive',
        ...v({ date: D - 5000, lane_ms: 21_600 }),
        sources: { 'f1-archive': v({ date: D - 5000, lane_ms: 21_600 }) },
        filled: {},
      },
      {
        driver_number: 4,
        lap_number: 18,
        source: 'f1-archive',
        date: D,
        pit_ms: 22_100,
        lane_ms: 21_937,
        stop_ms: 2200,
        sources: {
          openf1: v({ date: D + 2000, pit_ms: 22_100, lane_ms: 22_100 }),
          'f1-archive': v({ date: D, lane_ms: 21_937, stop_ms: 2200 }),
        },
        filled: { pit_ms: 'openf1' },
      },
      {
        driver_number: 44,
        lap_number: 10,
        source: 'openf1',
        ...v({ date: D + 60_000, pit_ms: 21_000, lane_ms: 21_000, stop_ms: 2500 }),
        sources: { openf1: v({ date: D + 60_000, pit_ms: 21_000, lane_ms: 21_000, stop_ms: 2500 }) },
        filled: {},
      },
    ]);
    // Only OpenF1 has 44/10 under the archive; the dates 2 s apart and the lane times differ, the stop times not.
    expect(both.counts).toEqual({
      rows: 3,
      added: { openf1: 1 },
      filled: { openf1: { pit_ms: 1 } },
      diffs: { openf1: { date: 1, lane_ms: 1 } },
    });
    expect(first.counts).toEqual({ rows: 2, added: {}, filled: {}, diffs: {} });
  });

  it('a lower source fills the base, whichever it is: live over OpenF1, OpenF1 over Jolpica', () => {
    const live = mergePits(first.rows.map(stored), 'f1-live', [
      { driver_number: 44, lap_number: 10, date: D + 60_400, lane_ms: 21_020 },
    ]);
    expect(live.rows[1]).toMatchObject({
      source: 'f1-live',
      date: D + 60_400, // within 1 s of OpenF1's: no diff
      lane_ms: 21_020,
      pit_ms: 21_000,
      stop_ms: 2500,
      filled: { pit_ms: 'openf1', stop_ms: 'openf1' },
    });
    expect(live.counts.diffs).toEqual({ openf1: { lane_ms: 1 } });
    const old = mergePits([], 'jolpica', [{ driver_number: 4, lap_number: 18, date: null, pit_ms: 23_000 }]);
    expect(mergePits(old.rows.map(stored), 'openf1', openf1).rows[0]).toMatchObject({
      source: 'openf1',
      pit_ms: 22_100,
      filled: {},
    });
  });

  it('the same input again gives the same rows (idempotent), and the input order does not matter', () => {
    expect(mergePits(both.rows.map(stored), 'f1-archive', archive)).toEqual(both);
    expect(mergePits(both.rows.map(stored), 'openf1', openf1.toReversed())).toEqual(both);
  });

  it('a legacy row (sources {}) counts as the candidate of its own source', () => {
    const rows = [legacy(4, 18, 'openf1', openf1[0] ?? {}), legacy(44, 10, 'openf1', openf1[1] ?? {})];
    expect(mergePits(rows, 'f1-archive', archive)).toEqual(both);
    // Its own source's rewrite replaces it: no second candidate.
    expect(mergePits(rows, 'openf1', openf1)).toEqual(first);
  });

  it("a source's empty write removes only its candidates; a row left without one is dropped", () => {
    const gone = mergePits(both.rows.map(stored), 'f1-archive', []);
    expect(gone.rows).toEqual(first.rows);
    expect(gone.counts).toEqual(first.counts);
    expect(
      mergePits(both.rows.map(stored), 'openf1', []).rows.map((r) => [r.driver_number, r.source, r.filled]),
    ).toEqual([
      [3, 'f1-archive', {}],
      [4, 'f1-archive', {}],
    ]);
    expect(mergePits(first.rows.map(stored), 'openf1', [])).toEqual({
      rows: [],
      counts: { rows: 0, added: {}, filled: {}, diffs: {} },
    });
  });

  it('a stored source outside PIT_ORDER throws', () => {
    const odd = { ...legacy(4, 18, 'openf1', {}), sources: { fia: v({ lane_ms: 1 }) } };
    expect(() => mergePits([odd], 'openf1', [])).toThrow('a pit source outside PIT_ORDER');
    expect(() => mergePits([legacy(4, 18, 'fia', {})], 'openf1', [])).toThrow('a pit source outside PIT_ORDER');
  });

  it('a stored sources entry that is not an object of numbers or null is absent; the others stay', () => {
    const odd = (sources: unknown) => ({ ...legacy(4, 18, 'openf1', {}), sources }) as unknown as StoredPit;
    const good = { 'f1-archive': v({ lane_ms: 21_937 }) };
    for (const bad of [null, 7, 'x', [], { lane_ms: '21' }, { lane_ms: {} }]) {
      const got = mergePits([odd({ ...good, openf1: bad })], 'f1-live', []);
      expect(got.rows).toHaveLength(1);
      expect(got.rows[0]).toMatchObject({ source: 'f1-archive', lane_ms: 21_937, filled: {} });
      expect(got.rows[0]?.sources).toEqual(good);
    }
    // Nothing valid left: the row is dropped, not thrown on.
    expect(mergePits([odd({ openf1: null })], 'f1-live', []).rows).toEqual([]);
  });

  it('200,000 rows merge: the top source is found without spreading the rows into a call', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({
      driver_number: (i % 999) + 1,
      lap_number: Math.floor(i / 999),
      lane_ms: 20_000,
    }));
    expect(mergePits([], 'openf1', rows).counts.rows).toBe(200_000);
  });
});
