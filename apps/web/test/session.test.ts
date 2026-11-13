import type { Live, SessionDetail } from '@f1/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionQuery } from '../src/lib/api.ts';
import { errorWords, LIVE_TEXT, noDataText, pollMs, sourceWords } from '../src/lib/session.ts';
import { sessionDetail } from './laps.ts';

// Why a session's tab has no data, and when its page refreshes (#99, A§13), on a hand-built session.

type S = SessionDetail['session'];
const START = '2026-10-31T19:00:00.000Z';
const END = '2026-10-31T21:00:00.000Z';
const H = 3_600_000;
const at = (h: number) => Date.parse(END) + h * H;
const base = sessionDetail('Race', 'Race').session;
const s = (over: Partial<S> = {}): S => ({ ...base, date_start: START, date_end: END, ...over });
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

  it('in back-off: the failure in words and the next try in Amsterdam time', () => {
    // 2026-10-31T21:05Z is 22:05 in Amsterdam (CET).
    const backoff = {
      ingest_state: 'due',
      fail_count: 2,
      last_error: 'schema',
      next_fetch_at: '2026-10-31T21:05:00.000Z',
    } as const;
    expect(text(backoff, 1)).toBe('The fetch failed (unexpected data); next try at 22:05.');
    // Back-off wins over the 24 h queue.
    expect(text({ ...backoff, last_error: 'http_503' }, 48)).toBe('The fetch failed (HTTP 503); next try at 22:05.');
    expect(text({ ...backoff, next_fetch_at: null }, 1)).toBe('The fetch failed (unexpected data).');
  });

  it('failed: the count and the error, not retried', () => {
    expect(text({ ingest_state: 'failed', fail_count: 9, last_error: 'timeout' }, 48)).toBe(
      'The fetch failed 9 times (timed out) and is not retried.',
    );
  });

  it('fetched or due past date_end + 24 h: queued for a new fetch', () => {
    expect(text({ ingest_state: 'fetched' }, 24)).toBe('No laps in the OpenF1 data.');
    expect(text({ ingest_state: 'fetched' }, 24 + 1 / H)).toBe('Queued for a new fetch; check back later.');
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

  it('fetched within the day or final: none in the session’s source', () => {
    expect(text({ ingest_state: 'final' }, 48)).toBe('No laps in the OpenF1 data.');
    expect(text({ ingest_state: 'final', source: 'f1-archive' }, 48)).toBe('No laps in the F1 archive.');
    expect(text({ ingest_state: 'final', source: 'f1-live' }, 48)).toBe('No laps in the F1 live feed.');
    expect(text({ ingest_state: 'final', source: 'jolpica' }, 48)).toBe('No laps in the Jolpica data.');
    expect(noDataText(s({ ingest_state: 'fetched' }), null, at(1), 'weather')).toBe('No weather in the OpenF1 data.');
    expect(noDataText(s({ ingest_state: 'final' }), null, at(48), 'stints')).toBe('No stints in the OpenF1 data.');
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

  it('polls every 60 s while scheduled or due, and fetched until date_end + 24 h', () => {
    expect(interval({ ingest_state: 'scheduled' }, -48)).toBe(60_000);
    expect(interval({ ingest_state: 'due', fail_count: 3 }, 2)).toBe(60_000);
    expect(interval({ ingest_state: 'fetched' }, 3)).toBe(60_000);
    expect(interval({ ingest_state: 'fetched' }, 24)).toBe(60_000);
  });

  it('stops when fetched past date_end + 24 h, final, failed or cancelled, and before any data', () => {
    expect(interval({ ingest_state: 'fetched' }, 24 + 1 / H)).toBe(false);
    expect(interval({ ingest_state: 'final' }, 1)).toBe(false);
    expect(interval({ ingest_state: 'failed', fail_count: 9 }, 1)).toBe(false);
    expect(interval({ ingest_state: 'scheduled', is_cancelled: true }, -48)).toBe(false);
    const refetch = sessionQuery(1).refetchInterval as (q: { state: { data: undefined } }) => number | false;
    expect(refetch({ state: { data: undefined } })).toBe(false);
  });

  it('is the same rule the page passes to the laps, stints and weather', () => {
    expect(pollMs(s({ ingest_state: 'fetched' }), at(1))).toBe(60_000);
    expect(pollMs(s({ ingest_state: 'final' }), at(1))).toBe(false);
  });
});
