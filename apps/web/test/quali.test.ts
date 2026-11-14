import { describe, expect, it } from 'vitest';
import { feedReached, margin, phaseName, type Quali, qualiPhases } from '../src/lib/quali.ts';
import { field, lap, result, time } from './laps.ts';

// Synthetic fields only. Car d's best in phase p is (81 − p) s + 10·d ms, so
// car 1 is fastest everywhere and the slowest car through sets each cut-off.

const cutoffs = (q: Quali) => q.phases.map((p) => p.cutoff && [p.cutoff.driver_number, p.cutoff.lap_ms]);
const order = (q: Quali) => q.rows.map((r) => r.driver);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('qualiPhases', () => {
  it('takes 15 then 10 through in a 20-car field', () => {
    const q = qualiPhases(field([20, 15, 10]), []);
    expect(q.phases.map((p) => p.through)).toEqual([15, 10, 0]);
    expect(cutoffs(q)).toEqual([[15, time(15, 1)], [10, time(10, 2)], null]);
    expect(q.phases.at(-1)?.fastest?.lap_ms).toBe(time(1, 3));
    expect(order(q)).toEqual(range(1, 20));
    expect(q.rows.map((r) => r.reached)).toEqual([...Array(10).fill(3), ...Array(5).fill(2), ...Array(5).fill(1)]);
    // One timed lap per phase run; in- and out-laps do not count.
    expect([q.rows[0]?.timed, q.rows[19]?.timed]).toEqual([3, 1]);
  });

  it('takes 16 then 10 through in a 22-car field', () => {
    const q = qualiPhases(field([22, 16, 10]), []);
    expect(q.phases.map((p) => p.through)).toEqual([16, 10, 0]);
    expect(cutoffs(q)).toEqual([[16, time(16, 1)], [10, time(10, 2)], null]);
    expect(order(q)).toEqual(range(1, 22));
  });

  it('gives the margin to the cut-off: inside, on it and out', () => {
    const q = qualiPhases(field([20, 15, 10]), []);
    const [q1, , q3] = q.phases;
    const cell = (d: number, i: number) => q.rows.find((r) => r.driver === d)?.cells[i];
    const at = (d: number, i: number, phase = q1) => {
      const c = cell(d, i);
      return c && phase ? margin(c, phase) : 'missing';
    };
    expect([at(3, 0), at(15, 0), at(16, 0)]).toEqual([-120, 0, 10]);
    // The last phase has no cut-off.
    expect(at(1, 2, q3)).toBeNull();
  });

  it('puts a driver without a time last of its group, with no best and no margin', () => {
    const laps = field([20, 15, 10]).filter((l) => !(l.driver_number === 16 && l.lap_ms !== null && !l.is_pit_in));
    const q = qualiPhases(laps, []);
    const row = q.rows.find((r) => r.driver === 16);
    expect(row?.cells[0]).toEqual({ best: null, deleted: [], ran: true });
    expect(row?.timed).toBe(0);
    expect(order(q).slice(15)).toEqual([17, 18, 19, 20, 16]);
    const q1 = q.phases[0];
    expect(q1 && row?.cells[0] && margin(row.cells[0], q1)).toBeNull();
  });

  it('ignores a faster deleted lap for the best and the cut-off and lists it', () => {
    const del = lap(15, 99, {
      quali_phase: 1,
      lap_ms: 70_000,
      deleted: true,
      deleted_reason: 'TRACK LIMITS AT TURN 4',
    });
    const q = qualiPhases([...field([20, 15, 10]), del], []);
    const row = q.rows.find((r) => r.driver === 15);
    expect(row?.cells[0]?.best?.lap_ms).toBe(time(15, 1));
    expect(row?.cells[0]?.deleted).toEqual([del]);
    expect(row?.timed).toBe(3); // a deleted lap counts as timed
    expect(cutoffs(q)[0]).toEqual([15, time(15, 1)]);
    expect(q.phases[0]?.fastest?.driver_number).toBe(1);
  });

  it('counts a Q3 runner with only an out-lap as through (D1), setting the Q2 cut-off', () => {
    const laps = field([20, 15, 10]).filter((l) => !(l.driver_number === 10 && l.quali_phase === 3 && !l.is_pit_out));
    const q = qualiPhases(laps, []);
    expect(q.phases[1]?.through).toBe(10);
    expect(cutoffs(q)[1]).toEqual([10, time(10, 2)]);
    const row = q.rows.find((r) => r.driver === 10);
    expect([row?.reached, row?.cells[2]?.ran, row?.cells[2]?.best]).toEqual([3, true, null]);
    expect(order(q).slice(0, 10)).toEqual([...range(1, 9), 10]);
  });

  it('orders untimed drivers of a group by result position, then number; includes a result without laps', () => {
    const laps = field([20, 15, 10]).filter((l) => l.driver_number < 18 || l.lap_ms === null || l.is_pit_in);
    const q = qualiPhases(laps, [result(20, 18), result(19, 19), result(18, null), result(30, null)]);
    expect(order(q).slice(15)).toEqual([16, 17, 20, 19, 18, 30]);
    expect(q.rows.at(-1)).toEqual({
      driver: 30,
      cells: [0, 1, 2].map(() => ({ best: null, deleted: [], ran: false })),
      reached: 0,
      timed: 0,
    });
  });

  it('counts a lap without a phase toward timed laps only', () => {
    const q = qualiPhases([lap(4, 1, { lap_ms: 90_000 }), lap(4, 2, { lap_ms: 89_000, quali_phase: 1 })], []);
    expect(q.phases).toHaveLength(1);
    expect(q.rows[0]?.timed).toBe(2);
    expect(q.rows[0]?.cells[0]?.best?.lap_number).toBe(2);
  });

  it('has no phases without phase data', () => {
    expect(qualiPhases([lap(1, 1, { lap_ms: 90_000 })], []).phases).toEqual([]);
  });
});

// #113 D1: the player adds what the feed says (a TimingData line not KnockedOut has reached SessionPart).
describe('qualiPhases with the feed', () => {
  it("raises a driver's phase and the phase count, and the cut-off runs over every driver through", () => {
    // Q1 laps for six cars only; the feed says cars 1, 2 and 4 are in Q2 (car 3 and the others are not).
    const q = qualiPhases(
      field([6]),
      [],
      new Map([
        [1, 2],
        [2, 2],
        [4, 2],
      ]),
    );
    expect(q.phases).toHaveLength(2);
    expect(q.phases[0]?.through).toBe(3);
    expect(cutoffs(q)[0]).toEqual([4, time(4, 1)]);
    expect(q.rows.map((r) => r.reached)).toEqual([2, 2, 2, 1, 1, 1]);
    expect(order(q)).toEqual([1, 2, 4, 3, 5, 6]);
    // No Q2 lap yet: the cells exist and are empty.
    expect(q.rows[0]?.cells[1]).toEqual({ best: null, deleted: [], ran: false });
  });

  it('never lowers a phase the laps show, and gives a feed-only driver a row', () => {
    const q = qualiPhases(
      field([4, 2]),
      [],
      new Map([
        [1, 1],
        [9, 1],
      ]),
    );
    expect(q.rows.find((r) => r.driver === 1)?.reached).toBe(2);
    expect(q.rows.find((r) => r.driver === 9)).toMatchObject({ reached: 1, timed: 0 });
    expect(q.phases).toHaveLength(2);
  });

  it('is the lap-only result with an empty feed', () => {
    expect(qualiPhases(field([5, 3]), [], new Map())).toEqual(qualiPhases(field([5, 3]), []));
    expect(qualiPhases([], [], new Map()).phases).toEqual([]);
  });
});

describe('feedReached', () => {
  const state = (part: number | undefined, type = 'Qualifying') => ({
    SessionInfo: { Key: 1, Type: type },
    TimingData: {
      ...(part === undefined ? {} : { SessionPart: part }),
      Lines: {
        '1': { Line: 1 },
        '2': { Line: 2, KnockedOut: true },
        '3': { Line: 3, KnockedOut: false },
        _kf: true,
        x1: {},
      },
    },
  });

  it('maps every line that is not knocked out to the current part, numeric keys only', () => {
    expect(feedReached(state(2))).toEqual(
      new Map([
        [1, 2],
        [3, 2],
      ]),
    );
  });

  it('is empty outside qualifying, at SessionPart 0 and without one', () => {
    expect(feedReached(state(2, 'Race')).size).toBe(0);
    expect(feedReached(state(0)).size).toBe(0);
    expect(feedReached(state(undefined)).size).toBe(0);
    expect(feedReached({}).size).toBe(0);
  });

  it('ignores a SessionPart above 3 (a hostile recording would size every row)', () => {
    expect(feedReached(state(3)).size).toBe(2);
    expect(feedReached(state(4)).size).toBe(0);
    expect(feedReached(state(100_000_000)).size).toBe(0);
  });
});

describe('phaseName', () => {
  it('names sprint qualifying phases SQ, the 2023 Sprint Shootout included', () => {
    expect([
      phaseName('Sprint Qualifying', 1),
      phaseName('Sprint Shootout', 3),
      phaseName('Qualifying', 3),
      phaseName(null, 2),
    ]).toEqual(['SQ1', 'SQ3', 'Q3', 'Q2']);
  });
});
