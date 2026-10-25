import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import {
  createClient,
  createLimiter,
  MAX_ATTEMPTS,
  OPENF1,
  PER_MINUTE,
  PER_SECOND,
  RETRY_AFTER_DEFAULT_MS,
  retryAfterMs,
} from '../src/openf1/client.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Answers /laps from `reply(n)` for the n-th request (1-based) and records when each arrived. */
function laps(reply: (n: number) => Response) {
  const t0 = Date.now();
  const seen: number[] = [];
  server.use(
    http.get(`${OPENF1}/laps`, () => {
      seen.push(Date.now() - t0);
      return reply(seen.length);
    }),
  );
  return seen;
}

async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

describe('limiter (fake timers)', () => {
  it('never starts more than 25 in any 60 s window or 2 in any 1 s window', async () => {
    const limiter = createLimiter();
    const t0 = Date.now();
    const starts: number[] = [];
    const all = Array.from({ length: 80 }, () => limiter.take().then(() => starts.push(Date.now() - t0)));
    await settle(Promise.all(all));

    expect(starts).toHaveLength(80);
    for (const s of starts) {
      expect(starts.filter((t) => t >= s && t < s + 60_000).length).toBeLessThanOrEqual(PER_MINUTE);
      expect(starts.filter((t) => t >= s && t < s + 1_000).length).toBeLessThanOrEqual(PER_SECOND);
    }
    // Not slower than it has to be: 2 per second, and the 26th as soon as the 1st leaves the window.
    expect(starts.slice(0, 4)).toEqual([0, 0, 1_000, 1_000]);
    expect(starts[PER_MINUTE]).toBe(60_000);
  });
});

describe('client (msw, fake timers)', () => {
  it('waits Retry-After: 5 s after a 429, then retries', async () => {
    const seen = laps((n) =>
      n === 1 ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '5' } }) : HttpResponse.json([]),
    );
    const pending = createClient().get('laps', { session_key: 11388 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(seen).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, value: { status: 200, body: [] } });
    expect(seen).toEqual([0, 5_000]);
  });

  it('backs off exponentially on 5xx and gives up after MAX_ATTEMPTS', async () => {
    const seen = laps(() => new HttpResponse(null, { status: 503 }));
    const result = await settle(createClient().get('laps', { session_key: 1 }));
    expect(result).toEqual({ ok: false, error: { code: 'http', status: 503 } });
    expect(seen).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    expect(seen).toHaveLength(MAX_ATTEMPTS);
  });

  it('recovers when a 5xx is followed by a 200', async () => {
    const seen = laps((n) => (n === 1 ? new HttpResponse(null, { status: 502 }) : HttpResponse.json([{ a: 1 }])));
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: true,
      value: { status: 200, body: [{ a: 1 }] },
    });
    expect(seen).toEqual([0, 1_000]);
  });

  it('retries network errors, then reports a fixed code', async () => {
    const seen = laps(() => HttpResponse.error());
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: false,
      error: { code: 'network' },
    });
    expect(seen).toHaveLength(MAX_ATTEMPTS);
  });

  it('maps 404 "No results found." to an empty list, and any other 404 to an error without retry', async () => {
    laps(() => HttpResponse.json({ detail: 'No results found.' }, { status: 404 }));
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: true,
      value: { status: 404, body: [] },
    });
    const seen = laps(() => HttpResponse.json({ detail: 'Not Found' }, { status: 404 }));
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: false,
      error: { code: 'http', status: 404 },
    });
    expect(seen).toHaveLength(1);
  });

  it('does not retry other 4xx (such as the 401 during a live session) or a body that is not JSON', async () => {
    const seen = laps(() => HttpResponse.json({ detail: 'Live F1 session in progress.' }, { status: 401 }));
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: false,
      error: { code: 'http', status: 401 },
    });
    expect(seen).toHaveLength(1);
    laps(() => HttpResponse.text('<html>'));
    expect(await settle(createClient().get('laps', { session_key: 1 }))).toEqual({
      ok: false,
      error: { code: 'json' },
    });
  });

  it('puts no URL or body in an error', async () => {
    laps(() => HttpResponse.json({ detail: 'body-text' }, { status: 400 }));
    const result = JSON.stringify(await settle(createClient().get('laps', { session_key: 1 })));
    expect(result).not.toMatch(/openf1|session_key|body-text/);
  });
});

describe('retryAfterMs', () => {
  const now = Date.UTC(2026, 9, 25, 20, 0, 0);
  it.each([
    ['5', 5_000],
    ['0', 0],
    [new Date(now + 5_000).toUTCString(), 5_000],
    [new Date(now - 5_000).toUTCString(), 0],
    ['5.5', RETRY_AFTER_DEFAULT_MS],
    ['soon', RETRY_AFTER_DEFAULT_MS],
    [null, RETRY_AFTER_DEFAULT_MS],
  ])('%j → %i ms', (header, ms) => {
    expect(retryAfterMs(header, now)).toBe(ms);
  });
});
