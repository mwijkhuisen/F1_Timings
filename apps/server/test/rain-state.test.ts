import { describe, expect, it } from 'vitest';
import {
  afterRainFailure,
  afterRainSuccess,
  apiFor,
  frameWindow,
  inLiveWindow,
  type RainCode,
  rainErrorCode,
} from '../src/rain/state.ts';

const d = (iso: string) => new Date(iso);
const S = { date_start: d('2026-11-15T13:00:00Z'), date_end: d('2026-11-15T15:00:00Z'), is_cancelled: false };
const iso = (ms: number | Date | null) => (ms === null ? null : new Date(ms).toISOString());

describe('rain state (pure)', () => {
  it('inLiveWindow: start − 30 min in, end + 30 min out; cancelled and > 12 h open none', () => {
    expect(inLiveWindow(S, d('2026-11-15T12:29:59.999Z'))).toBe(false);
    expect(inLiveWindow(S, d('2026-11-15T12:30:00Z'))).toBe(true);
    expect(inLiveWindow(S, d('2026-11-15T15:29:59.999Z'))).toBe(true);
    expect(inLiveWindow(S, d('2026-11-15T15:30:00Z'))).toBe(false);
    expect(inLiveWindow({ ...S, is_cancelled: true }, d('2026-11-15T14:00:00Z'))).toBe(false);
    const long = { ...S, date_end: d('2026-11-16T01:00:01Z') };
    expect(inLiveWindow(long, d('2026-11-15T14:00:00Z'))).toBe(false);
    expect(inLiveWindow({ ...long, date_end: d('2026-11-16T01:00:00Z') }, d('2026-11-15T14:00:00Z'))).toBe(true);
  });

  it('frameWindow: from floor15(start − 60 min); a forecast to floor15(now), a historical to ceil15(end + 30 min)', () => {
    const odd = { date_start: d('2026-11-15T13:05:00Z'), date_end: d('2026-11-15T14:58:00Z') };
    const mid = frameWindow(odd, d('2026-11-15T13:44:59Z'), 'forecast');
    expect([iso(mid.from), iso(mid.to)]).toEqual(['2026-11-15T12:00:00.000Z', '2026-11-15T13:30:00.000Z']);
    const late = frameWindow(odd, d('2026-11-15T19:00:00Z'), 'forecast');
    expect(iso(late.to)).toBe('2026-11-15T15:30:00.000Z');
    const final = frameWindow(odd, d('2026-11-16T15:00:00Z'), 'historical');
    expect([iso(final.from), iso(final.to)]).toEqual(['2026-11-15T12:00:00.000Z', '2026-11-15T15:30:00.000Z']);
  });

  it('apiFor: forecast until date_end + 24 h, historical from then on', () => {
    expect(apiFor(S, d('2026-11-16T14:59:59.999Z'))).toBe('forecast');
    expect(apiFor(S, d('2026-11-16T15:00:00Z'))).toBe('historical');
  });

  it('afterRainSuccess: +15 min inside the window, end + 24 h past it, final after the historical fetch', () => {
    const g = { date_end: S.date_end, fetch_count: 2 };
    const inside = afterRainSuccess(g, d('2026-11-15T15:15:00Z'), 'forecast');
    expect({ ...inside, next_fetch_at: iso(inside.next_fetch_at) }).toEqual({
      state: 'live',
      next_fetch_at: '2026-11-15T15:30:00.000Z',
      fetch_count: 3,
      fail_count: 0,
      last_error: null,
    });
    expect(iso(afterRainSuccess(g, d('2026-11-15T15:15:01Z'), 'forecast').next_fetch_at)).toBe(
      '2026-11-16T15:00:00.000Z',
    );
    expect(afterRainSuccess(g, d('2026-11-16T15:00:00Z'), 'historical')).toEqual({
      state: 'final',
      next_fetch_at: null,
      fetch_count: 3,
      fail_count: 0,
      last_error: null,
    });
  });

  it('afterRainFailure: 5, 10, 20, 40, 80, 160, 320, 360 min, then the 9th failure → failed', () => {
    const at = d('2026-11-15T14:00:00Z');
    let g = { fetch_count: 1, fail_count: 0 };
    const delays: number[] = [];
    for (let n = 1; n <= 8; n++) {
      const next = afterRainFailure(g, at, 'http_500');
      expect(next).toMatchObject({ state: 'live', fail_count: n, fetch_count: 1, last_error: 'http_500' });
      delays.push(((next.next_fetch_at?.getTime() ?? 0) - at.getTime()) / 60_000);
      g = next;
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(afterRainFailure(g, at, 'timeout')).toEqual({
      state: 'failed',
      next_fetch_at: null,
      fetch_count: 1,
      fail_count: 9,
      last_error: 'timeout',
    });
  });

  it('rainErrorCode: the client errors → fixed codes', () => {
    const cases: [Parameters<typeof rainErrorCode>[0], RainCode][] = [
      [{ code: 'http', status: 500 }, 'http_500'],
      [{ code: 'http', status: 400 }, 'http_400'],
      [{ code: 'http', status: 429 }, 'rate_limited'],
      [{ code: 'rate_limited' }, 'rate_limited'],
      [{ code: 'timeout' }, 'timeout'],
      [{ code: 'network' }, 'network'],
      [{ code: 'schema' }, 'schema'],
    ];
    for (const [error, code] of cases) expect(rainErrorCode(error)).toBe(code);
  });
});
