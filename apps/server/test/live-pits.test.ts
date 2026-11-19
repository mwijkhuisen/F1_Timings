import { describe, expect, it } from 'vitest';
import { createPits, MAX_PIT_ROWS, pitsSince } from '../src/live/pits.ts';
import type { FeedEvent } from '../src/live/read.ts';

// The pit-lane parser (#219) on synthetic events: every car, lap and time is invented.

const T0 = Date.parse('2026-03-08T05:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const lane = (t: number, times: Record<string, unknown>, full?: true): FeedEvent => ({
  t: T0 + t,
  topic: 'PitLaneTimeCollection',
  payload: { PitTimes: times },
  ...(full && { full }),
});
const series = (t: number, times: Record<string, unknown>): FeedEvent => ({
  t: T0 + t,
  topic: 'PitStopSeries',
  payload: { PitTimes: times },
});
const entry = (car: string, lap: string, duration?: string) => ({
  [car]: { RacingNumber: car, Lap: lap, ...(duration && { Duration: duration }) },
});
const stop = (car: string, lap: string, at: number, laneTime?: string, stopTime?: string) => ({
  Timestamp: iso(at),
  PitStop: { RacingNumber: car, Lap: lap, PitLaneTime: laneTime, PitStopTime: stopTime },
});
const info = (t: number, Key: number): FeedEvent => ({ t: T0 + t, topic: 'SessionInfo', payload: { Key } });
const parse = (events: FeedEvent[], sessionKey?: number) => {
  const pits = createPits(sessionKey);
  for (const ev of events) pits.push(ev);
  return pits.rows();
};

describe('createPits', () => {
  it('a stop: the PLTC entry gives the date, PSS the lane time to the ms and the stationary time', () => {
    const got = parse([
      lane(60_000, entry('44', '20', '22.5')),
      series(61_000, { 44: [stop('44', '20', 60_800, '22.512', '2.4')] }),
      lane(80_000, { _deleted: ['44'] }),
    ]);
    expect(got).toEqual({
      rows: [{ driver_number: 44, lap_number: 20, date: T0 + 60_000, lane_ms: 22_512, stop_ms: 2_400 }],
      skipped: 0,
    });
  });

  it('a drive-through: a PLTC entry without a PSS one has no stop time; the deletion leaves it', () => {
    expect(parse([lane(1000, entry('7', '12', '19.8')), lane(30_000, { _deleted: ['7'] })]).rows).toEqual([
      { driver_number: 7, lap_number: 12, date: T0 + 1000, lane_ms: 19_800, stop_ms: null },
    ]);
  });

  it('PSS alone dates the row by its Timestamp; without either topic there are no rows', () => {
    expect(parse([series(5000, { 1: { 0: stop('1', '30', 4500, '23.001', '3.1') } })]).rows).toEqual([
      { driver_number: 1, lap_number: 30, date: T0 + 4500, lane_ms: 23_001, stop_ms: 3_100 },
    ]);
    expect(parse([{ t: T0, topic: 'TimingData', payload: { Lines: { 44: { InPit: true } } } }])).toEqual({
      rows: [],
      skipped: 0,
    });
  });

  it('a reconnect: the same entry in a later full state keeps its first date and only fills a missing lane time', () => {
    const got = parse([
      lane(10_000, entry('16', '5')),
      lane(10_000, entry('16', '5')), // a replayed line
      lane(25_000, { ...entry('16', '5', '24.3'), ...entry('55', '5', '25.0') }, true),
      lane(40_000, entry('16', '5', '99.9'), true),
    ]);
    expect(got.rows).toEqual([
      { driver_number: 16, lap_number: 5, date: T0 + 10_000, lane_ms: 24_300, stop_ms: null },
      { driver_number: 55, lap_number: 5, date: T0 + 25_000, lane_ms: 25_000, stop_ms: null },
    ]);
  });

  it('PSS stops accumulate across lines; each wins over the PLTC lane time, a missing PitLaneTime keeps it', () => {
    const got = parse([
      lane(1000, entry('4', '18', '21.9')),
      series(1200, { 4: [stop('4', '18', 900, '21.937', '2.2')] }),
      lane(500_000, entry('4', '40', '22.1')),
      series(500_200, { 4: { 1: stop('4', '40', 499_900, undefined, '2.9') } }),
    ]);
    expect(got.rows).toEqual([
      { driver_number: 4, lap_number: 18, date: T0 + 1000, lane_ms: 21_937, stop_ms: 2_200 },
      { driver_number: 4, lap_number: 40, date: T0 + 500_000, lane_ms: 22_100, stop_ms: 2_900 },
    ]);
  });

  it('drops and counts a bad car key, a RacingNumber that is not the key, a bad lap or Timestamp', () => {
    const got = parse([
      lane(1000, {
        x: { RacingNumber: 'x', Lap: '3', Duration: '20.0' },
        1000: { Lap: '3', Duration: '20.0' },
        3: { RacingNumber: '8', Lap: '3', Duration: '20.0' },
        5: { RacingNumber: '5', Lap: '1000', Duration: '20.0' },
        6: { RacingNumber: '6', Lap: 7, Duration: '20.0' },
        9: 'not an entry', // no object: no entry, not counted
      }),
      series(2000, {
        10: [
          { Timestamp: '5Z', PitStop: { RacingNumber: '10', Lap: '4', PitStopTime: '2.0' } },
          { Timestamp: iso(2000), PitStop: { RacingNumber: '11', Lap: '4', PitStopTime: '2.0' } },
          { Timestamp: iso(2000) }, // no PitStop: no lap
        ],
      }),
    ]);
    expect(got).toEqual({ rows: [], skipped: 8 });
  });

  it('a duration that is not over 0 and under 24 h, or no duration, is null; the entry stays', () => {
    const got = parse([
      lane(1000, {
        ...entry('1', '1', '0.000'),
        ...entry('2', '1', '24:00:00.000'),
        ...entry('3', '1', 'soon'),
        ...entry('4', '1', '1040.500'), // a red flag in the pit lane
      }),
      series(2000, { 1: [stop('1', '1', 1500, '-1', '86400')] }),
    ]);
    expect(got.rows.map((r) => [r.driver_number, r.lane_ms, r.stop_ms])).toEqual([
      [1, null, null],
      [2, null, null],
      [3, null, null],
      [4, 1_040_500, null],
    ]);
    expect(got.skipped).toBe(0);
  });
});

describe('createPits with a session key (the shared session gate)', () => {
  const events = [
    lane(100, entry('1', '1', '20.0')), // before any SessionInfo: not the session's
    info(200, 9001), // another session's state
    lane(300, entry('2', '2', '21.0')),
    series(310, { 2: [stop('2', '2', 300, '21.001', '2.0')] }),
    info(400, 9002), // the session's own keyframe
    lane(500, entry('3', '3', '22.0')),
    series(510, { 3: [stop('3', '3', 500, '22.001', '2.1')] }),
    { t: T0 + 600, topic: 'SessionInfo', payload: { Name: 'Race' } } as FeedEvent, // a delta without Key keeps it
    lane(700, entry('4', '4', '23.0')),
    info(800, 9003), // the next session's: closed again
    lane(900, entry('5', '5', '24.0')),
  ];
  it('reads the two topics only while the merged SessionInfo Key is the key', () => {
    expect(parse(events, 9002).rows.map((r) => r.driver_number)).toEqual([3, 4]);
    expect(parse(events, 9002).rows[0]).toMatchObject({ lane_ms: 22_001, stop_ms: 2_100 });
  });
  it('without a key every event is read, a pit line before the first SessionInfo included', () => {
    expect(parse(events).rows.map((r) => r.driver_number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the row cap', () => {
  it(`keeps ${MAX_PIT_ROWS} PLTC entries and counts the rest in skipped`, () => {
    const events: FeedEvent[] = [];
    // 5,001 distinct (car, lap) entries, one per event: car 1-999, lap 0-5.
    for (let i = 0; i <= MAX_PIT_ROWS; i++)
      events.push(lane(i, entry(String((i % 999) + 1), String(Math.floor(i / 999)))));
    const got = parse(events);
    expect(got.rows).toHaveLength(MAX_PIT_ROWS);
    expect(got.skipped).toBe(1);
  });
});

describe('pitsSince', () => {
  it('keeps the rows from an hour before the start on', () => {
    const got = pitsSince(
      [lane(-3_600_001, entry('1', '50', '20.0')), lane(-3_600_000, entry('2', '1', '20.0')), lane(0, entry('3', '1'))],
      T0,
    );
    expect(got.rows.map((r) => r.driver_number)).toEqual([2, 3]);
  });
});
