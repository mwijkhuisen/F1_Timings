import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normaliseSession } from '../src/ingest/normalise.ts';
import { type Candidate, merge } from '../src/merge/merge.ts';
import type { Lap, RaceControl } from '../src/openf1/schemas.ts';
import type { RuleMessage } from '../src/timing/rules.ts';

// The P3b merge (A§7, owner D2–D4), one test per rule. Values are invented, except the 11392 fixtures.

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const golden = <T>(name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.golden.json`), 'utf8')) as T[];

const lap = (source: string, driver_number: number, lap_number: number, values: Partial<Candidate> = {}) =>
  ({
    session_key: 1,
    source,
    driver_number,
    lap_number,
    date_start: null,
    lap_ms: null,
    s1_ms: null,
    s2_ms: null,
    s3_ms: null,
    i1_kph: null,
    i2_kph: null,
    st_kph: null,
    is_pit_out: null,
    seg1: null,
    seg2: null,
    seg3: null,
    quali_phase: null,
    ...values,
  }) satisfies Candidate;
const rc = (message: string | null, date = '2026-10-24T21:00:00+00:00', qualifying_phase: number | null = null) =>
  ({ date, qualifying_phase, message }) satisfies RuleMessage;
const only = (candidates: Candidate[], raceControl: RuleMessage[] = [], type: string | null = 'Race') => {
  const { rows, counts } = merge(candidates, raceControl, type);
  expect(rows).toHaveLength(1);
  return { row: rows[0], counts };
};

describe('merge', () => {
  it('each value comes from the highest source that has it; `filled` names the others', () => {
    const { row, counts } = only([
      lap('f1-live', 1, 1, { lap_ms: 90_000, s3_ms: 29_000, i1_kph: 285, i2_kph: 250, st_kph: 302 }),
      lap('openf1', 1, 1, { lap_ms: 90_000, s1_ms: 30_000, st_kph: 300 }),
      lap('f1-archive', 1, 1, { lap_ms: 90_001, s1_ms: 30_000, s2_ms: 31_000, i1_kph: 280, st_kph: 301 }),
    ]);
    expect(row).toMatchObject({
      source: 'openf1',
      lap_ms: 90_000,
      s1_ms: 30_000,
      s2_ms: 31_000,
      s3_ms: 29_000,
      i1_kph: 280,
      i2_kph: 250,
      st_kph: 300,
      filled: { s2_ms: 'f1-archive', i1_kph: 'f1-archive', s3_ms: 'f1-live', i2_kph: 'f1-live' },
    });
    expect(counts.filled).toEqual({ 'f1-archive': { s2_ms: 1, i1_kph: 1 }, 'f1-live': { s3_ms: 1, i2_kph: 1 } });
    // Against the merged row so far: the recording's i1 differs from the archive's filled one.
    expect(counts.diffs).toEqual({ 'f1-archive': { st_kph: 1 }, 'f1-live': { i1_kph: 1, st_kph: 1 } });
    expect(counts.conflicts).toEqual({});
    expect(counts.added).toEqual({});
  });

  it('a lap or sector time more than 1 ms apart is a conflict: that source fills nothing, its diffs still count', () => {
    const { rows, counts } = merge(
      [
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('f1-archive', 1, 1, { lap_ms: 90_002, s1_ms: 30_000, i1_kph: 280 }),
        lap('f1-live', 1, 1, { lap_ms: 90_000, s1_ms: 30_001 }),
        lap('openf1', 1, 2, { lap_ms: 91_000, s3_ms: 28_000 }),
        lap('f1-archive', 1, 2, { lap_ms: 91_000, s3_ms: 28_100, st_kph: 300 }),
      ],
      [],
      'Race',
    );
    expect(rows.map((r) => [r.lap_ms, r.s1_ms, r.s3_ms, r.i1_kph, r.st_kph, r.filled])).toEqual([
      [90_000, 30_001, null, null, null, { s1_ms: 'f1-live' }],
      [91_000, null, 28_000, null, null, {}],
    ]);
    expect(counts.conflicts).toEqual({ 'f1-archive': 2 });
    expect(counts.diffs).toEqual({ 'f1-archive': { lap_ms: 1, s3_ms: 1 } });
    expect(counts.filled).toEqual({ 'f1-live': { s1_ms: 1 } });
  });

  it("a lap the higher sources lack comes from the next one that has it, counted in `added` unless it is the session's top source", () => {
    const { rows, counts } = merge(
      [
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('f1-archive', 1, 1, { lap_ms: 90_000 }),
        lap('f1-archive', 1, 2, { lap_ms: 91_000 }),
        lap('f1-live', 1, 2, { lap_ms: 91_000, i1_kph: 280 }),
        lap('f1-live', 1, 3, { lap_ms: 92_000 }),
      ],
      [],
      'Race',
    );
    expect(rows.map((r) => [r.lap_number, r.source, r.lap_ms, r.filled])).toEqual([
      [1, 'openf1', 90_000, {}],
      [2, 'f1-archive', 91_000, { i1_kph: 'f1-live' }],
      [3, 'f1-live', 92_000, {}],
    ]);
    expect(counts.added).toEqual({ 'f1-archive': 1, 'f1-live': 1 });
    expect(counts.dup).toEqual({});
    expect(counts.rows).toBe(3);
    // Without OpenF1 the archive is the session's top source: only the recording's lap is added.
    const archive = merge([lap('f1-archive', 1, 1), lap('f1-live', 1, 1), lap('f1-live', 1, 2)], [], 'Race');
    expect(archive.counts.added).toEqual({ 'f1-live': 1 });
  });

  describe('E6: a lap only a lower source has is not added when it repeats the higher previous lap', () => {
    const laps = (candidates: Candidate[]) => {
      const { rows, counts } = merge(candidates, [], 'Race');
      return { rows: rows.map((r) => [r.lap_number, r.source, r.lap_ms]), counts };
    };

    it("one within 1 ms of the higher source's lap n − 1 is not added and counts as `dup`", () => {
      const { rows, counts } = laps([
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('openf1', 1, 2, { lap_ms: 91_500 }), // lap 3's time
        lap('jolpica', 1, 2, { lap_ms: 91_000 }),
        lap('jolpica', 1, 3, { lap_ms: 91_501, s1_ms: 30_000 }),
        lap('openf1', 1, 4, { lap_ms: 92_000 }),
      ]);
      expect(rows).toEqual([
        [1, 'openf1', 90_000],
        [2, 'openf1', 91_500],
        [4, 'openf1', 92_000],
      ]);
      expect(counts).toMatchObject({ added: {}, dup: { jolpica: 1 }, filled: {}, diffs: { jolpica: { lap_ms: 1 } } });
    });

    it('one 2 ms off is added', () => {
      const { rows, counts } = laps([
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('jolpica', 1, 2, { lap_ms: 90_002 }),
      ]);
      expect(rows).toEqual([
        [1, 'openf1', 90_000],
        [2, 'jolpica', 90_002],
      ]);
      expect(counts).toMatchObject({ added: { jolpica: 1 }, dup: {} });
    });

    it('a block of added laps keeps two equal consecutive times, as its lap n − 1 is the same lower source', () => {
      const { rows, counts } = laps([
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('jolpica', 1, 2, { lap_ms: 91_000 }),
        lap('jolpica', 1, 3, { lap_ms: 91_000 }),
        lap('openf1', 1, 4),
        lap('jolpica', 1, 4, { lap_ms: 92_000 }), // filled from jolpica
        lap('jolpica', 1, 5, { lap_ms: 92_000 }),
      ]);
      expect(rows).toEqual([
        [1, 'openf1', 90_000],
        [2, 'jolpica', 91_000],
        [3, 'jolpica', 91_000],
        [4, 'openf1', 92_000],
        [5, 'jolpica', 92_000],
      ]);
      expect(counts).toMatchObject({ added: { jolpica: 3 }, dup: {} });
    });

    it('a null on either side does not block', () => {
      const { rows, counts } = laps([
        lap('openf1', 1, 1),
        lap('jolpica', 1, 2, { lap_ms: 90_000 }),
        lap('openf1', 2, 1, { lap_ms: 90_000 }),
        lap('jolpica', 2, 2, { s1_ms: 30_000 }),
      ]);
      expect(rows).toEqual([
        [1, 'openf1', null],
        [2, 'jolpica', 90_000],
        [1, 'openf1', 90_000],
        [2, 'jolpica', null],
      ]);
      expect(counts).toMatchObject({ added: { jolpica: 2 }, dup: {} });
    });

    it('with two lower sources, the first is skipped as `dup` and the second, with another time, is added', () => {
      const { rows, counts } = laps([
        lap('jolpica', 1, 2, { lap_ms: 91_000 }),
        lap('openf1', 1, 1, { lap_ms: 90_000 }),
        lap('f1-archive', 1, 2, { lap_ms: 90_001, s1_ms: 30_000 }),
      ]);
      expect(rows).toEqual([
        [1, 'openf1', 90_000],
        [2, 'jolpica', 91_000],
      ]);
      expect(counts).toMatchObject({ added: { jolpica: 1 }, dup: { 'f1-archive': 1 }, filled: {}, diffs: {} });
    });
  });

  it('a null segment array is filled whole; a null element inside one is not', () => {
    const { row, counts } = only([
      lap('openf1', 1, 1, { seg1: [2048, null, 2049] as number[] }),
      lap('f1-archive', 1, 1, { seg1: [2048, 2051, 2049], seg2: [2049, 2049] }),
    ]);
    expect(row).toMatchObject({ seg1: [2048, null, 2049], seg2: [2049, 2049], filled: { seg2: 'f1-archive' } });
    expect(counts.diffs).toEqual({ 'f1-archive': { seg1: 1 } });
  });

  it('diffs per source and field: times within 1 ms and date_start within 1000 ms are equal', () => {
    const { counts } = merge(
      [
        lap('openf1', 1, 1, {
          lap_ms: 90_000,
          s1_ms: 30_000,
          date_start: '2026-10-11T12:00:00.000Z',
          is_pit_out: false,
          quali_phase: 1,
        }),
        lap('f1-archive', 1, 1, {
          lap_ms: 90_001,
          s1_ms: 29_999,
          date_start: '2026-10-11T12:00:01.000000+00:00',
          is_pit_out: true,
          quali_phase: 1,
        }),
        lap('f1-live', 1, 1, { lap_ms: 90_000, date_start: '2026-10-11T12:00:01.001Z', quali_phase: 2 }),
        lap('openf1', 1, 2, { s2_ms: 40_000 }),
        lap('f1-archive', 1, 2, { s2_ms: 40_002 }),
      ],
      [],
      'Race',
    );
    expect(counts.diffs).toEqual({
      'f1-archive': { is_pit_out: 1, s2_ms: 1 },
      'f1-live': { date_start: 1, quali_phase: 1 },
    });
    expect(counts.conflicts).toEqual({ 'f1-archive': 1 });
  });

  it('a filled lap time can now match a TIME-form DELETED message', () => {
    const message = rc('CAR 87 (BEA) TIME 1:15.197 DELETED - TRACK LIMITS AT TURN 8 (NEXT LAP)');
    const openf1 = lap('openf1', 87, 2, { s1_ms: 25_000 });
    expect(only([openf1], [message], 'Practice')).toMatchObject({
      row: { deleted: false },
      counts: { rules: { deleted: 0, unmatched: 1 } },
    });
    const { row, counts } = only([openf1, lap('f1-archive', 87, 2, { lap_ms: 75_197 })], [message], 'Practice');
    expect(row).toMatchObject({ lap_ms: 75_197, deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 8 (NEXT LAP)' });
    expect(counts.rules).toEqual({ deleted: 1, reinstated: 0, unmatched: 0, unparsed: 0 });
  });

  it('lap n is an in-lap when an added lap n + 1 is an out-lap', () => {
    const { rows } = merge(
      [lap('openf1', 1, 1), lap('openf1', 1, 2), lap('f1-archive', 1, 3, { is_pit_out: true })],
      [],
      'Race',
    );
    expect(rows.map((r) => [r.lap_number, r.is_pit_in])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('quali_phase keeps a merged value; only a null one comes from the race control', () => {
    const phase1 = [rc(null, '2026-10-24T21:00:00+00:00', 1)];
    const { rows } = merge(
      [
        lap('openf1', 1, 1, { date_start: '2026-10-24T21:05:00+00:00', quali_phase: 2 }),
        lap('openf1', 1, 2, { date_start: '2026-10-24T21:07:00+00:00' }),
        lap('f1-archive', 1, 2, { quali_phase: 3 }),
        lap('openf1', 1, 3, { date_start: '2026-10-24T21:09:00+00:00' }),
        lap('f1-live', 1, 4, { date_start: '2026-10-24T21:11:00+00:00' }), // a recording-only lap
        lap('openf1', 1, 5),
        lap('f1-archive', 1, 5, { date_start: '2026-10-24T21:13:00+00:00' }), // its date_start comes from the archive
      ],
      phase1,
      'Qualifying',
    );
    expect(rows.map((r) => [r.quali_phase, r.filled])).toEqual([
      [2, {}],
      [3, { quali_phase: 'f1-archive' }],
      [1, {}],
      [1, {}],
      [1, { date_start: 'f1-archive' }],
    ]);
  });

  // 11392 (Qualifying) as the ingest builds it: the deletions and phases of a single-source session stay as they are.
  const normalised = normaliseSession(
    11392,
    {
      drivers: [],
      laps: [...golden<Lap>('laps-quali'), ...golden<Lap>('laps-deleted')],
      stints: [],
      pit: [],
      race_control: golden<RaceControl>('race_control-quali'),
      session_result: [],
      weather: [],
    },
    'Qualifying',
  );
  const raceControl = golden<RaceControl>('race_control-quali');
  const candidates = normalised.rows.lap.map(
    ({ is_pit_in, deleted, deleted_reason, ...l }) => l as unknown as Candidate,
  );

  it('a single-source session merges to exactly its input, with `filled` {}', () => {
    const { rows, counts } = merge(candidates, raceControl, 'Qualifying');
    const expected = normalised.rows.lap
      .map((l) => ({ ...l, filled: {} }))
      .sort((a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number);
    expect(rows).toEqual(expected);
    expect(rows.filter((r) => r.deleted)).toHaveLength(6);
    expect(counts).toMatchObject({ rows: candidates.length, added: {}, dup: {}, filled: {}, diffs: {}, conflicts: {} });
    expect(counts.rules).toEqual(normalised.rules);
  });

  it('the same candidates in any order merge to the same rows and counts', () => {
    const three = candidates.flatMap((c, i) => [
      c,
      { ...c, source: 'f1-archive', lap_ms: i % 3 === 0 ? (c.lap_ms ?? 0) + 5 : c.lap_ms, i1_kph: 300 },
      ...(i % 2 ? [{ ...c, source: 'f1-live', lap_number: c.lap_number + 40, s1_ms: 1 }] : []),
    ]);
    const reference = merge(three, raceControl, 'Qualifying');
    expect(reference.counts.conflicts).not.toEqual({});
    fc.assert(
      fc.property(fc.shuffledSubarray(three, { minLength: three.length }), (shuffled) => {
        expect(merge(shuffled, raceControl, 'Qualifying')).toEqual(reference);
      }),
      { numRuns: 50 },
    );
  });
});
