import { Agent, type Dispatcher } from 'undici';
import type { Endpoint, Result } from './schemas.ts';

// The OpenF1 client (A§8). It calls Node's global fetch with an undici Agent as
// the dispatcher (for the connect, headers and body timeouts), not undici's own
// request(): msw intercepts only global fetch, so the test guard that fails any
// unhandled request covers this client too.

export const OPENF1 = 'https://api.openf1.org/v1';
export const PER_MINUTE = 25;
export const PER_SECOND = 2;
export const MAX_ATTEMPTS = 5;
export const RETRY_AFTER_DEFAULT_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 60_000;
/** One attempt, headers and body, ends after this (a total deadline, not an idle timeout). */
export const DEADLINE_MS = 120_000;
/** A race's laps are ~1 MB; anything past this is not an OpenF1 answer we keep. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export type Query = Readonly<Record<string, string | number>>;
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type Fetched = { status: number; body: unknown };
/** Fixed codes only: never a URL, a body or an underlying error message (A§14.5). */
export type OpenF1Error = { code: 'http'; status: number } | { code: 'network' | 'timeout' | 'json' };

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function url(endpoint: Endpoint, query: Query): string {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  return `${OPENF1}/${endpoint}?${params}`;
}

/**
 * Sliding windows (A§8): a request starts only while fewer than 25 started in the
 * last 60 s and fewer than 2 in the last 1 s. Takes run in order. (A refill bucket
 * would let a full bucket plus its refill through inside one 60 s window.)
 */
export function createLimiter(clock: Clock = systemClock) {
  const starts: number[] = [];
  let notBefore = 0;
  let queue = Promise.resolve();

  async function next(): Promise<void> {
    for (;;) {
      const now = clock.now();
      while (starts.length > 0 && (starts[0] ?? 0) <= now - 60_000) starts.shift();
      const at = Math.max(
        notBefore,
        (starts.at(-PER_MINUTE) ?? -Infinity) + 60_000,
        (starts.at(-PER_SECOND) ?? -Infinity) + 1_000,
      );
      if (at <= now) {
        starts.push(now);
        return;
      }
      await clock.sleep(at - now);
    }
  }

  return {
    take(): Promise<void> {
      queue = queue.then(next);
      return queue;
    },
    /** No request starts for `ms` (a 429's Retry-After holds back every caller). */
    pause(ms: number): void {
      notBefore = Math.max(notBefore, clock.now() + ms);
    },
  };
}

/** Retry-After as delta seconds or an HTTP date; 60 s when it is missing or unreadable (A§8). */
export function retryAfterMs(header: string | null, now: number): number {
  const value = header?.trim() ?? '';
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = value.endsWith('GMT') ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? RETRY_AFTER_DEFAULT_MS : Math.max(0, at - now);
}

const backoffMs = (attempt: number) => Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // JSON.parse never returns undefined
  }
}

// OpenF1 answers a query without rows with 404 {"detail":"No results found."}, not [].
const noResults = (body: unknown) =>
  typeof body === 'object' && body !== null && 'detail' in body && body.detail === 'No results found.';

/** The body as text, or undefined once it passes MAX_BODY_BYTES (it is never held whole). */
async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts).toString('utf8');
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
}

const timedOut = (error: unknown) =>
  [error, error instanceof Error ? error.cause : undefined].some(
    (e) => typeof e === 'object' && e !== null && 'code' in e && /TIME(D?)OUT/.test(String(e.code)),
  );

export type ClientOptions = { clock?: Clock; dispatcher?: Dispatcher };

/** One client per process: every call shares its limiter. */
export function createClient({ clock = systemClock, dispatcher }: ClientOptions = {}) {
  const limiter = createLimiter(clock);
  // The cast: undici 8.12's Dispatcher type and @types/node's undici-types 8.9
  // differ in a compose() overload; at run time Node 26.10's fetch (undici 8.10) takes it.
  const agent = (dispatcher ??
    new Agent({
      connect: { timeout: CONNECT_TIMEOUT_MS },
      headersTimeout: READ_TIMEOUT_MS,
      bodyTimeout: READ_TIMEOUT_MS,
    })) as unknown as NonNullable<RequestInit['dispatcher']>;

  async function once(target: string): Promise<Result<Fetched, OpenF1Error>> {
    // A total deadline: undici's timeouts are idle timeouts, so a slow drip would never end.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
    try {
      const response = await fetch(target, {
        dispatcher: agent,
        headers: { accept: 'application/json' },
        redirect: 'error', // never to another host
        signal: deadline.signal,
      });
      const { status } = response;
      if (status === 429) limiter.pause(retryAfterMs(response.headers.get('retry-after'), clock.now()));
      const text = await readCapped(response);
      // Too large to be a body we accept: `json` (D5 `schema`), not retried.
      if (text === undefined) return { ok: false, error: { code: 'json' } };
      const body = parseJson(text);
      if (status >= 200 && status < 300) {
        return body === undefined ? { ok: false, error: { code: 'json' } } : { ok: true, value: { status, body } };
      }
      if (status === 404 && noResults(body)) return { ok: true, value: { status, body: [] } };
      return { ok: false, error: { code: 'http', status } };
    } catch (cause) {
      return { ok: false, error: { code: deadline.signal.aborted || timedOut(cause) ? 'timeout' : 'network' } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 429, 5xx, network errors and timeouts are retried, up to MAX_ATTEMPTS in all. */
  async function get(endpoint: Endpoint, query: Query): Promise<Result<Fetched, OpenF1Error>> {
    const target = url(endpoint, query);
    for (let attempt = 1; ; attempt++) {
      await limiter.take();
      const result = await once(target);
      if (result.ok || attempt === MAX_ATTEMPTS) return result;
      const { error } = result;
      if (error.code === 'json' || (error.code === 'http' && error.status !== 429 && error.status < 500)) return result;
      // A 429 has already paused the limiter for its Retry-After; the rest back off.
      if (error.code !== 'http' || error.status !== 429) await clock.sleep(backoffMs(attempt));
    }
  }

  return { get };
}
