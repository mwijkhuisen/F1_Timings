import { Agent, type Dispatcher } from 'undici';
import { z } from 'zod';
import { type Clock, createLimiter, readCapped, retryAfterMs, systemClock, timedOut } from '../openf1/client.ts';
import type { Result } from '../openf1/schemas.ts';

// The Open-Meteo client (A§8, P5c). Like the OpenF1 client it calls Node's global fetch with an
// undici Agent as the dispatcher, so msw's guard against unhandled requests covers it too.
// The host is one of two fixed URLs, picked by `api`: nothing from data or config reaches it.

export const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const HISTORICAL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const HOSTS = { forecast: FORECAST, historical: HISTORICAL } as const;
export type RainApi = keyof typeof HOSTS;

/** Requests per sliding 60 s and 1 s window, far below the free tier's 600 a minute. */
export const PER_MINUTE = 6;
export const PER_SECOND = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
/** One call, headers and body, ends after this (a total deadline). */
export const DEADLINE_MS = 60_000;
/** 49 points over a race window (15 steps) are ~26 kB, over a day ~70 kB; past this it is not an answer we keep. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const Location = z.object({
  latitude: z.number(),
  longitude: z.number(),
  minutely_15: z
    .object({
      time: z.array(z.number().int()),
      precipitation: z.array(z.number().min(0).max(1000).nullable()),
    })
    .refine((m) => m.time.length === m.precipitation.length),
});

/** A multi-location answer: one object per requested point, in request order, all on the same steps. */
const Answer = z.array(Location).refine((locations) => {
  const first = locations[0]?.minutely_15.time ?? [];
  return locations.every(
    ({ minutely_15: { time } }) => time.length === first.length && time.every((t, i) => t === first[i]),
  );
});
export type RainAnswer = z.infer<typeof Answer>;

/** Fixed codes only, as A§8's `last_error`: never a URL, a body or an underlying message. */
export type RainError = { code: 'http'; status: number } | { code: 'rate_limited' | 'timeout' | 'network' | 'schema' };
export type RainText = { status: number; text: string };

/** The answer for `points` requested locations, or undefined (not JSON, another shape or count). */
export function parseAnswer(text: string, points: number): RainAnswer | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = Answer.safeParse(json);
  return parsed.success && parsed.data.length === points ? parsed.data : undefined;
}

/** `onAttempt` runs as each call starts (after the limiter): the ingest heartbeat. */
export type RainClientOptions = { clock?: Clock; dispatcher?: Dispatcher; onAttempt?: () => void };

/**
 * One client per process, one attempt per call (C3): the rain job's A§8 back-off is the retry,
 * so a slow Open-Meteo never holds the busy guard for long. A 429 pauses every later call for
 * its Retry-After (or 60 s).
 */
export function createRainClient({ clock = systemClock, dispatcher, onAttempt = () => {} }: RainClientOptions = {}) {
  const limiter = createLimiter(clock, PER_MINUTE, PER_SECOND);
  // The cast: undici 8.12's Dispatcher type and @types/node's undici-types 8.9
  // differ in a compose() overload; at run time Node 26.10's fetch (undici 8.10) takes it.
  const agent = (dispatcher ??
    new Agent({
      connect: { timeout: CONNECT_TIMEOUT_MS },
      headersTimeout: READ_TIMEOUT_MS,
      bodyTimeout: READ_TIMEOUT_MS,
    })) as unknown as NonNullable<RequestInit['dispatcher']>;

  /** The status and body text of any answer (the fixture recorder keeps both). */
  async function text(api: RainApi, query: Readonly<Record<string, string>>): Promise<Result<RainText, RainError>> {
    await limiter.take();
    onAttempt();
    // A total deadline: undici's timeouts are idle timeouts, so a slow drip would never end.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
    try {
      const response = await fetch(`${HOSTS[api]}?${new URLSearchParams(query)}`, {
        dispatcher: agent,
        headers: { accept: 'application/json', 'user-agent': 'f1-timings' },
        redirect: 'error', // never to another host
        signal: deadline.signal,
      });
      const { status } = response;
      if (status === 429) limiter.pause(retryAfterMs(response.headers.get('retry-after'), clock.now()));
      const body = await readCapped(response, MAX_BODY_BYTES);
      return body === undefined
        ? { ok: false, error: { code: 'schema' } }
        : { ok: true, value: { status, text: body } };
    } catch (cause) {
      return { ok: false, error: { code: deadline.signal.aborted || timedOut(cause) ? 'timeout' : 'network' } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The parsed answer for `points` requested locations; any other count is `schema`. */
  async function get(
    api: RainApi,
    query: Readonly<Record<string, string>>,
    points: number,
  ): Promise<Result<RainAnswer, RainError>> {
    const fetched = await text(api, query);
    if (!fetched.ok) return fetched;
    const { status } = fetched.value;
    if (status === 429) return { ok: false, error: { code: 'rate_limited' } };
    if (status < 200 || status >= 300) return { ok: false, error: { code: 'http', status } };
    const answer = parseAnswer(fetched.value.text, points);
    return answer === undefined ? { ok: false, error: { code: 'schema' } } : { ok: true, value: answer };
  }

  return { get, text };
}

export type BudgetKind = 'live' | 'backfill';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The location-call budget (A§8, owner D3): a 49-point call counts as 49 calls at Open-Meteo.
 * At most `day` in any 24 h, of which the backfill may fill the window up to `backfillDay`, which
 * keeps the rest for live refreshes and final fetches, and at most `hour` in any hour (the free
 * tier allows 5,000 an hour and 10,000 a day). `take` refuses and never waits.
 * `seed` records the calls made before a restart (from the database) as if made now: `dayN` of the
 * last 24 h, of which `hourN` in the last hour, so a restart never exceeds a cap.
 */
export function createBudget(clock: Pick<Clock, 'now'>, limits = { hour: 4000, day: 8000, backfillDay: 6400 }) {
  let spent: { at: number; n: number; hour: boolean }[] = [];

  function used(): { hour: number; day: number } {
    const now = clock.now();
    spent = spent.filter(({ at }) => at > now - DAY_MS);
    let hour = 0;
    let day = 0;
    for (const s of spent) {
      day += s.n;
      if (s.hour && s.at > now - HOUR_MS) hour += s.n;
    }
    return { hour, day };
  }

  return {
    used,
    take(n: number, kind: BudgetKind): boolean {
      const { hour, day } = used();
      if (hour + n > limits.hour || day + n > (kind === 'backfill' ? limits.backfillDay : limits.day)) return false;
      spent.push({ at: clock.now(), n, hour: true });
      return true;
    },
    seed(dayN: number, hourN: number): void {
      const at = clock.now();
      spent.push({ at, n: Math.max(0, dayN - hourN), hour: false }, { at, n: hourN, hour: true });
    },
  };
}
