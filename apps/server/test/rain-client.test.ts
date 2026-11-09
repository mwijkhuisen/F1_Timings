import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridPoints } from '@f1/contracts';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import {
  createBudget,
  createRainClient,
  DEADLINE_MS,
  FORECAST,
  HISTORICAL,
  MAX_BODY_BYTES,
  MAX_PAUSE_MS,
  PER_MINUTE,
} from '../src/rain/client.ts';
import { ceil15, floor15, rainQuery, toFrames } from '../src/rain/grid.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const T0 = Date.UTC(2023, 4, 28, 12, 0) / 1000;
const location = (k: number, time = [T0, T0 + 900], precipitation: (number | null)[] = [0, 0.1]) => ({
  latitude: k,
  longitude: k,
  elevation: 8,
  minutely_15: { time, precipitation },
});
const answer = (n: number) => Array.from({ length: n }, (_, k) => location(k));
const QUERY = { latitude: '1,2', longitude: '3,4', minutely_15: 'precipitation' };
/** What QUERY stands for: 2 points over [T0, T0 + 15 min], the steps of `location`. */
const ASKED = { points: 2, from: T0 * 1000, to: (T0 + 900) * 1000 };

/** Answers FORECAST from `reply(n)` for the n-th request (1-based) and records when each arrived. */
function forecast(reply: (n: number) => Response) {
  const t0 = Date.now();
  const seen: number[] = [];
  const requests: Request[] = [];
  server.use(
    http.get(FORECAST, ({ request }) => {
      seen.push(Date.now() - t0);
      requests.push(request);
      return reply(seen.length);
    }),
  );
  return { seen, requests };
}

async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

describe('rain client (msw, fake timers)', () => {
  it('sends the fixed host, the query, user-agent f1-timings and accept json, and parses the answer', async () => {
    let seen: Request | undefined;
    server.use(
      http.get(HISTORICAL, ({ request }) => {
        seen = request;
        return HttpResponse.json(answer(2));
      }),
    );
    const result = await settle(createRainClient().get('historical', QUERY, ASKED));
    expect(result).toEqual({ ok: true, value: answer(2).map(({ elevation: _, ...rest }) => rest) });
    const url = new URL(seen?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://historical-forecast-api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual(QUERY);
    expect(seen?.headers.get('user-agent')).toBe('f1-timings');
    expect(seen?.headers.get('accept')).toBe('application/json');

    const { requests } = forecast(() => HttpResponse.json(answer(2)));
    await settle(createRainClient().get('forecast', QUERY, ASKED));
    expect(new URL(requests[0]?.url ?? '').host).toBe('api.open-meteo.com');
  });

  it('starts at most 6 calls in any 60 s and 1 in any 1 s, and runs onAttempt after the limiter', async () => {
    const { seen } = forecast(() => HttpResponse.json(answer(2)));
    let attempts = 0;
    const client = createRainClient({ onAttempt: () => attempts++ });
    await settle(Promise.all(Array.from({ length: 8 }, () => client.get('forecast', QUERY, ASKED))));
    expect(seen).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 60_000, 61_000]);
    expect(seen.filter((t) => t < 60_000)).toHaveLength(PER_MINUTE);
    expect(attempts).toBe(8);
  });

  it('maps 429 to rate_limited, makes one attempt and pauses for Retry-After, which pausedFor shows', async () => {
    const { seen } = forecast((n) =>
      n === 1
        ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '120' } })
        : HttpResponse.json(answer(2)),
    );
    const client = createRainClient();
    expect(client.pausedFor()).toBe(0);
    expect(await settle(client.get('forecast', QUERY, ASKED))).toEqual({ ok: false, error: { code: 'rate_limited' } });
    expect(seen).toEqual([0]);
    expect(client.pausedFor()).toBe(120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(client.pausedFor()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.pausedFor()).toBe(0);
    expect((await settle(client.get('forecast', QUERY, ASKED))).ok).toBe(true);
    expect(seen).toEqual([0, 120_000]);
  });

  it.each([
    ['delta seconds', '86400'],
    ['an HTTP date', 'Fri, 01 Jan 2100 00:00:00 GMT'],
  ])('caps a Retry-After far ahead (%s) at 5 min', async (_, retryAfter) => {
    const { seen } = forecast((n) =>
      n === 1
        ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': retryAfter } })
        : HttpResponse.json(answer(2)),
    );
    const client = createRainClient();
    await settle(client.get('forecast', QUERY, ASKED));
    expect(client.pausedFor()).toBe(MAX_PAUSE_MS);
    expect(MAX_PAUSE_MS).toBe(5 * 60_000);
    expect((await settle(client.get('forecast', QUERY, ASKED))).ok).toBe(true);
    expect(seen).toEqual([0, MAX_PAUSE_MS]);
  });

  it.each([
    [500, { code: 'http', status: 500 }],
    [400, { code: 'http', status: 400 }],
  ])('maps HTTP %i to a fixed code without retrying', async (status, error) => {
    const { seen } = forecast(() => HttpResponse.json({ error: true, reason: 'body-text' }, { status }));
    expect(await settle(createRainClient().get('forecast', QUERY, ASKED))).toEqual({ ok: false, error });
    expect(seen).toHaveLength(1);
  });

  it('maps a network error to network', async () => {
    forecast(() => HttpResponse.error());
    expect(await settle(createRainClient().get('forecast', QUERY, ASKED))).toEqual({
      ok: false,
      error: { code: 'network' },
    });
  });

  it('follows no redirect', async () => {
    let followed = 0;
    server.use(
      http.get('https://elsewhere.example/v1/forecast', () => {
        followed++;
        return HttpResponse.json(answer(2));
      }),
    );
    forecast(
      () => new HttpResponse(null, { status: 302, headers: { Location: 'https://elsewhere.example/v1/forecast' } }),
    );
    expect(await settle(createRainClient().get('forecast', QUERY, ASKED))).toEqual({
      ok: false,
      error: { code: 'network' },
    });
    expect(followed).toBe(0);
  });

  it('ends a slow drip at the 60 s deadline, as a timeout', async () => {
    // One byte every 15 s (never idle for undici's 30 s), five in all, then a stall: bounded on purpose.
    // (Not closed: msw's emulated socket would deliver the end after undici's abort.)
    const drip = () => {
      let sent = 0;
      return new ReadableStream({
        pull: (controller) =>
          new Promise<void>((resolve) => {
            if (sent++ < 5) setTimeout(() => resolve(controller.enqueue(new TextEncoder().encode('['))), 15_000);
          }),
      });
    };
    // A declared length the drip never reaches, as a real slow server would send it (without one, the
    // socket's close after the abort would end the message: an undici assertion).
    forecast(() => new HttpResponse(drip(), { headers: { 'content-length': '1000' } }));
    const t0 = Date.now();
    let ended = 0;
    const pending = createRainClient()
      .get('forecast', QUERY, ASKED)
      .finally(() => {
        ended = Date.now() - t0;
      });
    expect(await settle(pending)).toEqual({ ok: false, error: { code: 'timeout' } });
    expect(ended).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(ended).toBeLessThan(DEADLINE_MS + 1_000);
  });

  it('stops reading a body past 4 MiB, as schema; the same answer without the padding parses', async () => {
    // Finite on purpose: a valid answer and then 4 MiB of spaces is still valid JSON (JSON.parse takes trailing
    // white space), so without the cap the first call would be ok: only the cap turns it away.
    const spaces = new Uint8Array(1024 * 1024).fill(32);
    const body = (padded: boolean) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(answer(2))));
          if (padded) for (let i = 0; i < MAX_BODY_BYTES / spaces.length; i++) controller.enqueue(spaces.slice());
          controller.close();
        },
      });
    const { seen } = forecast((n) => new HttpResponse(body(n === 1)));
    expect(await settle(createRainClient().get('forecast', QUERY, ASKED))).toEqual({
      ok: false,
      error: { code: 'schema' },
    });
    expect((await settle(createRainClient().get('forecast', QUERY, ASKED))).ok).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['a body that is not JSON', () => HttpResponse.text('<html>')],
    ['a single object (one location)', () => HttpResponse.json(location(0))],
    ['fewer locations than requested', () => HttpResponse.json(answer(1))],
    ['more locations than requested', () => HttpResponse.json(answer(3))],
    ['time and precipitation of different lengths', () => HttpResponse.json([location(0), location(1, [T0], [0, 1])])],
    ['locations on different steps', () => HttpResponse.json([location(0), location(1, [T0, T0 + 3600])])],
    ['a negative precipitation', () => HttpResponse.json([location(0), location(1, undefined, [0, -1])])],
    ['a time that is not an integer', () => HttpResponse.json([location(0, [T0, T0 + 0.5]), location(1)])],
    ['no minutely_15', () => HttpResponse.json([location(0), { latitude: 1, longitude: 1 }])],
    // The steps must be the asked window's: at least one, 900 s apart, within [from, to].
    ['no time steps', () => HttpResponse.json([location(0, [], []), location(1, [], [])])],
    ['a duplicate time', () => HttpResponse.json([location(0, [T0, T0]), location(1, [T0, T0])])],
    ['times out of order', () => HttpResponse.json([location(0, [T0 + 900, T0]), location(1, [T0 + 900, T0])])],
    [
      'a time after the window',
      () => HttpResponse.json([location(0, [T0 + 900, T0 + 1800]), location(1, [T0 + 900, T0 + 1800])]),
    ],
    ['a time before the window', () => HttpResponse.json([location(0, [T0 - 900, T0]), location(1, [T0 - 900, T0])])],
    [
      'a time of Number.MAX_SAFE_INTEGER',
      () => HttpResponse.json([0, 1].map((k) => location(k, [T0, Number.MAX_SAFE_INTEGER]))),
    ],
  ])('maps %s to schema', async (_, reply) => {
    forecast(reply);
    expect(await settle(createRainClient().get('forecast', QUERY, ASKED))).toEqual({
      ok: false,
      error: { code: 'schema' },
    });
  });

  it('keeps null precipitation (a step the model has not reached)', async () => {
    forecast(() => HttpResponse.json([location(0, undefined, [0, null]), location(1)]));
    const result = await settle(createRainClient().get('forecast', QUERY, ASKED));
    expect(result.ok && result.value[0]?.minutely_15.precipitation).toEqual([0, null]);
  });

  it('turns a precipitation PostgreSQL real cannot hold (non-zero below 1e-37) into null, as P5b weatherRow does', async () => {
    forecast(() => HttpResponse.json([location(0, undefined, [1e-50, 1e-37]), location(1, undefined, [1000, 0])]));
    const result = await settle(createRainClient().get('forecast', QUERY, ASKED));
    expect(result.ok && result.value.map((l) => l.minutely_15.precipitation)).toEqual([
      [null, 1e-37],
      [1000, 0],
    ]);
  });

  it('puts no URL, query or body in an error', async () => {
    const replies = [
      () => HttpResponse.json({ error: true, reason: 'body-text' }, { status: 400 }),
      () => new HttpResponse(null, { status: 429 }),
      () => HttpResponse.error(),
      () => HttpResponse.text('body-text'),
    ];
    for (const reply of replies) {
      forecast(reply);
      const result = JSON.stringify(await settle(createRainClient().get('forecast', QUERY, ASKED)));
      expect(result).not.toMatch(/open-meteo|forecast|latitude|precipitation|body-text|https?:/);
    }
  });
});

describe('recorded fixtures', () => {
  const dir = join(import.meta.dirname, '../src/rain/fixtures');
  const fixture = (name: string) => {
    const meta = JSON.parse(readFileSync(join(dir, `${name}.meta.json`), 'utf8'));
    const from = Date.parse(`${meta.query.start_minutely_15}Z`);
    const to = Date.parse(`${meta.query.end_minutely_15}Z`);
    return { raw: readFileSync(join(dir, `${name}.raw`), 'utf8'), meta, asked: { points: meta.points, from, to } };
  };

  it.each([
    ['central-wet', 15],
    ['outside-dry', 15],
  ])('%s parses: 49 locations in request order, %i steps', async (name, steps) => {
    const { raw, meta, asked } = fixture(name);
    const { from, to } = asked;
    expect(meta).toMatchObject({ api: 'historical', status: 200, points: 49 });
    expect(meta.attribution).toContain('CC BY 4.0');
    server.use(http.get(HISTORICAL, () => new HttpResponse(raw, { headers: { 'content-type': 'application/json' } })));
    const result = await settle(createRainClient().get(meta.api, meta.query, asked));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toHaveLength(49);
    const frames = toFrames(result.value);
    expect(frames).toHaveLength(steps);
    expect(frames.every((f) => f.mm.length === 49)).toBe(true);
    // The recorder's grid and window are the ones rainQuery builds.
    const { lat0, lon0, size, step_m } = meta.grid;
    expect(rainQuery(gridPoints(lat0, lon0, size, step_m), from, to)).toEqual(meta.query);
    expect(frames[0]?.date).toBe(new Date(from).toISOString());
    expect(frames.at(-1)?.date).toBe(new Date(to).toISOString());
    // Each location answers from a model cell near its point (U5: snapped, in request order).
    const points = gridPoints(lat0, lon0, size, step_m);
    for (const [k, loc] of result.value.entries()) {
      expect(Math.abs(loc.latitude - (points[k]?.lat ?? 0))).toBeLessThan(0.1);
      expect(Math.abs(loc.longitude - (points[k]?.lon ?? 0))).toBeLessThan(0.1);
    }
  });

  it('central-wet has rain in some cells and outside-dry in none', () => {
    const wet = (name: string) =>
      toFrames(JSON.parse(fixture(name).raw)).flatMap((f) => f.mm.filter((mm) => mm !== null && mm > 0)).length;
    expect(wet('central-wet')).toBeGreaterThan(0);
    expect(wet('outside-dry')).toBe(0);
  });

  it('error is a recorded HTTP 400', async () => {
    const { raw, meta, asked } = fixture('error');
    expect(meta.status).toBe(400);
    server.use(http.get(HISTORICAL, () => new HttpResponse(raw, { status: meta.status })));
    expect(await settle(createRainClient().get(meta.api, meta.query, asked))).toEqual({
      ok: false,
      error: { code: 'http', status: 400 },
    });
  });
});

describe('rainQuery and toFrames', () => {
  const from = Date.UTC(2026, 9, 11, 11, 0);
  const to = Date.UTC(2026, 9, 11, 14, 30);

  it('builds 49 comma pairs with 4 decimals, the 15-minute UTC window and unixtime', () => {
    const points = gridPoints(1.2907, 103.858, 7, 1500);
    const query = rainQuery(points, from, to);
    const lats = query.latitude?.split(',') ?? [];
    const lons = query.longitude?.split(',') ?? [];
    expect(lats).toHaveLength(49);
    expect(lons).toHaveLength(49);
    for (const v of [...lats, ...lons]) expect(v).toMatch(/^-?\d+\.\d{4}$/);
    expect(lats[24]).toBe('1.2907');
    expect(lons[24]).toBe('103.8580');
    expect(query).toMatchObject({
      minutely_15: 'precipitation',
      start_minutely_15: '2026-10-11T11:00',
      end_minutely_15: '2026-10-11T14:30',
      timeformat: 'unixtime',
      timezone: 'GMT',
      cell_selection: 'nearest',
    });
  });

  it('refuses a window off the 15-minute boundaries, and floor15/ceil15 put it on them', () => {
    expect(() => rainQuery([], from + 60_000, to)).toThrow(RangeError);
    expect(() => rainQuery([], from, to + 1)).toThrow(RangeError);
    expect(() => rainQuery([], to, from)).toThrow(RangeError);
    expect(floor15(from + 14 * 60_000 + 59_999)).toBe(from);
    expect(ceil15(from + 1)).toBe(from + 15 * 60_000);
    expect(ceil15(from)).toBe(from);
  });

  it('maps steps × locations to frames', () => {
    const frames = toFrames([
      location(0, [T0, T0 + 900, T0 + 1800], [0, 0.1, null]),
      location(1, [T0, T0 + 900, T0 + 1800], [0.2, 0.3, 0.4]),
    ]);
    expect(frames).toEqual([
      { date: '2023-05-28T12:00:00.000Z', mm: [0, 0.2] },
      { date: '2023-05-28T12:15:00.000Z', mm: [0.1, 0.3] },
      { date: '2023-05-28T12:30:00.000Z', mm: [null, 0.4] },
    ]);
    expect(toFrames([])).toEqual([]);
  });
});

describe('budget (fake clock)', () => {
  const HOUR = 3_600_000;
  function setup() {
    const clock = { t: 0, now: () => clock.t };
    return { clock, budget: createBudget(clock) };
  }
  /** Takes 49 at a time until refused; returns how many were taken. */
  const fill = (budget: ReturnType<typeof createBudget>, kind: 'live' | 'backfill', max = Infinity) => {
    let n = 0;
    while (n < max && budget.take(49, kind)) n++;
    return n;
  };

  it('refuses past 4,000 in any hour, and takes again once the hour has slid', () => {
    const { clock, budget } = setup();
    expect(fill(budget, 'live')).toBe(81); // 81 × 49 = 3,969
    expect(budget.used()).toEqual({ hour: 3969, day: 3969 });
    expect(budget.take(31, 'live')).toBe(true); // exactly 4,000
    expect(budget.take(1, 'live')).toBe(false);
    clock.t = HOUR - 1;
    expect(budget.take(1, 'live')).toBe(false);
    clock.t = HOUR;
    expect(budget.used()).toEqual({ hour: 0, day: 4000 });
    expect(budget.take(49, 'live')).toBe(true);
  });

  it('refuses past 8,000 in any 24 h for live, and takes again once the day has slid', () => {
    const { clock, budget } = setup();
    expect(fill(budget, 'live')).toBe(81);
    clock.t = HOUR;
    expect(fill(budget, 'live')).toBe(81);
    clock.t = 2 * HOUR;
    expect(fill(budget, 'live')).toBe(1); // 163 × 49 = 7,987
    expect(budget.used()).toEqual({ hour: 49, day: 7987 });
    clock.t = 3 * HOUR;
    expect(budget.take(13, 'live')).toBe(true); // exactly 8,000
    expect(budget.take(1, 'live')).toBe(false);
    clock.t = 24 * HOUR; // the first hour's 3,969 leave the window
    expect(budget.used().day).toBe(4031);
    expect(budget.take(49, 'live')).toBe(true);
  });

  it('stops the backfill at 6,400 in 24 h while live still gets up to 8,000', () => {
    const { clock, budget } = setup();
    expect(fill(budget, 'backfill')).toBe(81);
    clock.t = HOUR;
    expect(fill(budget, 'backfill')).toBe(49); // 130 × 49 = 6,370
    expect(budget.take(31, 'backfill')).toBe(false);
    expect(budget.take(30, 'backfill')).toBe(true); // exactly 6,400
    clock.t = 2 * HOUR;
    expect(budget.take(1, 'backfill')).toBe(false);
    expect(fill(budget, 'live')).toBe(32); // 6,400 + 32 × 49 = 7,968
    expect(budget.take(32, 'live')).toBe(true); // exactly 8,000
    expect(budget.take(1, 'live')).toBe(false);
    expect(budget.used()).toEqual({ hour: 1600, day: 8000 });
  });

  it('a refusal records nothing', () => {
    const { budget } = setup();
    expect(budget.take(4001, 'live')).toBe(false);
    expect(budget.take(6401, 'backfill')).toBe(false);
    expect(budget.used()).toEqual({ hour: 0, day: 0 });
  });

  it('seed counts the calls made before a restart: the day total and, inside it, the last hour', () => {
    const { clock, budget } = setup();
    budget.seed(5000, 3000);
    expect(budget.used()).toEqual({ hour: 3000, day: 5000 });
    expect(fill(budget, 'live')).toBe(20); // 3,000 + 20 × 49 = 3,980 in the hour
    clock.t = HOUR;
    expect(budget.used()).toEqual({ hour: 0, day: 5980 });
    expect(fill(budget, 'backfill')).toBe(8); // 5,980 + 8 × 49 = 6,372
    clock.t = 24 * HOUR;
    expect(budget.used()).toEqual({ hour: 0, day: 392 });
  });
});
