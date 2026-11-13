import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/db.ts';
import { minuteWork, SYNC_RETRY_MS, scheduleSync } from '../src/ingest/ingest.ts';
import { ms, normaliseSession, withGrid } from '../src/ingest/normalise.ts';
import { afterFailure, afterSuccess, busyGuard, errorCode, firstFetchAt, type Progress } from '../src/ingest/state.ts';
import type { createClient } from '../src/openf1/client.ts';
import type { Lap, StartingGrid, Weather } from '../src/openf1/schemas.ts';

const MIN = 60_000;
const end = new Date('2026-10-11T14:00:00Z');
const at = (ms: number) => new Date(end.getTime() + ms);
const fresh = { date_end: end, fetch_count: 0, fail_count: 0 };

describe('state machine (fake clock)', () => {
  it('a synced session is due at end + 35 min, not at + 34:59', () => {
    const next = firstFetchAt(end);
    expect(next).toEqual(at(35 * MIN));
    expect(next > at(35 * MIN - 1000)).toBe(true);
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

  it('a success before end + 35 min (refetch only) stays scheduled for the first fetch', () => {
    for (const t of [-60 * MIN, 0, 35 * MIN - 1]) {
      expect(afterSuccess(fresh, at(t))).toEqual({
        ingest_state: 'scheduled',
        next_fetch_at: at(35 * MIN),
        fetch_count: 1,
        fail_count: 0,
        last_error: null,
      });
    }
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

describe('normaliseSession', () => {
  const lap = (over: Partial<Lap>): Lap => ({
    session_key: 1,
    driver_number: 44,
    lap_number: 1,
    date_start: null,
    lap_duration: null,
    duration_sector_1: null,
    duration_sector_2: null,
    duration_sector_3: null,
    i1_speed: null,
    i2_speed: null,
    st_speed: null,
    is_pit_out_lap: false,
    segments_sector_1: null,
    segments_sector_2: null,
    segments_sector_3: null,
    ...over,
  });
  const none = { drivers: [], stints: [], pit: [], race_control: [], session_result: [], weather: [] };

  it('keeps the last of duplicate keys, skips rows of another session and counts both', () => {
    const laps = [
      lap({ lap_duration: 90 }),
      lap({ lap_duration: 91 }),
      lap({ lap_number: 2 }),
      lap({ session_key: 2, lap_number: 3 }),
    ];
    const { rows, skipped } = normaliseSession(1, { ...none, laps }, null);
    expect(rows.lap.map((l) => [l.lap_number, l.lap_ms])).toEqual([
      [1, 91_000],
      [2, null],
    ]);
    expect(skipped).toBe(2);
  });

  it('rounds seconds to integer ms and speeds to km/h; nulls stay null', () => {
    expect(ms(28.03)).toBe(28_030); // 28029.999… in floating point
    expect(ms(0.0004)).toBe(0);
    expect(ms(0.0005)).toBe(1);
    expect(ms(null)).toBeNull();
    const [row] = normaliseSession(1, { ...none, laps: [lap({ duration_sector_1: 33.0985, i1_speed: 294.6 })] }, null)
      .rows.lap;
    expect(row).toMatchObject({ s1_ms: 33_099, s2_ms: null, i1_kph: 295, i2_kph: null });
  });

  // P5a: one instant in two spellings is one key (the primary key is (session_key, date)); the last row wins.
  it('weather: keeps the last row per instant, skips another session and keeps nulls and values as they are', () => {
    const w = (date: string, over: Partial<Weather> = {}): Weather => ({
      session_key: 1,
      date,
      meeting_key: null,
      air_temperature: 30.2,
      track_temperature: 43.1,
      humidity: 69.1,
      pressure: 1009.9,
      rainfall: 0,
      wind_direction: 170,
      wind_speed: 0.8,
      ...over,
    });
    const weather = [
      w('2026-10-11T12:00:57.007000+00:00', { air_temperature: 30 }),
      w('2026-10-11T12:00:57.007+00:00', { air_temperature: 31, humidity: null }),
      w('2026-10-11T12:01:57.018000+00:00'),
      w('2026-10-11T12:02:57+00:00', { session_key: 2 }),
    ];
    const { rows, skipped } = normaliseSession(1, { ...none, laps: [], weather }, null);
    expect(rows.weather).toEqual([
      {
        session_key: 1,
        source: 'openf1',
        date: '2026-10-11T12:00:57.007+00:00',
        air_temperature: 31,
        track_temperature: 43.1,
        humidity: null,
        pressure: 1009.9,
        rainfall: 0,
        wind_direction: 170,
        wind_speed: 0.8,
      },
      expect.objectContaining({ date: '2026-10-11T12:01:57.018000+00:00', air_temperature: 30.2 }),
    ]);
    expect(skipped).toBe(2);
  });
});

// #115: the grid comes from the qualifying session's rows, by driver number.
describe('withGrid', () => {
  const g = (driver_number: number, position: number | null, session_key = 11384): StartingGrid => ({
    session_key,
    driver_number,
    position,
    lap_duration: null,
    meeting_key: null,
  });
  const result = (driver_number: number) => ({ session_key: 11388, source: 'openf1', driver_number });

  it('sets grid by driver; another session, a duplicate (the last wins) or a driver without a result is skipped; counts the usable rows', () => {
    const grid = [g(1, 5), g(1, 2), g(4, 1), g(16, 3, 11379), g(99, 4), g(44, null)];
    const out = withGrid([result(1), result(4), result(16), result(44)], grid, 11384);
    expect(out.results.map((r) => [r.driver_number, r.grid])).toEqual([
      [1, 2],
      [4, 1],
      [16, null],
      [44, null],
    ]);
    expect(out).toMatchObject({ rows: 2, skipped: 4, usable: 3 }); // usable: 1, 4 and 99; not 16 (another session), not 44 (null)
    expect(withGrid([result(1)], [], 11384)).toEqual({
      results: [{ ...result(1), grid: null }],
      rows: 0,
      skipped: 0,
      usable: 0,
    });
    expect(withGrid([result(1)], [g(1, null), g(2, 1, 11379)], 11384)).toMatchObject({ usable: 0 });
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

describe('minuteWork (the daemon job inside the busy guard)', () => {
  const setup = (fail?: 'sync' | 'tick') => {
    const order: string[] = [];
    const step = (name: string) => async () => {
      order.push(name);
      if (name === fail) throw Object.assign(new Error('boom'), { code: 'XX000' });
    };
    const log = { error: vi.fn() };
    return { order, log, job: { sync: step('sync'), tick: step('tick'), rain: vi.fn(step('rain')) } };
  };

  it('runs the sync, the tick, then the rain step with the stopping flag', async () => {
    const { order, log, job } = setup();
    const stopping = () => false;
    await minuteWork(job, log, stopping);
    expect(order).toEqual(['sync', 'tick', 'rain']);
    expect(job.rain.mock.calls).toEqual([[stopping]]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each(['sync', 'tick'] as const)(
    'runs the rain step once when the %s throws, and logs the code only',
    async (fail) => {
      const { order, log, job } = setup(fail);
      await minuteWork(job, log, () => false);
      expect(order).toEqual(fail === 'sync' ? ['sync', 'rain'] : ['sync', 'tick', 'rain']);
      expect(job.rain).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls).toEqual([[{ cause: 'XX000' }, 'tick failed']]);
    },
  );

  it('runs without a rain step (backfill and refetch have none), and runs nothing once stopping', async () => {
    const { order, log, job } = setup();
    await minuteWork({ sync: job.sync, tick: job.tick }, log, () => false);
    expect(order).toEqual(['sync', 'tick']);
    await minuteWork(job, log, () => true);
    expect(order).toEqual(['sync', 'tick']);
  });
});

describe('scheduleSync pings healthchecks', () => {
  // Kysely's dummy driver: every query answers with no rows, transactions are no-ops.
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  type Reply = Awaited<ReturnType<ReturnType<typeof createClient>['get']>>;
  const good: Reply = { ok: true, value: { status: 200, body: [] } };
  const bad: Reply = { ok: false, error: { code: 'network' } };
  /** A sync with a settable OpenF1 reply and clock; `ping` counts the healthchecks calls. */
  const setup = () => {
    const state: { reply: Reply; at: number } = { reply: good, at: end.getTime() };
    const ping = vi.fn(async (_slug: string) => {});
    const client = { get: async () => state.reply } as unknown as ReturnType<typeof createClient>;
    const log = { info: vi.fn(), error: vi.fn() };
    const sync = scheduleSync({ db, client, now: () => new Date(state.at), log, beat: () => {}, ping });
    return { state, ping, sync };
  };

  it('does not ping after the startup sync', async () => {
    const { ping, sync } = setup();
    await sync.run();
    expect(ping).not.toHaveBeenCalled();
  });

  it('pings f1-ingest once after a successful sync the Cron requested', async () => {
    const { ping, sync } = setup();
    await sync.run(); // startup
    sync.request();
    await sync.run();
    await sync.run(); // synced: nothing more to do
    expect(ping.mock.calls).toEqual([['f1-ingest']]);
  });

  it('pings only on the retry that succeeds after a failed Cron sync', async () => {
    const { state, ping, sync } = setup();
    await sync.run(); // startup
    sync.request();
    state.reply = bad;
    await sync.run();
    expect(ping).not.toHaveBeenCalled();
    state.reply = good;
    state.at += SYNC_RETRY_MS;
    await sync.run();
    expect(ping.mock.calls).toEqual([['f1-ingest']]);
  });
});
