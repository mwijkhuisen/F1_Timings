import { describe, expect, it } from 'vitest';
import {
  afterForecastFailure,
  afterForecastSuccess,
  ceilHour,
  FORECAST_REFRESH_MS,
  floorHour,
  forecastQuery,
  opensAt,
} from '../src/rain/forecast.ts';

// The weekend forecast's pure parts (#120): the window (C1), the query (C2) and the transitions (C5).

const d = (iso: string) => new Date(iso);
const iso = (t: Date | null) => t?.toISOString() ?? null;
const CLOSE = d('2026-11-22T06:00:00Z'); // Las Vegas 2026: the race ends

describe('forecast (pure)', () => {
  it.each([
    ['a Friday (Las Vegas FP1)', '2026-11-20T00:30:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Friday (Lusail FP1)', '2026-11-27T13:30:00Z', '2026-11-25T00:00:00.000Z'],
    ['a Friday (Yas Marina FP1)', '2026-12-04T09:30:00Z', '2026-12-02T00:00:00.000Z'],
    ['a Thursday, just before midnight', '2026-11-19T23:59:59Z', '2026-11-18T00:00:00.000Z'],
    ['a Wednesday at 00:00', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Wednesday at 23:59', '2026-11-18T23:59:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Saturday', '2026-11-21T04:00:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Sunday', '2026-11-22T04:00:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Tuesday', '2026-11-24T10:00:00Z', '2026-11-18T00:00:00.000Z'],
    ['a Friday across a year end', '2027-01-01T10:00:00Z', '2026-12-30T00:00:00.000Z'],
  ])('opensAt: %s → the Wednesday on or before it, 00:00 UTC', (_, first, opens) => {
    expect(opensAt(d(first)).toISOString()).toBe(opens);
  });

  it('floorHour and ceilHour', () => {
    const t = Date.parse('2026-11-20T00:30:00Z');
    expect(new Date(floorHour(t)).toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(new Date(ceilHour(t)).toISOString()).toBe('2026-11-20T01:00:00.000Z');
    expect(ceilHour(Date.parse('2026-11-22T06:00:00Z'))).toBe(Date.parse('2026-11-22T06:00:00Z'));
  });

  it('forecastQuery: one point with 4 decimals, the four hourly variables over the UTC hours, unixtime, m/s, land', () => {
    expect(
      forecastQuery(36.1167, -115.1666, Date.parse('2026-11-20T00:00:00Z'), Date.parse('2026-11-22T06:00:00Z')),
    ).toEqual({
      latitude: '36.1167',
      longitude: '-115.1666',
      hourly: 'precipitation_probability,precipitation,temperature_2m,wind_speed_10m',
      start_hour: '2026-11-20T00:00',
      end_hour: '2026-11-22T06:00',
      timeformat: 'unixtime',
      timezone: 'GMT',
      wind_speed_unit: 'ms',
      cell_selection: 'land',
    });
    expect(forecastQuery(25.49, 51.4537, 0, 0)).toMatchObject({ latitude: '25.4900', longitude: '51.4537' });
  });

  it('forecastQuery refuses a window off the hour or reversed', () => {
    const from = Date.parse('2026-11-20T00:00:00Z');
    const to = Date.parse('2026-11-22T06:00:00Z');
    expect(() => forecastQuery(0, 0, from + 60_000, to)).toThrow(RangeError);
    expect(() => forecastQuery(0, 0, from, to + 1)).toThrow(RangeError);
    expect(() => forecastQuery(0, 0, to, from)).toThrow(RangeError);
  });

  it('afterForecastSuccess: live 3 h on, final once that reaches the close', () => {
    const next = afterForecastSuccess({ fetch_count: 4 }, d('2026-11-18T00:00:00Z'), CLOSE);
    expect({ ...next, next_fetch_at: iso(next.next_fetch_at) }).toEqual({
      state: 'live',
      next_fetch_at: '2026-11-18T03:00:00.000Z',
      fetch_count: 5,
      fail_count: 0,
      last_error: null,
    });
    expect(FORECAST_REFRESH_MS).toBe(3 * 3_600_000);
    expect(iso(afterForecastSuccess({ fetch_count: 0 }, d('2026-11-22T02:59:59.999Z'), CLOSE).next_fetch_at)).toBe(
      '2026-11-22T05:59:59.999Z',
    );
    expect(afterForecastSuccess({ fetch_count: 33 }, d('2026-11-22T03:00:00Z'), CLOSE)).toEqual({
      state: 'final',
      next_fetch_at: null,
      fetch_count: 34,
      fail_count: 0,
      last_error: null,
    });
  });

  it('afterForecastFailure: 5 min · 2^(n−1) up to 6 h, the 9th → failed; a retry at or past the close → final', () => {
    const at = d('2026-11-18T00:00:00Z');
    let f = { fetch_count: 1, fail_count: 0 };
    const delays: number[] = [];
    for (let n = 1; n <= 8; n++) {
      const next = afterForecastFailure(f, at, 'http_500', CLOSE);
      expect(next).toMatchObject({ state: 'live', fail_count: n, fetch_count: 1, last_error: 'http_500' });
      delays.push(((next.next_fetch_at?.getTime() ?? 0) - at.getTime()) / 60_000);
      f = next;
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(afterForecastFailure(f, at, 'timeout', CLOSE)).toEqual({
      state: 'failed',
      next_fetch_at: null,
      fetch_count: 1,
      fail_count: 9,
      last_error: 'timeout',
    });
    const first = { fetch_count: 1, fail_count: 0 };
    expect(iso(afterForecastFailure(first, d('2026-11-22T05:54:59.999Z'), 'schema', CLOSE).next_fetch_at)).toBe(
      '2026-11-22T05:59:59.999Z',
    );
    expect(afterForecastFailure(first, d('2026-11-22T05:55:00Z'), 'schema', CLOSE)).toEqual({
      state: 'final',
      next_fetch_at: null,
      fetch_count: 1,
      fail_count: 1,
      last_error: 'schema',
    });
  });
});
