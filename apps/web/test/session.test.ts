import type { Live, Rain, SessionDetail } from '@f1/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rainQuery, sessionQuery } from '../src/lib/api.ts';
import { errorWords, LIVE_TEXT, noDataText, orderDrivers, pollMs, sourceWords, statusOf } from '../src/lib/session.ts';
import { result, sessionDetail } from './laps.ts';

// Why a session's tab has no data, and when its page refreshes (#99, A§13), on a hand-built session.

type S = SessionDetail['session'];
const START = '2026-10-31T19:00:00.000Z';
const END = '2026-10-31T21:00:00.000Z';
const H = 3_600_000;
const at = (h: number) => Date.parse(END) + h * H;
const base = sessionDetail('Race', 'Race').session;
/** Before its first successful fetch unless `over` says otherwise. */
const s = (over: Partial<S> = {}): S => ({ ...base, date_start: START, date_end: END, fetch_count: 0, ...over });
const open = (session_key: number | null, ended_at: string | null = null): Live => ({
  session:
    session_key === null
      ? null
      : { session_key, meeting_name: null, session_name: null, date_start: START, date_end: END },
  recording: { id: 7, started_at: START, ended_at, complete: false },
});

describe('noDataText', () => {
  const text = (over: Partial<S>, h: number, live: Live | null = null) => noDataText(s(over), live, at(h), 'laps');

  it('a cancelled session says so, whatever else holds', () => {
    expect(text({ is_cancelled: true, ingest_state: 'failed', fail_count: 9 }, 48)).toBe(
      'No laps: the session was cancelled.',
    );
    expect(noDataText(s({ is_cancelled: true }), open(base.session_key), at(0), 'stints')).toBe(
      'No stints: the session was cancelled.',
    );
  });

  it('live now: /live names an open recording of this session', () => {
    expect(text({ ingest_state: 'scheduled' }, -1, open(base.session_key))).toBe(LIVE_TEXT);
    expect(LIVE_TEXT).toBe('Live now: follow it.');
    // Another session's recording, an ended one, or none: not live.
    expect(text({ ingest_state: 'scheduled' }, -1, open(1))).toBe('Laps arrive about 35 min after the end.');
    expect(text({ ingest_state: 'scheduled' }, -1, open(base.session_key, END))).toBe(
      'Laps arrive about 35 min after the end.',
    );
    expect(text({ ingest_state: 'scheduled' }, -1, { session: null, recording: null })).toBe(
      'Laps arrive about 35 min after the end.',
    );
  });

  it('in back-off: the failure in words and the next try in Amsterdam time, or a retry due once it is past', () => {
    // 2026-10-31T21:05Z, 5 min after the end, is 22:05 in Amsterdam (CET).
    const backoff = {
      ingest_state: 'due',
      fail_count: 2,
      last_error: 'schema',
      next_fetch_at: '2026-10-31T21:05:00.000Z',
    } as const;
    expect(text(backoff, 0)).toBe('The fetch failed (unexpected data); next try at 22:05.');
    expect(text(backoff, 5 / 60)).toBe('The fetch failed (unexpected data); a retry is due.');
    expect(text(backoff, 1)).toBe('The fetch failed (unexpected data); a retry is due.');
    // Back-off wins over the 24 h queue.
    expect(text({ ...backoff, last_error: 'http_503' }, 48)).toBe('The fetch failed (HTTP 503); a retry is due.');
    expect(text({ ...backoff, next_fetch_at: null }, 1)).toBe('The fetch failed (unexpected data).');
  });

  it('failed: the count and the error, not retried', () => {
    expect(text({ ingest_state: 'failed', fail_count: 9, last_error: 'timeout' }, 48)).toBe(
      'The fetch failed 9 times (timed out) and is not retried.',
    );
  });

  it('due past date_end + 24 h before any fetch: queued for a new fetch', () => {
    expect(text({ ingest_state: 'due' }, 24)).toBe('Laps arrive about 35 min after the end.');
    expect(text({ ingest_state: 'due' }, 24 + 1 / H)).toBe('Queued for a new fetch; check back later.');
    expect(text({ ingest_state: 'due' }, 24 * 30)).toBe('Queued for a new fetch; check back later.');
    // Scheduled is never queued: its first fetch is still to come.
    expect(text({ ingest_state: 'scheduled' }, 24 * 30)).toBe('Laps arrive about 35 min after the end.');
  });

  it('before the start, and after it until the first fetch: the 35 min wait', () => {
    expect(text({ ingest_state: 'scheduled' }, -3)).toBe('Not started yet. Laps arrive about 35 min after the end.');
    expect(text({ ingest_state: 'scheduled' }, -1)).toBe('Laps arrive about 35 min after the end.');
    expect(text({ ingest_state: 'due' }, 1)).toBe('Laps arrive about 35 min after the end.');
    expect(noDataText(s({ ingest_state: 'scheduled' }), null, at(-3), 'weather')).toBe(
      'Not started yet. Weather arrives about 35 min after the end.',
    );
    expect(noDataText(s({ ingest_state: 'due' }), null, at(1), 'stints')).toBe(
      'Stints arrive about 35 min after the end.',
    );
  });

  it('after a fetch that succeeded: none in the source, whatever the state, back-off and failed included (E3)', () => {
    const once = { fetch_count: 1 } as const;
    for (const [over, h] of [
      [{ ingest_state: 'fetched' }, 1],
      [{ ingest_state: 'fetched' }, 48],
      [{ ingest_state: 'due' }, 1],
      [{ ingest_state: 'due' }, 48],
      [{ ingest_state: 'due', fail_count: 2, last_error: 'schema', next_fetch_at: END }, 1],
      [{ ingest_state: 'failed', fail_count: 9, last_error: 'timeout' }, 48],
      [{ ingest_state: 'final' }, 48],
    ] as const)
      expect(text({ ...once, ...over }, h)).toBe('No laps in the OpenF1 data.');
    expect(noDataText(s({ ...once, ingest_state: 'due' }), null, at(1), 'stints')).toBe(
      'No stints in the OpenF1 data.',
    );
    // Cancelled and live now still come first.
    expect(text({ ...once, is_cancelled: true }, 1)).toBe('No laps: the session was cancelled.');
    expect(text({ ...once, ingest_state: 'due' }, 1, open(base.session_key))).toBe(LIVE_TEXT);
  });

  it('final without a fetch (archive, Jolpica): none in the session’s source', () => {
    expect(text({ ingest_state: 'final' }, 48)).toBe('No laps in the OpenF1 data.');
    expect(text({ ingest_state: 'final', source: 'f1-archive' }, 48)).toBe('No laps in the F1 archive.');
    expect(text({ ingest_state: 'final', source: 'f1-live' }, 48)).toBe('No laps in the F1 live feed.');
    expect(text({ ingest_state: 'final', source: 'jolpica' }, 48)).toBe('No laps in the Jolpica data.');
    expect(noDataText(s({ ingest_state: 'final' }), null, at(1), 'weather')).toBe('No weather in the OpenF1 data.');
    expect(noDataText(s({ ingest_state: 'final' }), null, at(48), 'stints')).toBe('No stints in the OpenF1 data.');
  });

  it('names the results on the Result tab (#110)', () => {
    expect(noDataText(s({ is_cancelled: true }), null, at(1), 'results')).toBe(
      'No results: the session was cancelled.',
    );
    expect(noDataText(s({ ingest_state: 'due' }), null, at(1), 'results')).toBe(
      'Results arrive about 35 min after the end.',
    );
    expect(noDataText(s({ ingest_state: 'final', source: 'jolpica' }), null, at(48), 'results')).toBe(
      'No results in the Jolpica data.',
    );
  });
});

describe('the driver cells and the status words (#110)', () => {
  it("orderDrivers' name is the cells' title: full name · team, whichever is known", () => {
    const d = sessionDetail('Race', 'Race', [
      [4, 'NOR'],
      [44, 'HAM'],
      [63, 'RUS'],
    ]);
    const named = {
      ...d,
      drivers: d.drivers.map((x) =>
        x.driver_number === 4
          ? { ...x, full_name: 'Lando Norris', team_name: 'McLaren' }
          : x.driver_number === 44
            ? { ...x, team_name: 'Ferrari' }
            : x,
      ),
    };
    const laps = [4, 44, 63].map((driver_number) => ({ driver_number }));
    expect(orderDrivers(named, laps).map((x) => x.name)).toEqual(['Lando Norris · McLaren', 'Ferrari', null]);
  });

  it('statusOf: DSQ before DNS before DNF, else none', () => {
    expect(statusOf({ ...result(1), dsq: true, dnf: true })).toBe('DSQ');
    expect(statusOf({ ...result(1), dns: true, dnf: true })).toBe('DNS');
    expect(statusOf({ ...result(1), dnf: true })).toBe('DNF');
    expect(statusOf({ ...result(1), dnf: false })).toBeNull();
  });
});

describe('errorWords and sourceWords', () => {
  it('maps each CHECK code to fixed words, an HTTP status by its number', () => {
    expect(
      ['rate_limited', 'timeout', 'network', 'schema', 'empty', 'db', 'unknown', null].map((c) => errorWords(c)),
    ).toEqual([
      'rate limited',
      'timed out',
      'network error',
      'unexpected data',
      'empty answer',
      'database error',
      'unknown error',
      'unknown error',
    ]);
    expect(errorWords('http_404')).toBe('HTTP 404');
  });

  it('never echoes another string', () => {
    for (const code of ['<b>x</b>', 'http_5030', 'toString', '__proto__', 'constructor'])
      expect(errorWords(code)).toBe('unknown error');
  });

  it('names each source', () => {
    expect((['openf1', 'f1-archive', 'f1-live', 'jolpica'] as const).map(sourceWords)).toEqual([
      'the OpenF1 data',
      'the F1 archive',
      'the F1 live feed',
      'the Jolpica data',
    ]);
  });
});

describe('the refresh (pollMs, through the session query)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** The session query's refetchInterval for this session at `h` hours after its end, on a fake clock. */
  const interval = (over: Partial<S>, h: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(at(h));
    const refetch = sessionQuery(base.session_key).refetchInterval as (q: {
      state: { data: SessionDetail | undefined };
    }) => number | false;
    return refetch({ state: { data: { ...sessionDetail('Race', 'Race'), session: s(over) } } });
  };

  it('polls every 60 s while scheduled, due or fetched, with no bound on the clock', () => {
    expect(interval({ ingest_state: 'scheduled' }, -48)).toBe(60_000);
    expect(interval({ ingest_state: 'due', fail_count: 3 }, 2)).toBe(60_000);
    expect(interval({ ingest_state: 'fetched' }, 3)).toBe(60_000);
    expect(interval({ ingest_state: 'fetched' }, 24 * 30)).toBe(60_000);
    expect(pollMs(s({ ingest_state: 'due' }))).toBe(60_000);
  });

  it('stops when final, failed or cancelled, and before any data', () => {
    expect(interval({ ingest_state: 'final' }, 1)).toBe(false);
    expect(interval({ ingest_state: 'failed', fail_count: 9 }, 1)).toBe(false);
    for (const ingest_state of ['scheduled', 'due', 'fetched'] as const)
      expect(interval({ ingest_state, is_cancelled: true }, -48)).toBe(false);
    const refetch = sessionQuery(1).refetchInterval as (q: { state: { data: undefined } }) => number | false;
    expect(refetch({ state: { data: undefined } })).toBe(false);
    expect(pollMs(s({ ingest_state: 'final' }))).toBe(false);
  });
});

describe('the rain map refresh (rainQuery)', () => {
  type Q = { state: { data: Rain | undefined } };
  const grid = { map_id: 'it-1922', centre_lat: 45.6, centre_lon: 9.3, size: 7, step_m: 1500 };
  const interval = (live: boolean, data: Rain | undefined) =>
    (rainQuery(1, live).refetchInterval as (q: Q) => number | false)({ state: { data } });

  it('polls every 60 s in the player (live), and on the session tab while the grid is live (E2)', () => {
    for (const data of [undefined, { grid: null, frames: [] }, { grid: { ...grid, state: 'final' }, frames: [] }])
      expect(interval(true, data as Rain | undefined)).toBe(60_000);
    expect(interval(false, { grid: { ...grid, state: 'live' }, frames: [] })).toBe(60_000);
  });

  it('does not poll on the session tab for a final or failed grid, no grid or no answer', () => {
    expect(interval(false, { grid: { ...grid, state: 'final' }, frames: [] })).toBe(false);
    expect(interval(false, { grid: { ...grid, state: 'failed' }, frames: [] })).toBe(false);
    expect(interval(false, { grid: null, frames: [] })).toBe(false);
    expect(interval(false, undefined)).toBe(false);
  });
});
