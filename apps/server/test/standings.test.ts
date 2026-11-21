import { Standings } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import {
  type StandingsSeason,
  type StandingsSession,
  standings,
  standingsMismatches,
} from '../src/timing/standings.ts';

// Synthetic seasons (invented people and teams). Session keys are also the day of the month, so key order is date order.
const session = (session_key: number, name = 'Race', over: Partial<StandingsSession> = {}): StandingsSession => ({
  session_key,
  source: 'openf1',
  type: 'Race',
  name,
  date_start: new Date(Date.UTC(2030, 2, session_key, 15)),
  meeting_name: `Meeting ${session_key}`,
  is_cancelled: false,
  ...over,
});
const driver = (session_key: number, driver_number: number, full_name: string, team_name = 'Alpha') => ({
  session_key,
  driver_number,
  full_name,
  acronym: full_name.slice(0, 3).toUpperCase(),
  team_name,
  team_colour: team_name === 'Alpha' ? 'AA0000' : '0000BB',
});
const result = (session_key: number, driver_number: number, position: number | null, points: number | null) => ({
  session_key,
  driver_number,
  position,
  points,
});
const start = (session_key: number, driver_number: number, points_start: number) => ({
  session_key,
  driver_number,
  points_start,
});
const season = (over: Partial<StandingsSeason>): StandingsSeason => ({
  year: 2030,
  sessions: [],
  drivers: [],
  results: [],
  championship_drivers: [],
  championship_teams: [],
  ...over,
});
const NOW = Date.UTC(2030, 5, 1); // mid-season: no finale is settled yet (#214)
const points = (s: Standings) => Object.fromEntries(s.drivers.map((d) => [d.full_name, d.points]));
const places = (s: Standings) => s.drivers.map((d) => [d.position, d.full_name]);

// Ana and Ben drive both races; OpenF1 gave Ana's win 0 points in race 1 (as in 7779 and 9213, A§6.1).
const healed = season({
  sessions: [session(1), session(2), session(3)],
  drivers: [1, 2].flatMap((k) => [driver(k, 1, 'Ana'), driver(k, 2, 'Ben', 'Beta')]),
  results: [result(1, 1, 1, 0), result(1, 2, 2, 18), result(2, 1, 3, 15), result(2, 2, 1, 25)],
  championship_drivers: [start(1, 1, 0), start(1, 2, 0), start(2, 1, 25), start(2, 2, 18)],
  championship_teams: [
    { session_key: 2, team_name: 'Alpha', points_start: 25 },
    { session_key: 2, team_name: 'Beta', points_start: 18 },
  ],
});

describe('standings (A§9)', () => {
  it('heals a stale session_result with the next session points_start', () => {
    const s = standings(healed, 1, NOW);
    expect(Standings.parse(s)).toEqual(s);
    expect(points(s)).toEqual({ Ana: 25, Ben: 18 });
    expect(s.drivers[0]).toMatchObject({ full_name: 'Ana', position: 1, change: null, session_points: 25 });
    expect(s.provisional).toBe(false);
  });

  it('falls back to the sum without the next session rows, provisional', () => {
    // Race 3 exists but has no rows yet: race 2's standing is race 1's plus race 2's points.
    const s = standings(healed, 2, NOW);
    expect(points(s)).toEqual({ Ana: 40, Ben: 43 });
    expect(s.drivers.map((d) => [d.full_name, d.position, d.change, d.session_points])).toEqual([
      ['Ben', 1, 1, 25],
      ['Ana', 2, -1, 15],
    ]);
    expect(s.provisional).toBe(true);
    // A mid-season fallback (race 3 has no rows yet) is never settled by the date (#214).
    expect(standings(healed, 2, Date.UTC(2035, 0, 1)).provisional).toBe(true);
    expect(s.rounds.map((r) => [r.session_key, r.drivers])).toEqual([
      [
        1,
        [
          { full_name: 'Ana', points: 25 },
          { full_name: 'Ben', points: 18 },
        ],
      ],
      [
        2,
        [
          { full_name: 'Ben', points: 43 },
          { full_name: 'Ana', points: 40 },
        ],
      ],
    ]);
  });

  it('settles the season finale from 1 January (UTC) of the next year, and nothing else (#214)', () => {
    // Race 3 is the last counted session: no next session will ever settle its fallback.
    const running = standings(healed, 3, NOW);
    expect(running.provisional).toBe(true);
    expect(standings(healed, 3, Date.UTC(2030, 11, 31, 23, 59, 59, 999))).toEqual(running);
    const settled = standings(healed, 3, Date.UTC(2031, 0, 1));
    expect(settled).toEqual({ ...running, provisional: false });
  });

  it('carries a person absent from the next session rows', () => {
    // Cy scores 2 in race 1 and leaves: the endpoint drops him from race 2 and 3.
    const s = season({
      ...healed,
      drivers: [...healed.drivers, driver(1, 3, 'Cy', 'Beta')],
      results: [...healed.results, result(1, 3, 9, 2)],
      championship_drivers: [...healed.championship_drivers, start(1, 3, 0), start(3, 1, 43), start(3, 2, 43)],
    });
    expect(points(standings(s, 1, NOW))).toEqual({ Ana: 25, Ben: 18, Cy: 2 });
    expect(points(standings(s, 2, NOW))).toEqual({ Ana: 43, Ben: 43, Cy: 2 });
  });

  it('maps a number through the season driver rows, not the session alone', () => {
    // Dee's only driver row is a practice session's; race 1's rows lack her number.
    const s = season({
      ...healed,
      sessions: [session(0, 'Practice 1', { type: 'Practice' }), ...healed.sessions],
      drivers: [...healed.drivers, driver(0, 7, 'Dee', 'Beta')],
      results: [...healed.results, result(1, 7, 3, 15)],
      championship_drivers: [...healed.championship_drivers, start(2, 7, 15)],
    });
    expect(points(standings(s, 1, NOW))).toEqual({ Ana: 25, Ben: 18, Dee: 15 });
  });

  it('joins one person with two numbers', () => {
    // Eli is #38 for Alpha in race 1, misses race 2 and is #50 for Beta in race 3; the endpoint gives one row.
    const s = season({
      sessions: [session(1), session(2), session(3), session(4)],
      drivers: [driver(1, 38, 'Eli'), driver(2, 2, 'Ben', 'Beta'), driver(3, 50, 'Eli', 'Beta')],
      results: [result(1, 38, 7, 6), result(2, 2, 1, 25), result(3, 50, 10, 1)],
      championship_drivers: [start(2, 2, 0), start(3, 2, 25), start(3, 50, 6), start(4, 50, 7)],
    });
    const after3 = standings(s, 3, NOW);
    expect(points(after3)).toEqual({ Ben: 25, Eli: 7 });
    expect(after3.drivers.find((d) => d.full_name === 'Eli')).toMatchObject({
      team_names: ['Beta', 'Alpha'],
      team_colour: '0000BB',
      session_points: 1,
    });
    expect(points(standings(s, 2, NOW))).toEqual({ Ben: 25, Eli: 6 });
  });

  it('sums two championship rows of one person in a session', () => {
    // Should OpenF1 split Eli's standing over his two numbers: 4 + 2, neither row alone (A§9).
    const s = season({
      sessions: [session(1), session(2)],
      drivers: [driver(1, 38, 'Eli'), driver(2, 50, 'Eli')],
      results: [result(1, 38, 7, 6)],
      championship_drivers: [start(2, 38, 4), start(2, 50, 2)],
    });
    expect(points(standings(s, 1, NOW))).toEqual({ Eli: 6 });
  });

  it('credits team points to the session team', () => {
    // Fay and Gus swap teams between race 1 and the sprint.
    const s = season({
      sessions: [session(1), session(2, 'Sprint')],
      drivers: [driver(1, 1, 'Fay'), driver(1, 2, 'Gus', 'Beta'), driver(2, 1, 'Fay', 'Beta'), driver(2, 2, 'Gus')],
      results: [result(1, 1, 1, 25), result(1, 2, 2, 18), result(2, 1, 1, 8), result(2, 2, 2, 7)],
    });
    const after = standings(s, 2, NOW);
    expect(after.teams.map((t) => [t.position, t.team_name, t.points, t.session_points, t.change])).toEqual([
      [1, 'Alpha', 32, 7, 0],
      [2, 'Beta', 26, 8, 0],
    ]);
    expect(after.drivers[0]?.team_names).toEqual(['Beta', 'Alpha']);
    expect(after.rounds[0]?.teams).toEqual([
      { team_name: 'Alpha', points: 25 },
      { team_name: 'Beta', points: 18 },
    ]);
  });

  it('breaks a points tie on race results only, not sprints', () => {
    // Hal and Ivo both have 23: Hal a race second, Ivo a race third and a sprint win.
    const s = season({
      sessions: [session(1), session(2, 'Sprint')],
      drivers: [1, 2].flatMap((k) => [driver(k, 1, 'Ivo'), driver(k, 2, 'Hal', 'Beta')]),
      results: [result(1, 2, 2, 18), result(1, 1, 3, 15), result(2, 1, 1, 8), result(2, 2, 4, 5)],
    });
    expect(places(standings(s, 2, NOW))).toEqual([
      [1, 'Hal'],
      [2, 'Ivo'],
    ]);
  });

  it('shares the position of a full tie, listed by name', () => {
    // Zoe and Abe are both disqualified (a null position counts nothing); Kit's 12th place still counts.
    const s = season({
      sessions: [session(1)],
      drivers: [driver(1, 1, 'Jo'), driver(1, 2, 'Zoe'), driver(1, 3, 'Abe', 'Beta'), driver(1, 4, 'Kit', 'Beta')],
      results: [result(1, 1, 1, 25), result(1, 2, null, 0), result(1, 3, null, 0), result(1, 4, 12, null)],
    });
    expect(places(standings(s, 1, NOW))).toEqual([
      [1, 'Jo'],
      [2, 'Kit'],
      [3, 'Abe'],
      [3, 'Zoe'],
    ]);
  });

  it('never counts a cancelled session, another source or another type', () => {
    const s = season({
      ...healed,
      sessions: [
        session(1),
        session(2, 'Race', { is_cancelled: true }),
        session(3, 'Race', { source: 'jolpica' }),
        session(4, 'Qualifying', { type: 'Qualifying' }),
        session(5),
      ],
      results: [...healed.results, result(5, 1, 1, 25)],
      // Race 1's standing comes from race 5, the next counted session, never the cancelled race 2.
      championship_drivers: [start(2, 1, 99), start(3, 1, 99), start(4, 1, 99), start(5, 1, 20), start(5, 2, 5)],
    });
    expect(points(standings(s, 1, NOW))).toEqual({ Ana: 20, Ben: 5 });
    expect(standings(s, 5, NOW).rounds.map((r) => r.session_key)).toEqual([1, 5]);
    for (const key of [2, 3, 4, 6])
      expect(standings(s, key, NOW)).toEqual({ drivers: [], teams: [], rounds: [], provisional: false });
    expect(standings({ ...healed, year: 2022 }, 1, NOW).drivers).toEqual([]);
  });

  it('never counts a later session, nor lists a person who first appears in it', () => {
    const before = standings(healed, 1, NOW);
    // Race 2's results, a newcomer in race 2 (with a 0 points_start) and everything about race 3 change nothing.
    const later = season({
      ...healed,
      drivers: [...healed.drivers, driver(2, 9, 'Neo', 'Beta'), driver(3, 9, 'Neo', 'Gamma')],
      results: [
        ...healed.results.filter((r) => r.session_key === 1),
        result(2, 1, 20, 0),
        result(2, 9, 1, 25),
        result(3, 9, 1, 25),
      ],
      championship_drivers: [...healed.championship_drivers, start(2, 9, 0), start(3, 9, 25), start(3, 1, 0)],
      championship_teams: [...healed.championship_teams, { session_key: 3, team_name: 'Gamma', points_start: 25 }],
    });
    expect(standings(later, 1, NOW)).toEqual(before);
    expect(before.drivers.map((d) => d.full_name)).toEqual(['Ana', 'Ben']);
  });
});

describe('standingsMismatches (A§10)', () => {
  it('counts the people whose next points_start disagrees with the session points, newest first', () => {
    const s = season({
      ...healed,
      drivers: [...healed.drivers, driver(1, 3, 'Cy', 'Beta'), driver(2, 4, 'Dee', 'Beta')],
      results: [...healed.results, result(1, 3, 9, 2), result(2, 4, 11, 0)],
      championship_drivers: [
        ...healed.championship_drivers,
        // Cy is only in race 1's rows (carried), Dee only in race 3's (her 15 is not race 2's alone): neither counts.
        start(1, 3, 0),
        start(3, 4, 15),
        // Race 2 → 3: Ana's 15 is right, Ben's 25 became 24 (a penalty).
        start(3, 1, 40),
        start(3, 2, 42),
      ],
    });
    expect(standingsMismatches(s)).toEqual([
      { session_key: 2, year: 2030, meeting_name: 'Meeting 2', session_name: 'Race', rows: 1 },
      { session_key: 1, year: 2030, meeting_name: 'Meeting 1', session_name: 'Race', rows: 1 },
    ]);
    expect(standingsMismatches({ ...s, championship_drivers: healed.championship_drivers.slice(0, 2) })).toEqual([]);
  });
});
