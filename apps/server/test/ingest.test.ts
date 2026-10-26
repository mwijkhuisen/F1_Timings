import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterFailure, afterSuccess, busyGuard, errorCode, firstFetchAt, type Progress } from '../src/ingest/state.ts';

const MIN = 60_000;
const end = new Date('2026-10-11T14:00:00Z');
const at = (ms: number) => new Date(end.getTime() + ms);
const fresh = { date_end: end, fetch_count: 0, fail_count: 0 };

describe('state machine (fake clock)', () => {
  it('a synced session is due at end + 35 min, not at + 34:59', () => {
    const next = firstFetchAt(end);
    expect(next).toEqual(at(35 * MIN));
    expect(next && next > at(35 * MIN - 1000)).toBe(true);
    expect(firstFetchAt(null)).toBeNull();
  });

  it('fetches at + 35 min, + 3 h and + 24 h, then is final', () => {
    const s1 = afterSuccess(fresh, at(35 * MIN));
    expect(s1).toEqual({
      ingest_state: 'fetched',
      next_fetch_at: at(180 * MIN),
      fetch_count: 1,
      fail_count: 0,
      last_error: null,
    });
    const s2 = afterSuccess({ date_end: end, ...s1 }, at(180 * MIN));
    expect(s2).toMatchObject({ ingest_state: 'fetched', next_fetch_at: at(24 * 60 * MIN), fetch_count: 2 });
    const s3 = afterSuccess({ date_end: end, ...s2 }, at(24 * 60 * MIN));
    expect(s3).toMatchObject({ ingest_state: 'final', next_fetch_at: null, fetch_count: 3 });
  });

  it('a session older than 24 h (the backfill) is final after one fetch', () => {
    expect(afterSuccess(fresh, at(400 * 24 * 60 * MIN))).toMatchObject({ ingest_state: 'final', fetch_count: 1 });
  });

  it('a success without date_end (refetch only) is fetched and never due', () => {
    expect(afterSuccess({ date_end: null, fetch_count: 0 }, at(0))).toMatchObject({
      ingest_state: 'fetched',
      next_fetch_at: null,
    });
  });

  it('backs off 5, 10, 20, 40, 80, 160, 320, 360 min, then fails; a success resets', () => {
    let s: Pick<Progress, 'fetch_count' | 'fail_count'> = { fetch_count: 1, fail_count: 0 };
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const next = afterFailure(s, 'http_500', at(0));
      expect(next).toMatchObject({ ingest_state: 'due', fail_count: i + 1, fetch_count: 1, last_error: 'http_500' });
      delays.push(((next.next_fetch_at?.getTime() ?? 0) - end.getTime()) / MIN);
      s = next;
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    const failed = afterFailure(s, 'timeout', at(0));
    expect(failed).toEqual({
      ingest_state: 'failed',
      next_fetch_at: null,
      fetch_count: 1,
      fail_count: 9,
      last_error: 'timeout',
    });
    expect(afterSuccess({ date_end: end, ...failed }, at(35 * MIN))).toMatchObject({
      ingest_state: 'fetched',
      fail_count: 0,
      last_error: null,
      fetch_count: 2,
    });
  });

  it('maps P1a errors to the D5 codes', () => {
    expect(errorCode({ code: 'http', status: 429 })).toBe('rate_limited');
    expect(errorCode({ code: 'http', status: 401 })).toBe('http_401');
    expect(errorCode({ code: 'timeout' })).toBe('timeout');
    expect(errorCode({ code: 'network' })).toBe('network');
    expect(errorCode({ code: 'json' })).toBe('schema');
    expect(errorCode({ code: 'shape', issues: [] })).toBe('schema');
  });
});

describe('busyGuard (fake timers)', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks during a run cause exactly one extra run', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const guard = busyGuard(async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    void guard.run();
    await vi.advanceTimersByTimeAsync(100);
    void guard.run();
    void guard.run();
    void guard.run();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await guard.idle();
    expect(runs).toBe(2);
    const third = guard.run();
    await vi.advanceTimersByTimeAsync(1_000);
    await third;
    expect(runs).toBe(3);
  });
});
