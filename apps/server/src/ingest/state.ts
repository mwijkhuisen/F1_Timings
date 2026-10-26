import type { OpenF1Error } from '../openf1/client.ts';
import type { ShapeError } from '../openf1/schemas.ts';

// The per-session state machine (A§8). Pure: the caller passes the time (D7).
//   scheduled → due at date_end + 35 min → fetched (next at end + 3 h, then end + 24 h) → final
//   a failure → due again after 5 min · 2^(n−1), at most 6 h; the 9th in a row → failed

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const FIRST_FETCH_AFTER_MS = 35 * MINUTE;
/** A success at t schedules the first of these (after date_end) that lies after t, else the session is final (D3). */
export const REFETCH_AFTER_MS = [3 * HOUR, 24 * HOUR] as const;
export const BACKOFF_BASE_MS = 5 * MINUTE;
export const BACKOFF_CAP_MS = 6 * HOUR;
/** The 9th consecutive failure marks the session failed (D4). */
export const MAX_FAILURES = 9;

export type IngestState = 'scheduled' | 'due' | 'fetched' | 'final' | 'failed';
export const ERROR_CODES = ['rate_limited', 'timeout', 'network', 'schema', 'empty', 'db', 'unknown'] as const;
/** The only values `session.last_error` takes (D5, a CHECK in the migration). */
export type ErrorCode = `http_${number}` | (typeof ERROR_CODES)[number];
export type Progress = {
  ingest_state: IngestState;
  next_fetch_at: Date | null;
  fetch_count: number;
  fail_count: number;
  last_error: ErrorCode | null;
};

/** When a newly synced session becomes due. */
export const firstFetchAt = (dateEnd: Date): Date => new Date(dateEnd.getTime() + FIRST_FETCH_AFTER_MS);

export function afterSuccess(s: { date_end: Date; fetch_count: number }, now: Date): Progress {
  const done = { fetch_count: s.fetch_count + 1, fail_count: 0, last_error: null };
  // Only `refetch` gets here this early: the first fetch after the paid window still happens.
  if (now < firstFetchAt(s.date_end))
    return { ...done, ingest_state: 'scheduled', next_fetch_at: firstFetchAt(s.date_end) };
  const end = s.date_end.getTime();
  const next = REFETCH_AFTER_MS.map((ms) => end + ms).find((at) => at > now.getTime());
  return next === undefined
    ? { ...done, ingest_state: 'final', next_fetch_at: null }
    : { ...done, ingest_state: 'fetched', next_fetch_at: new Date(next) };
}

export function afterFailure(s: { fetch_count: number; fail_count: number }, code: ErrorCode, now: Date): Progress {
  const n = s.fail_count + 1;
  const kept = { fetch_count: s.fetch_count, fail_count: n, last_error: code };
  if (n >= MAX_FAILURES) return { ...kept, ingest_state: 'failed', next_fetch_at: null };
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
  return { ...kept, ingest_state: 'due', next_fetch_at: new Date(now.getTime() + delay) };
}

/** P1a's typed errors → D5 codes. A pg error is `db` and anything else `unknown`; the caller knows which. */
export function errorCode(error: OpenF1Error | ShapeError): ErrorCode {
  if (error.code === 'http') return error.status === 429 ? 'rate_limited' : `http_${error.status}`;
  if (error.code === 'json' || error.code === 'shape') return 'schema';
  return error.code;
}

/**
 * D9: croner's `protect` only skips a tick that fires while the job runs. This
 * remembers it instead: when the run ends it runs once more (missed ticks run once).
 * Precondition: `fn` never rejects (the caller catches and logs); a rejection would
 * end the run and reject the promise every waiting caller holds.
 */
export function busyGuard(fn: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let again = false;
  return {
    run(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await fn();
          } while (again);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
    idle: (): Promise<void> => running ?? Promise.resolve(),
  };
}
