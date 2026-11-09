import { describe, expect, it } from 'vitest';
import {
  compass,
  fmtRange,
  headLine,
  leaderLap,
  periodText,
  rainPeriods,
  summarise,
  type WeatherRow,
} from '../src/lib/weather.ts';
import { lap } from './laps.ts';

// lib/weather.ts (P5a): the summary, the rain periods, the compass and the leader's lap, on synthetic samples.

const T0 = Date.parse('2026-10-11T12:00:00Z'); // 14:00 in Amsterdam (CEST)
const MIN = 60_000;
/** A sample `m` minutes after T0, all values null unless given. */
const w = (m: number, over: Partial<WeatherRow> = {}): WeatherRow => ({
  date: new Date(T0 + m * MIN).toISOString(),
  air_temperature: null,
  track_temperature: null,
  humidity: null,
  pressure: null,
  rainfall: null,
  wind_direction: null,
  wind_speed: null,
  ...over,
});

describe('compass', () => {
  it.each([
    [0, 'N'],
    [359, 'N'],
    [22.4, 'N'],
    [22.5, 'NE'],
    [45, 'NE'],
    [90, 'E'],
    [135, 'SE'],
    [180, 'S'],
    [225, 'SW'],
    [270, 'W'],
    [315, 'NW'],
    [337, 'NW'],
    [338, 'N'],
    [360, 'N'],
    [-10, 'N'],
  ])('%s° is %s', (deg, point) => {
    expect(compass(deg)).toBe(point);
  });
});

describe('summarise', () => {
  it('gives the min–max of air, track, humidity and pressure, the wind mean and max, and the prevailing point', () => {
    const s = summarise([
      w(0, {
        air_temperature: 24.1,
        track_temperature: 38,
        humidity: 62,
        pressure: 1009.9,
        wind_speed: 1,
        wind_direction: 170,
        rainfall: 0,
      }),
      w(1, {
        air_temperature: 27.3,
        track_temperature: 45.2,
        humidity: 70,
        pressure: 1010,
        wind_speed: 2,
        wind_direction: 359,
        rainfall: 0,
      }),
      w(2, { air_temperature: 25, track_temperature: 40, wind_speed: 3, wind_direction: 185, rainfall: 0 }),
    ]);
    expect(s).toEqual({
      air: { min: 24.1, max: 27.3 },
      track: { min: 38, max: 45.2 },
      humidity: { min: 62, max: 70 },
      pressure: { min: 1009.9, max: 1010 },
      wind: { mean: 2, max: 3 },
      direction: 'S',
      rain: 'dry',
    });
  });

  it('skips nulls in each value, and says rain when any sample had rainfall > 0', () => {
    const s = summarise([
      w(0, { air_temperature: 20, rainfall: 0 }),
      w(1, { rainfall: 1 }),
      w(2, { air_temperature: 22 }),
    ]);
    expect(s.air).toEqual({ min: 20, max: 22 });
    expect(s.rain).toBe('rain');
    expect(s.track).toBeNull();
  });

  it('is null in every part when every value is null, and for no rows at all', () => {
    const none = { air: null, track: null, humidity: null, pressure: null, wind: null, direction: null, rain: null };
    expect(summarise([w(0), w(1)])).toEqual(none);
    expect(summarise([])).toEqual(none);
  });

  it('gives a tie in the prevailing point to the point seen first', () => {
    const s = summarise([
      w(0, { wind_direction: 90 }),
      w(1, { wind_direction: 0 }),
      w(2, { wind_direction: 0 }),
      w(3, { wind_direction: 95 }),
    ]);
    expect(s.direction).toBe('E');
  });
});

describe('rainPeriods', () => {
  it('is empty without a wet sample', () => {
    expect(rainPeriods([w(0, { rainfall: 0 }), w(1, { rainfall: 0 })])).toEqual([]);
  });

  it('joins consecutive wet samples; a dry sample, a sample without a reading or a gap over 5 min ends a period', () => {
    const rows = [
      w(0, { rainfall: 1 }),
      w(1, { rainfall: 1 }),
      w(2, { rainfall: 0 }), // dry: ends the first
      w(3, { rainfall: 1 }),
      w(4, { rainfall: null }), // no reading: ends the second
      w(5, { rainfall: 1 }),
      w(10, { rainfall: 1 }), // 5 min after: still the same period
      w(16, { rainfall: 1 }), // 6 min after: a gap, a new period
      w(17, { rainfall: 2 }),
    ];
    expect(rainPeriods(rows)).toEqual([
      { from: T0, to: T0 + MIN },
      { from: T0 + 3 * MIN, to: T0 + 3 * MIN },
      { from: T0 + 5 * MIN, to: T0 + 10 * MIN },
      { from: T0 + 16 * MIN, to: T0 + 17 * MIN },
    ]);
  });

  it('reads the samples in date order, whatever order they come in', () => {
    expect(rainPeriods([w(1, { rainfall: 1 }), w(0, { rainfall: 1 })])).toEqual([{ from: T0, to: T0 + MIN }]);
  });
});

describe('leaderLap', () => {
  // Lap n starts at T0 + n min for car 1; car 2 is a lap behind from lap 3 on, and one lap 1 has no date_start.
  const laps = [
    lap(1, 1, { date_start: new Date(T0 + MIN).toISOString() }),
    lap(1, 2, { date_start: new Date(T0 + 2 * MIN).toISOString() }),
    lap(1, 3, { date_start: new Date(T0 + 3 * MIN).toISOString() }),
    lap(2, 1, { date_start: null }),
    lap(2, 2, { date_start: new Date(T0 + 2.5 * MIN).toISOString() }),
  ];

  it('is null before the first lap starts', () => {
    expect(leaderLap(laps, T0, 'Race')).toBeNull();
    expect(leaderLap(laps, T0 + MIN - 1, 'Race')).toBeNull();
  });

  it('is the highest lap any driver has started, from its start on', () => {
    expect(leaderLap(laps, T0 + MIN, 'Race')).toBe(1);
    expect(leaderLap(laps, T0 + 2.7 * MIN, 'Race')).toBe(2);
  });

  it('stays on the last lap after the flag', () => {
    expect(leaderLap(laps, T0 + 90 * MIN, 'Race')).toBe(3);
  });

  it('is null outside Race-type sessions, and without laps', () => {
    for (const type of ['Qualifying', 'Practice', null]) expect(leaderLap(laps, T0 + 90 * MIN, type)).toBeNull();
    expect(leaderLap([], T0 + 90 * MIN, 'Race')).toBeNull();
  });
});

describe('the words', () => {
  it('formats a range, or one value when both ends read the same', () => {
    expect(fmtRange({ min: 24.06, max: 27.34 }, 1)).toBe('24.1–27.3');
    expect(fmtRange({ min: 30.04, max: 29.96 }, 1)).toBe('30.0');
    expect(fmtRange({ min: 1009.9, max: 1010 }, 0)).toBe('1010');
  });

  it('heads the session with air and track rounded and the rain in words; null when nothing is known', () => {
    const base = summarise([
      w(0, { air_temperature: 24.4, track_temperature: 38.2, rainfall: 0 }),
      w(1, { air_temperature: 26.6, track_temperature: 45.4, rainfall: 0 }),
    ]);
    expect(headLine(base)).toBe('Air 24–27 °C · Track 38–45 °C · Dry');
    expect(headLine({ ...base, rain: 'rain' })).toBe('Air 24–27 °C · Track 38–45 °C · Rain at times');
    expect(headLine({ ...base, air: null, rain: null })).toBe('Track 38–45 °C');
    expect(headLine(summarise([]))).toBeNull();
    expect(headLine(summarise([w(0, { humidity: 80 })]))).toBeNull();
  });

  it('names a rain period in Amsterdam time, with the leader’s laps in a race only', () => {
    const laps = [1, 2, 3, 4].map((n) => lap(1, n, { date_start: new Date(T0 + n * 10 * MIN).toISOString() }));
    const at = (from: number, to: number) => ({ from: T0 + from * MIN, to: T0 + to * MIN });
    expect(periodText(at(12, 25), laps, 'Race')).toBe('14:12–14:25 · laps 1–2');
    expect(periodText(at(-30, 5), laps, 'Race')).toBe('13:30–14:05 · before the start');
    expect(periodText(at(-30, 15), laps, 'Race')).toBe('13:30–14:15 · lap 1');
    expect(periodText(at(-30, 31), laps, 'Race')).toBe('13:30–14:31 · laps 1–3');
    expect(periodText(at(12, 12), laps, 'Race')).toBe('14:12 · lap 1');
    expect(periodText(at(12, 25), laps, 'Qualifying')).toBe('14:12–14:25');
    expect(periodText(at(12, 25), null, 'Race')).toBe('14:12–14:25');
  });
});
