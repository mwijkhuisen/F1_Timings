import { describe, expect, it } from 'vitest';
import { type FactSession, facts, main, report } from '../scripts/rules-facts.ts';

const lap = (driver_number: number, lap_number: number, lap_ms: number | null, over: object = {}) => ({
  driver_number,
  lap_number,
  date_start: null,
  lap_ms,
  deleted: true, // facts() resets these
  deleted_reason: 'stale',
  quali_phase: 9,
  is_pit_out: false,
  ...over,
});
const at = (minute: number) => `2026-10-24T21:${String(minute).padStart(2, '0')}:00+00:00`;
const rc = (minute: number, message: string, qualifying_phase: number | null = null) => ({
  date: at(minute),
  qualifying_phase,
  message,
});

describe('rules-facts', () => {
  it('refuses to run under CI, before any connection', async () => {
    const lines: string[] = [];
    // An unreachable URL: reaching for it would fail the offline guard, not return 1.
    expect(await main({ CI: 'true', DATABASE_URL: 'postgres://u:p@192.0.2.1/db' }, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual(['rules-facts refuses to run under CI (A§12.1 invariant 4)']);
  });

  it('exits 64 without DATABASE_URL', async () => {
    expect(await main({}, () => {})).toBe(64);
  });

  // Car 1: lap 2 = 91000 and lap 3 = 91001 (within 1 ms), the rest distinct.
  const race: FactSession = {
    session_key: 1,
    type: 'Race',
    laps: [1, 2, 3, 4, 5, 6].map((n) => lap(1, n, [100000, 91000, 91001, 95000, 96000, 97000][n - 1] ?? null)),
    results: [],
    race_control: [
      rc(1, 'CAR 1 (VER) TIME 1:40.000 DELETED - TRACK LIMITS LAP 1 10:00:00'), // time and LAP n, unique
      rc(2, 'CAR 1 (VER) TIME 1:31.000 DELETED - TRACK LIMITS'), // time only, exact among several
      rc(3, 'CAR 1 (VER) LAP DELETED - TRACK LIMITS LAP 4 10:05:00'), // LAP form, by LAP n
      rc(4, 'CAR 1 (VER) LAP DELETED - TRACK LIMITS LAP 99 10:05:00'), // LAP form, no lap
      rc(5, 'CAR 1 (VER) TIME 3:00.000 DELETED - TRACK LIMITS'), // time only, no lap
      rc(6, 'CAR 1 (VER) TIME 1:40.000 WILL BE REINSTATED'), // reinstated time, unique
      rc(7, 'CAR 1 (VER) LAP 4 WILL BE REINSTATED'), // reinstated lap, by LAP n
      rc(8, 'CAR 243 TIME 0:00.000 DELETED - DOUBLE YELLOW'), // unparsed
      rc(9, 'GREEN LIGHT - PIT EXIT OPEN'), // no ruling
    ],
  };

  it('counts every form against every outcome and lists the sessions with a message naming no lap', () => {
    const f = facts([race, { ...race, session_key: 2, race_control: [] }]);
    const zero = { 'unique time': 0, 'exact time among several': 0, 'LAP n': 0, 'no lap': 0 };
    expect(f.forms).toEqual({
      'deleted, time and LAP n': { ...zero, 'unique time': 1 },
      'deleted, time only': { ...zero, 'exact time among several': 1, 'no lap': 1 },
      'deleted, LAP form': { ...zero, 'LAP n': 1, 'no lap': 1 },
      'reinstated, time': { ...zero, 'unique time': 1 },
      'reinstated, lap': { ...zero, 'LAP n': 1 },
      unparsed: { ...zero, 'no lap': 1 },
    });
    expect(f.unresolved).toEqual([1]);
    expect(f.phases.map((p) => p.equal + p.differs + p.noLap + p.noOfficial)).toEqual([0, 0, 0]);
    // A report carries counts and keys only.
    expect(report(f).join('\n')).toMatch(/^\(a\)[\s\S]*sessions with a message naming no lap: 1\n/);
  });

  it('per qualifying phase: equal, differs, no lap, no official time; deleted, out and in laps do not count', () => {
    // Phase rows: Q1 from minute 0, Q2 from minute 20, Q3 from minute 40. Laps start inside a phase.
    const quali: FactSession = {
      session_key: 7,
      type: 'Qualifying',
      race_control: [rc(0, 'SESSION STARTED', 1), rc(20, 'SESSION STARTED', 2), rc(40, 'SESSION STARTED', 3)],
      laps: [
        // Car 1: Q1 equal (80000 beats the deleted 70000 and the out-lap 60000); in-lap 50000 (lap 3) ignored.
        lap(1, 1, 60000, { date_start: at(1), is_pit_out: true }),
        lap(1, 2, 80000, { date_start: at(3) }),
        lap(1, 3, 50000, { date_start: at(5) }), // an in-lap: lap 4 is an out-lap
        lap(1, 4, 99000, { date_start: at(21), is_pit_out: true }),
        // Q2: 85000 against official 84000: differs. Q3: no lap, official present.
        lap(1, 5, 85000, { date_start: at(23) }),
        // Car 2: Q1 a lap but no official time.
        lap(2, 1, 90000, { date_start: at(2) }),
        // Car 3: official in Q1 only, no laps at all (a driver without laps): no lap.
      ],
      results: [
        { driver_number: 1, durations_ms: [80000, 84000, 70000] },
        { driver_number: 2, durations_ms: null },
        { driver_number: 3, durations_ms: [88000] },
      ],
    };
    // Car 1's lap 2 is deleted by a message in the first variant only.
    const f = facts([quali]);
    expect(f.phases.map(({ equal, differs, noLap, noOfficial }) => ({ equal, differs, noLap, noOfficial }))).toEqual([
      { equal: 1, differs: 0, noLap: 1, noOfficial: 1 },
      { equal: 0, differs: 1, noLap: 0, noOfficial: 0 },
      { equal: 0, differs: 0, noLap: 1, noOfficial: 0 },
    ]);
    expect(f.phases[1]?.sessions).toEqual([7]);

    const deletes = {
      ...quali,
      race_control: [...quali.race_control, rc(30, 'CAR 1 (VER) TIME 1:20.000 DELETED - TRACK LIMITS')],
    };
    expect(facts([deletes]).phases[0]).toMatchObject({ equal: 0, differs: 0, noLap: 2 });
  });
});
