import type { Lap, Stints } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import {
  type Cycle,
  closingAt,
  cycleText,
  lapOneGains,
  PIT_WINDOW,
  pitCycles,
  runningOrder,
  stops,
} from '../src/lib/crossings.ts';
import type { Mark } from '../src/lib/replay.ts';
import { lap, rc } from './laps.ts';

// The race story (#115): the running order, lap-1 gains, stops, pit cycles and the live closing trend, all from the
// times each car crosses the line.

const T0 = Date.parse('2026-10-25T20:00:00Z');
/** Epoch ms and ISO of `s` seconds after T0, rounded to the ms. */
const ms = (s: number) => T0 + Math.round(s * 1000);
const at = (s: number) => new Date(ms(s)).toISOString();

/** Car d's laps from its lap-1 start (s after T0) and lap times (s), each lap starting where the last one ended. */
const drive = (d: number, start: number, times: number[], extra: Record<number, Partial<Lap>> = {}): Lap[] => {
  let s = start;
  return times.map((t, i) => {
    const l = lap(d, i + 1, { date_start: at(s), lap_ms: Math.round(t * 1000), ...extra[i + 1] });
    s += t;
    return l;
  });
};
/** In-lap n and out-lap n + 1 flags. */
const pit = (n: number): Record<number, Partial<Lap>> => ({ [n]: { is_pit_in: true }, [n + 1]: { is_pit_out: true } });
const stint = (driver_number: number, stint_number: number, lap_start: number): Stints[number] => ({
  driver_number,
  stint_number,
  lap_start,
  lap_end: null,
  compound: null,
  tyre_age_at_start: null,
});
const orders = (laps: Lap[]) => runningOrder(laps).map((r) => r.order);

describe('runningOrder', () => {
  it('ranks by crossing time, a tie by driver number', () => {
    // 4 starts 1 s behind at 89.5 s laps: behind after lap 1, level after lap 2, ahead after lap 3.
    const laps = [...drive(1, 0, [90, 90, 90]), ...drive(4, 1, [89.5, 89.5, 89.5]), ...drive(11, 2, [90, 90, 90])];
    expect(runningOrder(laps)).toEqual([
      { lap: 1, order: [1, 4, 11], missing: [] },
      { lap: 2, order: [1, 4, 11], missing: [] },
      { lap: 3, order: [4, 1, 11], missing: [] },
    ]);
  });

  it('keeps a car without a crossing out of the order, the others in their order', () => {
    // 4 has a lap 3 row (so it completed lap 2), but no lap-3 start and no lap-2 time: when it crossed is unknown.
    const laps = [
      ...drive(1, 0, [90, 90, 90, 90]),
      ...drive(4, 1, [90, 90, 90, 90], { 2: { lap_ms: null }, 3: { date_start: null } }),
      ...drive(11, 2, [90, 90, 90, 90]),
    ];
    const rows = runningOrder(laps);
    expect(rows[1]).toEqual({ lap: 2, order: [1, 11], missing: [4] });
    // Lap 3 ends at lap 4's start: ranked again.
    expect(rows[2]).toEqual({ lap: 3, order: [1, 4, 11], missing: [] });
  });

  it('puts a lapped car behind by laps completed, also when it takes the flag a lap down', () => {
    // 1 wins at 540 s after 6 laps; 11 finishes its 6th at 558 s; 4 (110 s laps) crosses after its 5th at 550 s,
    // before 11's finish, and ends a lap down.
    const laps = [
      ...drive(1, 0, Array(6).fill(90)),
      ...drive(4, 0, Array(5).fill(110)),
      ...drive(11, 0, Array(6).fill(93)),
    ];
    const rows = runningOrder(laps);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.order)).toEqual(Array(6).fill([1, 11, 4]));
    expect(rows[5]?.missing).toEqual([]);
  });

  it('drops a car that pits behind the cars it lost the time to, not the others', () => {
    // 1 leads by 1 s, then its in-lap (lap 2) and out-lap (lap 3) cost 25 s: behind 4 and 11, still ahead of 22.
    const laps = [
      ...drive(1, 0, [90, 100, 105, 90, 90], pit(2)),
      ...drive(4, 1, Array(5).fill(90)),
      ...drive(11, 2, Array(5).fill(90)),
      ...drive(22, 60, Array(5).fill(90)),
    ];
    expect(orders(laps)).toEqual([
      [1, 4, 11, 22],
      [4, 11, 1, 22],
      [4, 11, 1, 22],
      [4, 11, 1, 22],
      [4, 11, 1, 22],
    ]);
  });

  it('keeps a retired car behind by laps completed', () => {
    // 4 runs second, starts lap 3 and stops: lap 3 has a start but no time and no lap 4 follows.
    const laps = [
      ...drive(1, 0, Array(5).fill(90)),
      ...drive(4, 1, [90, 90, 90]).map((l) => (l.lap_number === 3 ? { ...l, lap_ms: null } : l)),
      ...drive(11, 2, Array(5).fill(90)),
    ];
    expect(orders(laps)).toEqual([
      [1, 4, 11],
      [1, 4, 11],
      [1, 11, 4],
      [1, 11, 4],
      [1, 11, 4],
    ]);
    expect(runningOrder(laps).every((r) => r.missing.length === 0)).toBe(true);
  });

  it('on the newest lap of a live replay, ranks a car still on it behind those that crossed', () => {
    // 11 leads after lap 2, then is still on lap 3 (no time yet) when 1 and 4 have started lap 4. Nobody has completed
    // lap 4: no row for it (it would repeat lap 3's).
    const laps = [
      ...drive(11, 0, [89, 89, 89]).map((l) => (l.lap_number === 3 ? { ...l, lap_ms: null } : l)),
      ...drive(1, 1, [90, 90, 90, 90]).map((l) => (l.lap_number === 4 ? { ...l, lap_ms: null } : l)),
      ...drive(4, 2, [90, 90, 90, 90]).map((l) => (l.lap_number === 4 ? { ...l, lap_ms: null } : l)),
    ];
    expect(orders(laps)).toEqual([
      [11, 1, 4],
      [11, 1, 4],
      [1, 4, 11],
    ]);
  });

  it("drops OpenF1's cool-down rows: a start and no time past the last lap", () => {
    const laps = [...drive(1, 0, [90, 90, 90]), ...drive(4, 1, [90, 90, 90])].concat(
      lap(1, 4, { date_start: at(270) }),
      lap(4, 4, { date_start: at(271) }),
    );
    expect(runningOrder(laps).map((r) => r.lap)).toEqual([1, 2, 3]);
  });

  it('lists a car that never crossed the line in neither list', () => {
    const laps = [...drive(1, 0, [90, 90]), lap(99, 1, { date_start: at(0) })];
    expect(runningOrder(laps)).toEqual([
      { lap: 1, order: [1], missing: [] },
      { lap: 2, order: [1], missing: [] },
    ]);
  });
});

describe('lapOneGains', () => {
  it('is the grid position − the position after lap 1, skipping a car without a grid position', () => {
    const laps = [
      ...drive(4, 0, [90]),
      ...drive(1, 1, [90]),
      ...drive(11, 2, [90]),
      ...drive(16, 3, [90]),
      ...drive(22, 4, [90]),
    ];
    const row1 = runningOrder(laps)[0];
    expect(row1?.order).toEqual([4, 1, 11, 16, 22]);
    // 16 starts from the pit lane (0), 22 has no grid row.
    const grid = new Map([
      [1, 1],
      [11, 2],
      [4, 3],
      [16, 0],
    ]);
    expect(lapOneGains(row1, grid)).toEqual(
      new Map([
        [4, 2],
        [1, -1],
        [11, -1],
      ]),
    );
  });

  it('is empty when lap 1 is incomplete or unknown', () => {
    const grid = new Map([[1, 1]]);
    expect(lapOneGains({ lap: 1, order: [1], missing: [4] }, grid).size).toBe(0);
    expect(lapOneGains(undefined, grid).size).toBe(0);
  });
});

describe('stops', () => {
  it('reads a stop from a stint starting after the in-lap or on it, never a drive-through', () => {
    const laps = [1, 10, 25, 40].map((n) => lap(1, n, { is_pit_in: true }));
    const stints = [
      stint(1, 1, 1), // lap 1's in-lap: stint 1 is not a new one
      stint(1, 2, 11), // in-lap 10, the stint from 11
      stint(1, 3, 25), // in-lap 25, OpenF1 numbering the stint from the in-lap
      stint(4, 2, 41), // another car's stint after lap 40
    ];
    expect(stops(1, laps, stints)).toEqual([10, 25]);
    expect(stops(4, laps, stints)).toEqual([]);
  });
});

// VER (1) runs 1.2 s behind NOR (4), pits first (in-lap 4) and comes out ahead: an in-lap of 100 s, an out-lap of
// 105 s, then 88 s laps on new tyres. 44 is a third car.
const times = (n: number, inLap: number) =>
  Array.from({ length: n }, (_, i) => (i + 1 < inLap ? 90 : i + 1 === inLap ? 100 : i === inLap ? 105 : 88));
const ver = (extra: Record<number, Partial<Lap>> = {}) => drive(1, 1.2, times(12, 4), { ...pit(4), ...extra });
const nor = (inLap = 6) => drive(4, 0, times(12, inLap), pit(inLap));
const stintsFor = (norIn = 6) => [stint(1, 1, 1), stint(1, 2, 5), stint(4, 1, 1), stint(4, 2, norIn + 1)];
const ACR: Record<number, string> = { 1: 'VER', 4: 'NOR' };
const acronym = (n: number) => ACR[n] ?? String(n);

describe('pitCycles', () => {
  const laps = [...ver(), ...nor()];

  it('gives the gaps before the first in-lap and after the second out-lap', () => {
    // Before: after lap 3, VER 271.2 s, NOR 270 s. After lap 7: VER 652.2 s, NOR 655 s.
    const cycles = pitCycles(1, 4, laps, stintsFor(), [], []);
    expect(cycles).toEqual([{ first: 1, second: 4, firstIn: 4, secondIn: 6, before: 1200, after: -2800 }]);
    // b pitting first is the first driver.
    expect(pitCycles(4, 1, laps, stintsFor(), [], [])).toEqual(cycles);
    expect(cycleText(cycles[0] as Cycle, acronym)).toBe(
      'VER pitted L4, NOR L6: VER 1.2 s behind before, 2.8 s ahead after (undercut)',
    );
  });

  it('pairs stops at most PIT_WINDOW in-laps apart; on the same in-lap a is first', () => {
    expect(PIT_WINDOW).toBe(3);
    expect(pitCycles(1, 4, [...ver(), ...nor(7)], stintsFor(7), [], [])).toHaveLength(1);
    expect(pitCycles(1, 4, [...ver(), ...nor(8)], stintsFor(8), [], [])).toEqual([]);
    const same = pitCycles(4, 1, [...ver(), ...nor(4)], stintsFor(4), [], []);
    expect(same.map((c) => [c.first, c.second, c.firstIn, c.secondIn])).toEqual([[4, 1, 4, 4]]);
  });

  it('is not comparable with an SC, VSC or red flag in the leader laps firstIn − 1 … secondIn + 2', () => {
    // In-laps 4 and 6: the before line is after lap 3, the after line after lap 7 (the leader's lap 7 or 8).
    const reason = (kind: 'sc' | 'vsc' | 'red', from: number, to: number) =>
      pitCycles(1, 4, laps, stintsFor(), [{ kind, from, to }], [])[0]?.reason;
    expect(reason('sc', 7, 9)).toEqual({ kind: 'period', period: 'sc' });
    expect(reason('vsc', 2, 4)).toEqual({ kind: 'period', period: 'vsc' });
    expect(reason('red', 5, 5)).toEqual({ kind: 'period', period: 'red' });
    expect(reason('sc', 1, 3)).toEqual({ kind: 'period', period: 'sc' }); // ends at firstIn − 1
    expect(reason('sc', 1, 2)).toBeUndefined(); // ends at firstIn − 2
    expect(reason('sc', 8, 9)).toEqual({ kind: 'period', period: 'sc' }); // starts at secondIn + 2
    expect(reason('sc', 9, 10)).toBeUndefined(); // starts at secondIn + 3
  });

  it('counts an SC on the laps just before the first in-lap', () => {
    // SC on laps 20–22, VER in on lap 23, NOR on 24: the before line (after lap 22) is under the SC.
    const late = [...drive(1, 1.2, times(30, 23), pit(23)), ...drive(4, 0, times(30, 24), pit(24))];
    const st = [stint(1, 1, 1), stint(1, 2, 24), stint(4, 1, 1), stint(4, 2, 25)];
    expect(pitCycles(1, 4, late, st, [{ kind: 'sc', from: 20, to: 22 }], [])[0]?.reason).toEqual({
      kind: 'period',
      period: 'sc',
    });
  });

  it('is not comparable without a crossing', () => {
    // VER's lap 8 has no start and lap 7 no time: its crossing after lap 7 is unknown.
    const holed = [...ver({ 7: { lap_ms: null }, 8: { date_start: null } }), ...nor()];
    const [c] = pitCycles(1, 4, holed, stintsFor(), [], []);
    expect(c).toMatchObject({ before: 1200, after: null, reason: { kind: 'crossing' } });
    // The first reason that applies: a period before the crossing.
    expect(pitCycles(1, 4, holed, stintsFor(), [{ kind: 'sc', from: 5, to: 5 }], [])[0]?.reason).toEqual({
      kind: 'period',
      period: 'sc',
    });
  });

  it('is not comparable with a penalty naming either car between the lines, by date', () => {
    // The window: after lap 3 (NOR 270 s) to after lap 7 (NOR 655 s).
    const reason = (message: string, s: number) =>
      pitCycles(1, 4, laps, stintsFor(), [], [rc(5, message, { date: at(s) })])[0]?.reason;
    const penalty = { kind: 'penalty' };
    expect(reason('FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 4 (NOR) - UNSAFE RELEASE', 400)).toEqual(penalty);
    // A single-digit car, and a time in brackets after it.
    expect(
      reason(
        'FIA STEWARDS: PENALTY SERVED - 10 SECOND TIME PENALTY FOR CAR 1 (VER) - CAUSING A COLLISION (12:34:56)',
        655,
      ),
    ).toEqual(penalty);
    expect(reason('INCIDENT INVOLVING CAR 1 (VER) NOTED - FAILING TO SERVE TIME PENALTY CORRECTLY', 270)).toEqual(
      penalty,
    );
    // Outside the window.
    expect(reason('FIA STEWARDS: 10 SECOND STOP/GO PENALTY FOR CAR 4 (NOR) - FALSE START', 269)).toBeUndefined();
    expect(reason('FIA STEWARDS: 10 SECOND STOP/GO PENALTY FOR CAR 4 (NOR) - FALSE START', 656)).toBeUndefined();
    // A third car: 44 and 14 are not 4.
    expect(
      reason('FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - SPEEDING IN THE PIT LANE', 400),
    ).toBeUndefined();
    expect(
      reason('INCIDENT INVOLVING CAR 14 (ALO) NOTED - FAILING TO SERVE TIME PENALTY CORRECTLY', 400),
    ).toBeUndefined();
    // Not a penalty.
    expect(reason('INCIDENT INVOLVING CAR 1 (VER) NOTED - TRACK LIMITS', 400)).toBeUndefined();
  });
});

describe('cycleText', () => {
  const c = (before: number | null, after: number | null, extra: Partial<Cycle> = {}): Cycle => ({
    first: 1,
    second: 4,
    firstIn: 22,
    secondIn: 24,
    before,
    after,
    ...extra,
  });
  const text = (cycle: Cycle) => cycleText(cycle, acronym);

  it('says who was behind or ahead before and after, and names an undercut or overcut', () => {
    expect(text(c(1200, -800))).toBe('VER pitted L22, NOR L24: VER 1.2 s behind before, 0.8 s ahead after (undercut)');
    expect(text(c(-1200, 800))).toBe('VER pitted L22, NOR L24: VER 1.2 s ahead before, 0.8 s behind after (overcut)');
    expect(text(c(1200, 800))).toBe('VER pitted L22, NOR L24: VER 1.2 s behind before, 0.8 s behind after');
    expect(text(c(30, -800))).toBe('VER pitted L22, NOR L24: VER level before, 0.8 s ahead after');
    expect(text(c(300, 500, { secondIn: 22 }))).toBe(
      'VER and NOR pitted L22: VER 0.3 s behind before, 0.5 s behind after',
    );
    // On the same in-lap a swap is no undercut or overcut.
    expect(text(c(1200, -800, { secondIn: 22 }))).toBe(
      'VER and NOR pitted L22: VER 1.2 s behind before, 0.8 s ahead after',
    );
    expect(text(c(-1200, 800, { secondIn: 22 }))).toBe(
      'VER and NOR pitted L22: VER 1.2 s ahead before, 0.8 s behind after',
    );
  });

  it('says why a cycle is not comparable', () => {
    const why = (reason: Cycle['reason']) => text(c(1200, null, reason ? { reason } : {}));
    const head = 'VER pitted L22, NOR L24: not comparable';
    expect(why({ kind: 'period', period: 'sc' })).toBe(`${head} (safety car in the window)`);
    expect(why({ kind: 'period', period: 'vsc' })).toBe(`${head} (VSC in the window)`);
    expect(why({ kind: 'period', period: 'red' })).toBe(`${head} (red flag in the window)`);
    expect(why({ kind: 'crossing' })).toBe(`${head} (a line crossing is missing)`);
    expect(why({ kind: 'penalty' })).toBe(`${head} (a penalty names VER or NOR in the window)`);
  });
});

describe('closingAt', () => {
  // NOR (4) leads at 90 s laps. VER (1) starts 10 s back at 89.5 s for 5 laps, then 91 s. 11 starts 20 s back at
  // 90.3 s. Crossings: NOR 90·m; VER 10 + 89.5·m to lap 5 (457.5 s), then 548.5, 639.5, 730.5; 11 20 + 90.3·m.
  const order = [4, 1, 11];
  const verTimes = [89.5, 89.5, 89.5, 89.5, 89.5, 91, 91, 91];
  const field = (verExtra: Record<number, Partial<Lap>> = {}, norExtra: Record<number, Partial<Lap>> = {}) => [
    ...drive(4, 0, Array(8).fill(90), norExtra),
    ...drive(1, 10, verTimes, verExtra),
    ...drive(11, 20, Array(8).fill(90.3)),
  ];
  const END = ms(800);
  const trends = (laps: Lap[], T: number, bands: Mark[] = []) =>
    Object.fromEntries([...closingAt(laps, order, T, bands)].map(([d, t]) => [d, [t.one, t.three]]));

  it('gives the change of the interval over 1 and 3 laps, from crossings at or before T only', () => {
    // At 500 s, lap 5 is the last line every car crossed: VER closes 0.5 s a lap, 11 drops 0.8 s a lap.
    expect(trends(field(), ms(500))).toEqual({
      1: [{ delta: -500 }, { delta: -1500 }],
      11: [{ delta: 800 }, { delta: 2400 }],
    });
    // The same laps at the end: VER drops 1 s a lap, 11 closes 0.7 s a lap.
    expect(trends(field(), END)).toEqual({
      1: [{ delta: 1000 }, { delta: 3000 }],
      11: [{ delta: -700 }, { delta: -2100 }],
    });
  });

  it('has no entry for the leader, and is blank before lap n − k exists', () => {
    expect(closingAt(field(), order, END, []).has(4)).toBe(false);
    // At 195 s VER has crossed twice (99.5 s, 189 s), 11 once (110.3 s; the second at 200.6 s).
    expect(trends(field(), ms(195))).toEqual({ 1: [{ delta: -500 }, null], 11: [null, null] });
  });

  it('names the first lap without a crossing, lap n first', () => {
    // VER's crossing after lap 5 is unknown: no lap-6 start, no lap-5 time.
    expect(trends(field({ 5: { lap_ms: null }, 6: { date_start: null } }), END)[1]).toEqual([
      { delta: 1000 },
      { missing: 5 },
    ]);
    // NOR's last lap has no time: VER's lap 8 has no car ahead to compare with.
    expect(trends(field({}, { 8: { lap_ms: null } }), END)[1]).toEqual([{ missing: 8 }, { missing: 8 }]);
  });

  it('takes n as the last lap completed by T, so a car whose crossing after it is unknown is missing there', () => {
    // At 500 s VER has rows 1–6 (lap 6's start unknown, so in by T) and no lap-5 time: lap 5 is completed, its
    // crossing unknown. Not a delta from lap 4.
    expect(trends(field({ 5: { lap_ms: null }, 6: { date_start: null } }), ms(500))[1]).toEqual([
      { missing: 5 },
      { missing: 5 },
    ]);
  });

  it('is blank across an in- or out-lap of either car', () => {
    // VER's in-lap 5 and out-lap 6: inside 6 … 8 (three laps), not lap 8 alone.
    expect(trends(field(pit(5)), END)).toEqual({
      1: [{ delta: 1000 }, null],
      11: [{ delta: -700 }, null],
    });
  });

  it('is blank across an SC, VSC or red band, an open one running to T', () => {
    // A closed SC at 600–610 s: inside the three-lap windows (from 450 s), before the one-lap ones (from 630 s).
    expect(trends(field(), END, [{ kind: 'sc', t: ms(600), end: ms(610) }])).toEqual({
      1: [{ delta: 1000 }, null],
      11: [{ delta: -700 }, null],
    });
    // An open VSC from 400 s runs to T, over every window.
    expect(trends(field(), END, [{ kind: 'vsc', t: ms(400), open: true }])).toEqual({
      1: [null, null],
      11: [null, null],
    });
    // A red flag ended before the windows; start and chequered marks blank nothing.
    expect(
      trends(field(), END, [
        { kind: 'red', t: ms(100), end: ms(440) },
        { kind: 'start', t: ms(0) },
        { kind: 'chequered', t: ms(720) },
      ]),
    ).toEqual(trends(field(), END));
  });
});
