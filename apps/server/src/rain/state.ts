import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, MAX_FAILURES } from '../ingest/state.ts';
import type { RainApi, RainError } from './client.ts';
import { ceil15, floor15 } from './grid.ts';

// The rain grid's state machine (A§8, P5c). Pure: the caller passes the time.
//   no grid → in its live window: live, fetched every 15 min from the Forecast host
//   → after the window: waits until date_end + 24 h → one Historical Forecast fetch → final
//   a failure → again after 5 min · 2^(n−1), at most 6 h (the session rules); the 9th in a row → failed

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 7 × 7 points 1.5 km apart (owner D1): the cells cover ±5.25 km. */
export const GRID = { size: 7, stepM: 1500 } as const;
/** A§6.1: a session is live from 30 min before its start until 30 min after its end. */
export const LIVE_MARGIN_MS = 30 * MINUTE;
/** A row longer than this opens no live window (a bad date must not fetch for days). */
export const MAX_SESSION_MS = 12 * HOUR;
export const REFRESH_MS = 15 * MINUTE;
/**
 * The final fetch (U3, A§8): the Historical Forecast host serves the same stitched series as the Forecast host,
 * so a step is final only once a newer model run covering it is out (ICON-D2 ≤ ~5.5 h, global models ~13–14 h).
 * End + 24 h is safe everywhere, and the backfill takes only sessions past it.
 */
export const FINAL_AFTER_MS = 24 * HOUR;
/** The frames run from an hour before the start to 30 min after the end. */
export const FRAMES_BEFORE_MS = 60 * MINUTE;
export const FRAMES_AFTER_MS = 30 * MINUTE;

export type RainState = 'live' | 'final' | 'failed';
/** The only values `rain_grid.last_error` takes (a CHECK in the migration). */
export type RainCode = `http_${number}` | 'rate_limited' | 'timeout' | 'network' | 'schema' | 'db' | 'unknown';
export type RainProgress = {
  state: RainState;
  next_fetch_at: Date | null;
  fetch_count: number;
  fail_count: number;
  last_error: RainCode | null;
};
type Times = { date_start: Date; date_end: Date };

/** The A§6.1 window, as `live()` in ingest.ts: not cancelled, at most 12 h long, start − 30 min ≤ at < end + 30 min. */
export function inLiveWindow(s: Times & { is_cancelled: boolean }, at: Date): boolean {
  const start = s.date_start.getTime();
  const end = s.date_end.getTime();
  const t = at.getTime();
  return !s.is_cancelled && end - start <= MAX_SESSION_MS && start - LIVE_MARGIN_MS <= t && t < end + LIVE_MARGIN_MS;
}

/** Forecast before date_end + 24 h, then the Historical Forecast host for the final fetch. */
export const apiFor = (s: Times, at: Date): RainApi =>
  at.getTime() >= s.date_end.getTime() + FINAL_AFTER_MS ? 'historical' : 'forecast';

/** The fetched steps, on 15-minute boundaries. A forecast never asks past now (C1). */
export function frameWindow(s: Times, at: Date, api: RainApi): { from: number; to: number } {
  const from = floor15(s.date_start.getTime() - FRAMES_BEFORE_MS);
  const last = ceil15(s.date_end.getTime() + FRAMES_AFTER_MS);
  return { from, to: api === 'historical' ? last : Math.min(floor15(at.getTime()), last) };
}

export function afterRainSuccess(g: { date_end: Date; fetch_count: number }, at: Date, api: RainApi): RainProgress {
  const done = { fetch_count: g.fetch_count + 1, fail_count: 0, last_error: null };
  if (api === 'historical') return { ...done, state: 'final', next_fetch_at: null };
  const end = g.date_end.getTime();
  const next = at.getTime() + REFRESH_MS;
  return {
    ...done,
    state: 'live',
    next_fetch_at: new Date(next <= end + LIVE_MARGIN_MS ? next : end + FINAL_AFTER_MS),
  };
}

export function afterRainFailure(
  g: { fetch_count: number; fail_count: number },
  at: Date,
  code: RainCode,
): RainProgress {
  const n = g.fail_count + 1;
  const kept = { fetch_count: g.fetch_count, fail_count: n, last_error: code };
  if (n >= MAX_FAILURES) return { ...kept, state: 'failed', next_fetch_at: null };
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
  return { ...kept, state: 'live', next_fetch_at: new Date(at.getTime() + delay) };
}

/** The client's typed errors → fixed codes; the job sets `db` and `unknown` itself. */
export const rainErrorCode = (e: RainError): RainCode =>
  e.code !== 'http' ? e.code : e.status === 429 ? 'rate_limited' : `http_${e.status}`;
