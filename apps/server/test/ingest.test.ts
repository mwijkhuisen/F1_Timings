import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/db.ts';
import { SYNC_RETRY_MS, scheduleSync } from '../src/ingest/ingest.ts';
import { ms, normaliseSession } from '../src/ingest/normalise.ts';
import { afterFailure, afterSuccess, busyGuard, errorCode, firstFetchAt, type Progress } from '../src/ingest/state.ts';
import type { createClient } from '../src/openf1/client.ts';
import type { Lap } from '../src/openf1/schemas.ts';

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
  const none = { drivers: [], stints: [], pit: [], race_control: [], session_result: [] };

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
