import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ms, normaliseSession } from '../src/ingest/normalise.ts';
import type { Lap, RaceControl, Session, SessionResult } from '../src/openf1/schemas.ts';
import { type ColourLap, colours } from '../src/timing/colours.ts';
import { markLaps, parseRuling, type RuleLap, type RuleMessage, resolve } from '../src/timing/rules.ts';

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const golden = <T>(name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.golden.json`), 'utf8')) as T[];

const lap = (
  driver_number: number,
  lap_number: number,
  lap_ms: number | null,
  date_start: string | null = null,
): RuleLap => ({
  driver_number,
  lap_number,
  date_start,
  lap_ms,
  deleted: false,
  deleted_reason: null,
  quali_phase: null,
});
const rc = (
  message: string,
  date = '2026-10-24T21:00:00+00:00',
  qualifying_phase: number | null = null,
): RuleMessage => ({
  date,
  qualifying_phase,
  message,
});
const deleted = (laps: RuleLap[]) => laps.filter((l) => l.deleted).map((l) => [l.driver_number, l.lap_number]);

describe('deleted laps', () => {
  // Car 10's lap 2 is 1:36.764 and lap 3 its slow in-lap (11392).
  const car10 = () => [lap(10, 1, null), lap(10, 2, 96_764), lap(10, 3, 130_977)];

  it('the TIME form matches the lap within 1 ms and keeps the reason without the LAP part', () => {
    const laps = car10();
    const message = 'CAR 10 (GAS) TIME 1:36.765 DELETED - TRACK LIMITS AT TURN 9 LAP 3 16:07:14';
    expect(markLaps(laps, [rc(message)], 'Qualifying')).toEqual({
      deleted: 1,
      reinstated: 0,
      unmatched: 0,
      unparsed: 0,
    });
    expect(laps[1]).toMatchObject({ deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 9' });
    expect(deleted(laps)).toEqual([[10, 2]]);
  });

  it('the LAP form, with and without (PIT): LAP n is lap n in a race or sprint, lap n − 1 elsewhere', () => {
    const forms = [
      'CAR 5 (BOR) LAP DELETED - TRACK LIMITS AT TURN 11 LAP 9 16:29:31 (PIT)',
      'CAR 5 (BOR) LAP DELETED - DOUBLE YELLOW AT TURN 12 LAP 9 21:32:22',
    ];
    for (const message of forms) {
      for (const [type, n] of [
        ['Race', 9],
        ['Qualifying', 8],
        ['Practice', 8],
        [null, 8],
      ] as const) {
        const laps = [lap(5, 8, 90_000), lap(5, 9, 91_000)];
        expect(markLaps(laps, [rc(message)], type)).toMatchObject({ deleted: 1, unmatched: 0 });
        expect(deleted(laps)).toEqual([[5, n]]);
      }
    }
    const laps = [lap(5, 9, 91_000)];
    markLaps(laps, [rc(forms[0] ?? '')], 'Race');
    expect(laps[0]?.deleted_reason).toBe('TRACK LIMITS AT TURN 11');
  });

  it('extra and odd whitespace is collapsed first', () => {
    const laps = car10();
    const message = '  CAR 10  (GAS)\tTIME 1:36.764   DELETED -  TRACK  LIMITS AT TURN 9 LAP 3   16:07:14 ';
    expect(markLaps(laps, [rc(message)], 'Qualifying')).toMatchObject({ deleted: 1 });
    expect(laps[1]?.deleted_reason).toBe('TRACK LIMITS AT TURN 9');
  });

  it('a TIME without LAP n ("… (NEXT LAP)") matches by time', () => {
    const next = 'CAR 87 (BEA) TIME 1:15.197 DELETED - TRACK LIMITS AT TURN 8 (NEXT LAP)';
    const one = [lap(87, 3, 75_196), lap(87, 4, 80_000)];
    expect(markLaps(one, [rc(next)], 'Qualifying')).toMatchObject({ deleted: 1 });
    expect(one[0]).toMatchObject({ deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 8 (NEXT LAP)' });
  });

  it('several laps within 1 ms: the one exact match, else the expected lap, else none (owner 2026-10-27)', () => {
    const time = 'CAR 87 (BEA) TIME 1:15.197 DELETED - TRACK LIMITS AT TURN 8';
    const next = `${time} (NEXT LAP)`;
    const withLap = (n: number) => `${time} LAP ${n} 17:16:23`;
    const mark = (laps: RuleLap[], message: string) => {
      markLaps(laps, [rc(message)], 'Qualifying');
      return deleted(laps);
    };
    // 9118 (Austria 2023): laps 7 and 9 of 1:10.597 and 1:10.598.
    const oneExact = () => [lap(87, 3, 75_197), lap(87, 5, 75_198)];
    expect(mark(oneExact(), next)).toEqual([[87, 3]]);
    expect(mark(oneExact(), withLap(6))).toEqual([[87, 3]]); // the exact match beats the expected lap 5
    const noExact = () => [lap(87, 3, 75_196), lap(87, 5, 75_198)];
    expect(mark(noExact(), withLap(6))).toEqual([[87, 5]]);
    expect(mark(noExact(), withLap(9))).toEqual([]); // expected lap 8 is not a candidate
    expect(mark(noExact(), next)).toEqual([]);
    const twoExact = () => [lap(87, 3, 75_197), lap(87, 5, 75_197)];
    expect(mark(twoExact(), withLap(6))).toEqual([[87, 5]]);
    expect(mark(twoExact(), next)).toEqual([]);
    // No lap within 1 ms: LAP n decides.
    expect(mark([lap(87, 5, 80_000)], withLap(6))).toEqual([[87, 5]]);
  });

  it('a lap deleted twice keeps the first reason; a later REINSTATED restores it, an earlier one does not', () => {
    const laps = car10();
    const first = 'CAR 10 (GAS) TIME 1:36.764 DELETED - TRACK LIMITS AT TURN 9 LAP 3 16:07:14';
    const second = 'CAR 10 (GAS) TIME 1:36.764 DELETED - TRACK LIMITS AT TURN 19 LAP 3 16:07:14';
    const back = 'CAR 10 (GAS) TIME 1:36.764 WILL BE REINSTATED';
    // Out of date order on purpose: the rules sort by the parsed date, and 21:00:00.095 > 21:00:00.
    const messages = [
      rc(second, '2026-10-24T21:01:00+00:00'),
      rc(first, '2026-10-24T21:00:00.095000+00:00'),
      rc(back, '2026-10-24T21:00:00+00:00'),
    ];
    expect(markLaps(laps, messages, 'Qualifying')).toEqual({ deleted: 2, reinstated: 0, unmatched: 1, unparsed: 0 });
    expect(laps[1]).toMatchObject({ deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 9' });

    const again = car10();
    expect(markLaps(again, [rc(first), rc(back), rc(second)], 'Qualifying')).toMatchObject({
      deleted: 2,
      reinstated: 1,
    });
    expect(again[1]).toMatchObject({ deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 19' });

    const restored = car10();
    expect(markLaps(restored, [rc(first), rc(back)], 'Qualifying')).toMatchObject({ deleted: 1, reinstated: 1 });
    expect(restored[1]).toMatchObject({ deleted: false, deleted_reason: null });
  });

  it('REINSTATED in the LAP form maps LAP n like DELETED and clears only a deleted lap', () => {
    const laps = [lap(43, 12, 95_000), lap(43, 13, 140_000)];
    const del = 'CAR 43 (COL) LAP DELETED - TRACK LIMITS AT TURN 1 LAP 13 12:49:19 (PIT)';
    const back = 'CAR 43 (COL) LAP 13 WILL BE REINSTATED';
    expect(markLaps(laps, [rc(back), rc(del), rc(back)], 'Practice')).toEqual({
      deleted: 1,
      reinstated: 1,
      unmatched: 1, // the first REINSTATED: nothing deleted yet
      unparsed: 0,
    });
    expect(deleted(laps)).toEqual([]);
  });

  it('a REINSTATED TIME looks only at the deleted laps', () => {
    // Laps 2 and 4 share the time; only lap 4 is deleted (by LAP n), so the TIME is unambiguous.
    const laps = [lap(63, 2, 87_168), lap(63, 4, 87_168)];
    const messages = [
      rc('CAR 63 (RUS) LAP DELETED - TRACK LIMITS AT TURN 1 LAP 5 13:34:18'),
      rc('CAR 63 (RUS) TIME 1:27.168 WILL BE REINSTATED', '2026-10-24T21:01:00+00:00'),
    ];
    expect(markLaps(laps, messages, 'Practice')).toMatchObject({ deleted: 1, reinstated: 1, unmatched: 0 });
    expect(deleted(laps)).toEqual([]);
  });

  it('the recorded REINSTATED session (9832, Practice 1) restores the lap its DELETED message named', () => {
    const messages = golden<RaceControl>('race_control-reinstated');
    expect(messages.map((m) => m.message).filter((m) => m?.includes('REINSTATED'))).toEqual([
      'CAR 63 (RUS) TIME 1:27.168 WILL BE REINSTATED',
    ]);
    const laps = [lap(63, 2, 87_168), lap(63, 3, 120_000)];
    expect(markLaps(laps, messages, 'Practice')).toEqual({ deleted: 1, reinstated: 1, unmatched: 0, unparsed: 0 });
    expect(deleted(laps)).toEqual([]);
  });

  it('a car or a lap not in the session is counted, not applied; unknown forms are unparsed', () => {
    const laps = car10();
    const messages = [
      'CAR 44 (HAM) TIME 1:36.764 DELETED - TRACK LIMITS AT TURN 9 LAP 3 16:07:14', // no car 44
      'CAR 10 (GAS) LAP DELETED - TRACK LIMITS AT TURN 9 LAP 99 16:07:14', // no lap 99 in a race
      'CAR 10 (GAS) LAP DELETED - DOUBLE YELLOW AT TURN 1', // neither TIME nor LAP n
      'CAR 10 (GAS) TIME 1:40.000 WILL BE REINSTATED', // nothing deleted
      'CAR LEC TIME 1:36.518 DELETED - TRACK LIMITS AT TURN 14 (NEXT LAP) (Q1)',
      'CAR 243 TIME 0:00.000 DELETED - DOUBLE YELLOW',
      'CAR 10 (GAS) TIME 1:36.764 REINSTATED',
      'TRACK LIMITS AT TURN 9', // neither keyword: not counted
    ].map((m) => rc(m));
    expect(markLaps(laps, [...messages, { date: null, qualifying_phase: null, message: null }], 'Race')).toEqual({
      deleted: 0,
      reinstated: 0,
      unmatched: 4,
      unparsed: 3,
    });
    expect(deleted(laps)).toEqual([]);
  });

  it('parses both forms into car, time, LAP n and reason', () => {
    expect(parseRuling('CAR 87 (BEA) TIME 1:40.294 DELETED - TRACK LIMITS AT TURN 2 LAP 3 20:07:17')).toEqual({
      kind: 'deleted',
      car: 87,
      time_ms: 100_294,
      lap: 3,
      reason: 'TRACK LIMITS AT TURN 2',
    });
    expect(parseRuling('CAR 27 (HUL) TIME 8:42.988 WILL BE REINSTATED')).toEqual({
      kind: 'reinstated',
      car: 27,
      time_ms: 522_988,
      lap: null,
      reason: null,
    });
    expect(parseRuling('CAR 12 (ANT) LAP DELETED - TRACK LIMITS AT TURN 20 (NEXT LAP PIT)')).toMatchObject({
      time_ms: null,
      lap: null,
      reason: 'TRACK LIMITS AT TURN 20 (NEXT LAP PIT)',
    });
    expect(parseRuling('GREEN LIGHT - PIT EXIT OPEN')).toBeUndefined();
  });
});

// [U] lap linkage (A§9, owner 2026-10-26): in a race or sprint `LAP n` is the driver's lap n,
// elsewhere lap n − 1. Pinned on the fixtures: the lap a TIME-form deletion's time names is the
// lap its LAP n names.
describe('[U] lap linkage', () => {
  const types = new Map(golden<Session>('sessions-year').map((s) => [s.session_key, s.session_type]));
  const cases = [
    ['normal', 11388, ['laps-normal']],
    ['sprint', 11383, ['laps-sprint']],
    ['quali', 11392, ['laps-quali', 'laps-deleted']],
  ] as const;

  it('every TIME-form deletion in the fixtures resolves by time to the lap at the expected index', () => {
    let matched = 0;
    for (const [name, key, lapFixtures] of cases) {
      const type = types.get(key) ?? null;
      const laps = lapFixtures.flatMap((f) =>
        golden<Lap>(f).map((l) => lap(l.driver_number, l.lap_number, ms(l.lap_duration))),
      );
      for (const m of golden<RaceControl>(`race_control-${name}`)) {
        const ruling = parseRuling(m.message ?? '');
        if (typeof ruling !== 'object' || ruling.kind !== 'deleted' || ruling.time_ms === null || ruling.lap === null)
          continue;
        const expected = type === 'Race' ? ruling.lap : ruling.lap - 1;
        const byTime = resolve(laps, { ...ruling, lap: null }, type);
        const kept = laps.some((l) => l.driver_number === ruling.car && l.lap_number === expected);
        if (!kept && byTime === undefined) continue; // the lap was trimmed from the fixture
        expect(byTime?.lap_number, `${name} car ${ruling.car}`).toBe(expected);
        matched++;
      }
    }
    expect(types.get(11392)).toBe('Qualifying');
    expect(matched).toBe(6); // the six cars of laps-deleted (11392 Qualifying)
  });
});

describe('quali phase', () => {
  const phases = [
    rc('SESSION STARTED', '2026-10-24T21:00:00.095000+00:00', 1),
    rc('CHEQUERED FLAG', '2026-10-24T21:18:00+00:00', 1),
    rc('GREEN LIGHT - PIT EXIT OPEN', '2026-10-24T21:25:00+00:00', 2),
    rc('SESSION STARTED', '2026-10-24T21:25:00.107000+00:00', 2),
    rc('CAR 10 (GAS) TIME 1:36.764 DELETED - TRACK LIMITS AT TURN 9 LAP 3 16:07:14', '2026-10-24T21:30:00+00:00'),
  ];
  const phaseOf = (date_start: string | null, messages = phases, type: string | null = 'Qualifying') => {
    const laps = [lap(1, 1, null, date_start)];
    markLaps(laps, messages, type);
    return laps[0]?.quali_phase;
  };

  it('is the phase of the last phase row at or before date_start; a lap on a row takes the new phase', () => {
    expect(phaseOf('2026-10-24T20:59:00+00:00')).toBeNull();
    expect(phaseOf('2026-10-24T21:00:00.095+00:00')).toBe(1);
    expect(phaseOf('2026-10-24T21:20:00+00:00')).toBe(1); // after the flag, before Q2: still Q1
    expect(phaseOf('2026-10-24T21:24:59.999+00:00')).toBe(1);
    expect(phaseOf('2026-10-24T21:25:00+00:00')).toBe(2);
    expect(phaseOf('2026-10-24T21:45:00+00:00')).toBe(2); // a non-phase row changes nothing
  });

  it('is null without a date_start or without phase rows (races and practice)', () => {
    expect(phaseOf(null)).toBeNull();
    expect(phaseOf('2026-10-24T21:30:00+00:00', [rc('GREEN LIGHT - PIT EXIT OPEN')])).toBeNull();
  });

  it('two phase rows with the same date: the later one in input order wins', () => {
    const same = '2026-10-24T21:47:00+00:00';
    expect(phaseOf(same, [rc('A', same, 2), rc('B', same, 3)])).toBe(3);
    expect(phaseOf(same, [rc('B', same, 3), rc('A', same, 2)])).toBe(2);
  });

  // 11230, 11271, 11276, 11282, 11287 (2026): OpenF1 sends Q1's rows without a phase (owner 2026-10-27).
  it('a qualifying session whose first phase row is Q2: the laps before it are Q1', () => {
    const fromQ2 = [rc('SESSION STARTED', '2026-10-24T21:00:00.095000+00:00'), ...phases.slice(2)];
    expect(phaseOf('2026-10-24T21:05:00+00:00', fromQ2)).toBe(1);
    expect(phaseOf('2026-10-24T21:24:59.999+00:00', fromQ2)).toBe(1);
    expect(phaseOf('2026-10-24T21:25:00+00:00', fromQ2)).toBe(2);
    expect(phaseOf(null, fromQ2)).toBeNull();
    // Sprint Qualifying is type Qualifying too; any other type infers nothing.
    for (const type of ['Practice', 'Race', null])
      expect(phaseOf('2026-10-24T21:05:00+00:00', fromQ2, type)).toBeNull();
    // With Q1 rows, a lap before the first one stays without a phase.
    expect(phaseOf('2026-10-24T20:59:00+00:00')).toBeNull();
    // A first row of Q3 is no Q2-only gap.
    expect(phaseOf('2026-10-24T21:05:00+00:00', [rc('SESSION STARTED', '2026-10-24T21:47:00+00:00', 3)])).toBeNull();
  });

  // [U] (A§6.1): per driver and phase, the fastest non-deleted lap is the official Q time. The
  // laps-deleted cars set deleted laps faster than their official time (car 1 in Q3: 1:34.379
  // deleted, 1:35.049 official), so a wrong deletion or phase shows here.
  it('[U] quali phase: per driver and phase, the fastest non-deleted lap equals session_result.duration[p]', () => {
    const { rows, rules } = normaliseSession(
      11392,
      {
        drivers: [],
        laps: [...golden<Lap>('laps-quali'), ...golden<Lap>('laps-deleted')],
        stints: [],
        pit: [],
        race_control: golden<RaceControl>('race_control-quali'),
        session_result: golden<SessionResult>('session_result-quali'),
      },
      'Qualifying',
    );
    expect(rules).toEqual({ deleted: 6, reinstated: 0, unmatched: 2, unparsed: 0 }); // car 5 is not in the fixtures
    const drivers = [...new Set(rows.lap.map((l) => l.driver_number))].sort((a, b) => a - b);
    expect(drivers).toEqual([1, 3, 6, 10, 11, 12, 30, 44, 55, 87]);
    let compared = 0;
    for (const driver of drivers) {
      const official = rows.result.find((r) => r.driver_number === driver)?.durations_ms ?? [];
      for (const p of [1, 2, 3]) {
        const times = rows.lap
          .filter((l) => l.driver_number === driver && l.quali_phase === p && !l.deleted && l.lap_ms !== null)
          .map((l) => l.lap_ms as number);
        const ours = times.length ? Math.min(...times) : null;
        expect(ours, `car ${driver} Q${p}`).toBe(official[p - 1] ?? null);
        if (ours !== null) compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe('colours', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 21, 0, s));
  const cl = (over: Partial<ColourLap> & Pick<ColourLap, 'driver_number' | 'lap_number'>): ColourLap => ({
    date_start: at(over.lap_number),
    lap_ms: null,
    s1_ms: null,
    s2_ms: null,
    s3_ms: null,
    is_pit_out: false,
    is_pit_in: false,
    deleted: false,
    ...over,
  });

  it('purple = the session best, green = each other driver best, yellow = the rest, null = no value', () => {
    const laps = [
      cl({ driver_number: 1, lap_number: 1, lap_ms: 90_000, s1_ms: 30_000 }),
      cl({ driver_number: 1, lap_number: 2, lap_ms: 89_000, s1_ms: 30_500 }),
      cl({ driver_number: 2, lap_number: 1, lap_ms: 89_500, s1_ms: 29_000 }),
      cl({ driver_number: 2, lap_number: 2, lap_ms: 91_000 }),
    ];
    expect(colours(laps)).toEqual([
      { lap: 'yellow', s1: 'green', s2: null, s3: null },
      { lap: 'purple', s1: 'yellow', s2: null, s3: null },
      { lap: 'green', s1: 'purple', s2: null, s3: null },
      { lap: 'yellow', s1: null, s2: null, s3: null },
    ]);
  });

  it('a deleted lap is never purple or green, and neither is an out-lap or an in-lap', () => {
    const laps = [
      cl({ driver_number: 1, lap_number: 1, lap_ms: 80_000, s1_ms: 20_000, deleted: true }),
      cl({ driver_number: 1, lap_number: 2, lap_ms: 81_000, s2_ms: 20_000, is_pit_out: true }),
      cl({ driver_number: 1, lap_number: 3, lap_ms: 82_000, s3_ms: 20_000, is_pit_in: true }),
      cl({ driver_number: 1, lap_number: 4, lap_ms: 90_000, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000 }),
    ];
    expect(colours(laps)).toEqual([
      { lap: 'yellow', s1: 'yellow', s2: null, s3: null },
      { lap: 'yellow', s1: null, s2: 'yellow', s3: null },
      { lap: 'yellow', s1: null, s2: null, s3: 'yellow' },
      { lap: 'purple', s1: 'purple', s2: 'purple', s3: 'purple' },
    ]);
  });

  it('a tie goes to the earlier date_start (nulls last), then the lower lap and driver number', () => {
    const tie = (a: Partial<ColourLap>, b: Partial<ColourLap>) =>
      colours([
        cl({ driver_number: 1, lap_number: 5, lap_ms: 90_000, ...a }),
        cl({ driver_number: 2, lap_number: 5, lap_ms: 90_000, ...b }),
      ]).map((c) => c.lap);
    expect(tie({ date_start: at(9) }, { date_start: at(8) })).toEqual(['green', 'purple']);
    expect(tie({ date_start: null }, { date_start: at(8) })).toEqual(['green', 'purple']);
    expect(tie({ date_start: null, lap_number: 6 }, { date_start: null })).toEqual(['green', 'purple']);
    expect(tie({ date_start: null }, { date_start: null })).toEqual(['purple', 'green']);
    const own = colours([
      cl({ driver_number: 1, lap_number: 2, lap_ms: 90_000, date_start: null }),
      cl({ driver_number: 1, lap_number: 3, lap_ms: 90_000 }),
    ]);
    expect(own.map((c) => c.lap)).toEqual(['yellow', 'purple']);
  });

  // 1–6 drivers × 0–30 laps; values from a small range so ties happen; random out/in/deleted/null.
  const value = fc.option(fc.integer({ min: 1, max: 6 }), { nil: null, freq: 4 });
  const fields = fc.record({
    second: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null, freq: 5 }),
    lap_ms: value,
    s1_ms: value,
    s2_ms: value,
    s3_ms: value,
    is_pit_out: fc.constantFrom(false, false, false, true, null),
    is_pit_in: fc.constantFrom(false, false, false, true),
    deleted: fc.constantFrom(false, false, false, true),
  });
  const session = fc.array(fc.array(fields, { maxLength: 30 }), { minLength: 1, maxLength: 6 }).map((drivers) =>
    drivers.flatMap((laps, d) =>
      laps.map(
        ({ second, ...l }, n): ColourLap => ({
          ...l,
          driver_number: d + 1,
          lap_number: n + 1,
          date_start: second === null ? null : at(second),
        }),
      ),
    ),
  );
  const KEYS = [
    ['lap', 'lap_ms'],
    ['s1', 's1_ms'],
    ['s2', 's2_ms'],
    ['s3', 's3_ms'],
  ] as const;
  const eligible = (l: ColourLap, field: (typeof KEYS)[number][1]) =>
    l[field] !== null && !l.deleted && !l.is_pit_out && !l.is_pit_in;
  const time = (l: ColourLap) => l.date_start?.getTime() ?? Number.POSITIVE_INFINITY;

  it('exactly one purple per field per session (none without an eligible value), at the minimum', () => {
    fc.assert(
      fc.property(session, (laps) => {
        const out = colours(laps);
        for (const [key, field] of KEYS) {
          const ok = laps.filter((l) => eligible(l, field));
          const purple = laps.filter((_, i) => out[i]?.[key] === 'purple');
          expect(purple.length).toBe(ok.length > 0 ? 1 : 0);
          if (purple[0]) {
            const min = Math.min(...ok.map((l) => l[field] as number));
            expect(purple[0][field]).toBe(min);
            // First to set it holds it.
            const first = ok
              .filter((l) => l[field] === min)
              .toSorted(
                (a, b) => time(a) - time(b) || a.lap_number - b.lap_number || a.driver_number - b.driver_number,
              )[0];
            expect(purple[0]).toBe(first);
          }
          for (const driver of new Set(laps.map((l) => l.driver_number))) {
            const own = laps.flatMap((l, i) => (l.driver_number === driver ? [[l, out[i]?.[key]] as const] : []));
            const best = own.filter(([, c]) => c === 'purple' || c === 'green');
            expect(best.length).toBe(own.some(([l]) => eligible(l, field)) ? 1 : 0);
          }
          laps.forEach((l, i) => {
            const c = out[i]?.[key];
            if (l[field] === null) expect(c).toBeNull();
            else if (!eligible(l, field)) expect(c).toBe('yellow');
            else expect(c).not.toBeNull();
          });
        }
      }),
      { numRuns: 500 },
    );
  });

  it('adding a deleted lap, an out-lap or an in-lap faster than everything changes no other colour', () => {
    const flag = fc.constantFrom({ deleted: true }, { is_pit_out: true }, { is_pit_in: true });
    fc.assert(
      fc.property(session, fc.integer({ min: 1, max: 6 }), flag, (laps, driver, which) => {
        const fast = cl({ driver_number: driver, lap_number: 31, lap_ms: 0, s1_ms: 0, s2_ms: 0, s3_ms: 0, ...which });
        const out = colours([...laps, fast]);
        expect(out.slice(0, -1)).toEqual(colours(laps));
        expect(out.at(-1)).toEqual({ lap: 'yellow', s1: 'yellow', s2: 'yellow', s3: 'yellow' });
      }),
      { numRuns: 500 },
    );
  });
});
