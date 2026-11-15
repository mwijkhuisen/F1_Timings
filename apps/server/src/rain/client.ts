import { isReal } from '@f1/contracts';
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

/** Requests per sliding 60 s and 1 s window: 6 × 49 location-calls = 294 a minute, against the free tier's 600 (U2). */
export const PER_MINUTE = 6;
export const PER_SECOND = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
/** One call, headers and body, ends after this (a total deadline). */
export const DEADLINE_MS = 60_000;
/** 49 points over a race window (15 steps) are ~26 kB, over a day ~70 kB; past this it is not an answer we keep. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A 429 pauses the client for its Retry-After, at most this: a far HTTP date must not stop rain for days. */
export const MAX_PAUSE_MS = 5 * 60_000;
const STEP_S = 900;
const HOUR_S = 3600;

const Location = z.object({
  latitude: z.number(),
  longitude: z.number(),
  minutely_15: z
    .object({
      time: z.array(z.number().int()),
      // A value that would not fit PostgreSQL's real (non-zero below 1e-37) becomes null, as P5b's weatherRow does.
      precipitation: z.array(
        z
          .number()
          .min(0)
          .max(1000)
          .nullable()
          .transform((v) => (v !== null && isReal(v) ? v : null)),
      ),
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

/** What a call asked for: `points` locations over [from, to] (epoch ms, on 15-minute boundaries). */
export type RainAsked = { points: number; from: number; to: number };

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** At least one step, `step` s apart and within [from, to] (epoch ms), so at most (to − from)/step + 1 of them. */
const onSteps = (time: readonly number[], from: number, to: number, step: number): boolean => {
  const first = time[0];
  const last = time.at(-1);
  const inWindow = first !== undefined && last !== undefined && first * 1000 >= from && last * 1000 <= to;
  return inWindow && time.every((t, i) => i === 0 || t - (time[i - 1] ?? t) === step);
};

/** The answer to `asked`, or undefined (not JSON, another shape or count, or not the asked window's 900 s steps). */
export function parseAnswer(text: string, { points, from, to }: RainAsked): RainAnswer | undefined {
  const parsed = Answer.safeParse(json(text));
  if (!parsed.success || parsed.data.length !== points) return undefined;
  return onSteps(parsed.data[0]?.minutely_15.time ?? [], from, to, STEP_S) ? parsed.data : undefined;
}

/** A number within [min, max] or null; one PostgreSQL real cannot hold (non-zero below 1e-37) becomes null. */
const real = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .nullable()
    .transform((v) => (v !== null && isReal(v) ? v : null));

/**
 * #120 (C3): the weekend forecast at one point. A one-location answer is a single object, so a list is not one.
 * Units as asked by forecastQuery: %, mm in the preceding hour, °C, m/s.
 */
const Hourly = z
  .object({
    time: z.array(z.number().int()),
    precipitation_probability: z.array(z.number().int().min(0).max(100).nullable()),
    precipitation: z.array(real(0, 1000)),
    temperature_2m: z.array(real(-100, 100)),
    wind_speed_10m: z.array(real(0, 200)),
  })
  .refine((h) =>
    [h.precipitation_probability, h.precipitation, h.temperature_2m, h.wind_speed_10m].every(
      (a) => a.length === h.time.length,
    ),
  );
const ForecastAnswer = z.object({ latitude: z.number(), longitude: z.number(), hourly: Hourly });
export type ForecastHours = z.infer<typeof Hourly>;

/** The hours of a forecast over [from, to] (epoch ms, on the hour), or undefined: its steps must be 3600 s apart. */
export function parseForecast(text: string, { from, to }: { from: number; to: number }): ForecastHours | undefined {
  const parsed = ForecastAnswer.safeParse(json(text));
  return parsed.success && onSteps(parsed.data.hourly.time, from, to, HOUR_S) ? parsed.data.hourly : undefined;
}

/** `onAttempt` runs as each call starts (after the limiter): the ingest heartbeat. */
export type RainClientOptions = { clock?: Clock; dispatcher?: Dispatcher; onAttempt?: () => void };

/**
 * One client per process, one attempt per call (C3): the rain job's A§8 back-off is the retry,
 * so a slow Open-Meteo never holds the busy guard for long. A 429 pauses every later call for
 * its Retry-After (or 60 s), at most MAX_PAUSE_MS; the job skips its step while `pausedFor()` > 0.
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
      if (status === 429)
        limiter.pause(Math.min(retryAfterMs(response.headers.get('retry-after'), clock.now()), MAX_PAUSE_MS));
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

  /** A 2xx answer through `parse`; a status is `rate_limited` or `http`, anything `parse` refuses `schema`. */
  async function parsed<T>(
    api: RainApi,
    query: Readonly<Record<string, string>>,
    parse: (text: string) => T | undefined,
  ): Promise<Result<T, RainError>> {
    const fetched = await text(api, query);
    if (!fetched.ok) return fetched;
    const { status } = fetched.value;
    if (status === 429) return { ok: false, error: { code: 'rate_limited' } };
    if (status < 200 || status >= 300) return { ok: false, error: { code: 'http', status } };
    const value = parse(fetched.value.text);
    return value === undefined ? { ok: false, error: { code: 'schema' } } : { ok: true, value };
  }

  /** The parsed answer to `asked` (the query's points and window); anything else is `schema`. */
  const get = (api: RainApi, query: Readonly<Record<string, string>>, asked: RainAsked) =>
    parsed(api, query, (body) => parseAnswer(body, asked));

  /** #120: a weekend forecast (forecastQuery) from the Forecast host, over [from, to]; anything else is `schema`. */
  const forecast = (query: Readonly<Record<string, string>>, asked: { from: number; to: number }) =>
    parsed('forecast', query, (body) => parseForecast(body, asked));

  /** Milliseconds until a 429's pause ends, on the client's clock; 0 when not paused. */
  const pausedFor = (): number => Math.max(0, limiter.until() - clock.now());

  return { get, forecast, text, pausedFor };
}

export type BudgetKind = 'live' | 'backfill' | 'forecast';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = { hour: 4000, day: 8000, backfillDay: 6400, forecastDay: 100 };

/**
 * The location-call budget (A§8, owner D3): a 49-point call counts as 49 calls at Open-Meteo.
 * At most `day` in any 24 h, of which the backfill may fill the window up to `backfillDay`, which
 * keeps the rest for live refreshes and final fetches, and at most `hour` in any hour (the free
 * tier allows 5,000 an hour and 10,000 a day). The weekend forecast (#120, D3) may spend at most
 * `forecastDay` of the day's calls, and every kind counts toward both totals. `take` refuses and never waits.
 * `seed` records the calls made before a restart (from the database) as if made now: `dayN` of the
 * last 24 h, of which `hourN` in the last hour, so a restart never exceeds a cap.
 */
export function createBudget(clock: Pick<Clock, 'now'>, overrides: Partial<typeof LIMITS> = {}) {
  const limits = { ...LIMITS, ...overrides };
  let spent: { at: number; n: number; hour: boolean; kind: BudgetKind }[] = [];

  function used(): { hour: number; day: number; forecast: number } {
    const now = clock.now();
    spent = spent.filter(({ at }) => at > now - DAY_MS);
    let hour = 0;
    let day = 0;
    let forecast = 0;
    for (const s of spent) {
      day += s.n;
      if (s.kind === 'forecast') forecast += s.n;
      if (s.hour && s.at > now - HOUR_MS) hour += s.n;
    }
    return { hour, day, forecast };
  }

  return {
    used,
    take(n: number, kind: BudgetKind): boolean {
      const { hour, day, forecast } = used();
      if (hour + n > limits.hour || day + n > (kind === 'backfill' ? limits.backfillDay : limits.day)) return false;
      if (kind === 'forecast' && forecast + n > limits.forecastDay) return false;
      spent.push({ at: clock.now(), n, hour: true, kind });
      return true;
    },
    seed(dayN: number, hourN: number, kind: BudgetKind = 'live'): void {
      const at = clock.now();
      spent.push({ at, n: Math.max(0, dayN - hourN), hour: false, kind }, { at, n: hourN, hour: true, kind });
    },
  };
}
