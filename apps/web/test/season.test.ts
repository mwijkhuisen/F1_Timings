import { Live, Recordings, Season, Seasons } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import {
  type Meeting,
  meetingTarget,
  neighbours,
  nextSession,
  roundNumbers,
  type SeasonSession,
  sessionState,
  shortName,
  started,
  startPath,
  thisWeekend,
} from '../src/lib/season.ts';
import { fmtCountdown, fmtTrack } from '../src/lib/time.ts';

// The season page's and the header's decisions (A§13, P4c) on a hand-built season.

const at = (iso: string) => Date.parse(iso);

type S = { type?: string; end?: string; state?: string; cancelled?: boolean };
const session = (session_key: number, name: string, date_start: string, o: S = {}) => ({
  session_key,
  type: o.type ?? (name === 'Race' || name === 'Sprint' ? 'Race' : 'Practice'),
  name,
  date_start,
  date_end: o.end ?? new Date(at(date_start) + 3_600_000).toISOString(),
  ingest_state: o.state ?? 'scheduled',
  is_cancelled: o.cancelled ?? false,
});
const meeting = (meeting_key: number, name: string, sessions: ReturnType<typeof session>[], is_cancelled = false) => ({
  meeting_key,
  name,
  official_name: null,
  location: null,
  country_code: null,
  circuit_short_name: null,
  gmt_offset: null,
  date_start: null,
  date_end: null,
  is_cancelled,
  sessions,
});

const season = Season.parse([
  meeting(1000, 'Pre-Season Testing', [
    session(1, 'Day 1', '2026-02-11T07:00:00.000Z', { end: '2026-02-11T16:00:00.000Z', state: 'final' }),
    session(2, 'Day 2', '2026-02-12T07:00:00.000Z', { end: '2026-02-12T16:00:00.000Z', state: 'final' }),
  ]),
  meeting(1001, 'Australian Grand Prix', [
    session(10, 'Practice 1', '2026-03-06T01:30:00.000Z', { state: 'final' }),
    session(11, 'Qualifying', '2026-03-07T05:00:00.000Z', { state: 'final' }),
    session(12, 'Race', '2026-03-08T04:00:00.000Z', { end: '2026-03-08T06:00:00.000Z', state: 'final' }),
  ]),
  meeting(
    1002,
    'Bahrain Grand Prix',
    [
      session(20, 'Practice 1', '2026-04-10T11:30:00.000Z', { cancelled: true }),
      session(21, 'Race', '2026-04-12T15:00:00.000Z', { cancelled: true }),
    ],
    true,
  ),
  meeting(1003, 'Chinese Grand Prix', [
    session(30, 'Practice 1', '2026-04-17T03:30:00.000Z'),
    session(31, 'Sprint Qualifying', '2026-04-17T07:30:00.000Z', { cancelled: true }),
    session(32, 'Sprint', '2026-04-18T03:00:00.000Z'),
    session(33, 'Qualifying', '2026-04-18T07:00:00.000Z'),
    session(34, 'Race', '2026-04-19T07:00:00.000Z', { end: '2026-04-19T09:00:00.000Z' }),
  ]),
  // The race runs past midnight.
  meeting(1004, 'Las Vegas Grand Prix', [
    session(40, 'Qualifying', '2026-11-20T23:00:00.000Z'),
    session(41, 'Race', '2026-11-21T23:30:00.000Z', { end: '2026-11-22T01:30:00.000Z' }),
  ]),
  // The race is cancelled, practice ran.
  meeting(1005, 'Qatar Grand Prix', [
    session(50, 'Practice 1', '2026-11-27T13:30:00.000Z'),
    session(51, 'Race', '2026-11-29T16:00:00.000Z', { cancelled: true }),
  ]),
]);

const meetingOf = (key: number) => season.find((m) => m.meeting_key === key) as Meeting;
const sessionOf = (key: number) =>
  season.flatMap((m) => m.sessions).find((s) => s.session_key === key) as SeasonSession;

const live = (session_key: number | null, ended_at: string | null) =>
  Live.parse({
    session:
      session_key === null
        ? null
        : {
            session_key,
            meeting_name: null,
            session_name: null,
            date_start: '2026-04-19T07:00:00.000Z',
            date_end: '2026-04-19T09:00:00.000Z',
          },
    recording: { id: 1, started_at: '2026-04-19T06:00:00.000Z', ended_at, complete: false },
  });

describe('startPath: the / decision', () => {
  const seasons = (...rows: [number, number][]) =>
    Seasons.parse(rows.map(([year, sessions]) => ({ year, meetings: sessions > 0 ? 1 : 0, sessions })));

  it('opens /live while a recording is open', () => {
    expect(startPath(live(34, null), seasons([2026, 120]))).toBe('/live');
    expect(startPath(live(null, null), seasons([2026, 120]))).toBe('/live');
  });

  it('opens the season once the recording has ended, or without one', () => {
    expect(startPath(live(34, '2026-04-19T09:30:00.000Z'), seasons([2026, 120]))).toBe('/2026');
    expect(startPath(Live.parse({ session: null, recording: null }), seasons([2026, 120]))).toBe('/2026');
    expect(startPath(null, seasons([2026, 120]))).toBe('/2026');
  });

  it('opens the newest season with a session, even when none has started', () => {
    expect(startPath(null, seasons([2027, 24], [2026, 120]))).toBe('/2027');
  });

  it('skips a season without sessions', () => {
    expect(startPath(null, seasons([2027, 0], [2026, 120]))).toBe('/2026');
  });

  it('is null without seasons or sessions', () => {
    expect(startPath(null, [])).toBeNull();
    expect(startPath(null, seasons([2027, 0], [2026, 0]))).toBeNull();
  });
});

describe('thisWeekend: the weekend choice', () => {
  const weekend = (now: string, l: Live | null = null) => thisWeekend(season, at(now), l)?.meeting_key ?? null;

  it('picks the meeting in progress, from its first session start to its last session end', () => {
    expect(weekend('2026-03-06T01:30:00.000Z')).toBe(1001);
    expect(weekend('2026-03-07T12:00:00.000Z')).toBe(1001);
    expect(weekend('2026-03-08T06:00:00.000Z')).toBe(1001);
  });

  it('keeps a weekend whose last session runs past midnight', () => {
    expect(weekend('2026-11-22T01:00:00.000Z')).toBe(1004);
  });

  it('picks the next meeting between weekends, skipping a cancelled one', () => {
    expect(weekend('2026-03-09T06:00:01.000Z')).toBe(1003);
    expect(weekend('2026-04-11T00:00:00.000Z')).toBe(1003);
  });

  it('counts testing as a weekend', () => {
    expect(weekend('2026-01-01T00:00:00.000Z')).toBe(1000);
    expect(weekend('2026-02-12T10:00:00.000Z')).toBe(1000);
  });

  it('spans a meeting whose race is cancelled over its open sessions, and is null after the last meeting', () => {
    expect(weekend('2026-11-27T14:00:00.000Z')).toBe(1005);
    expect(weekend('2026-11-28T14:30:01.000Z')).toBeNull();
    expect(thisWeekend([], at('2026-01-01T00:00:00.000Z'), null)).toBeNull();
  });

  it('keeps the weekend while its race is recording past date_end, and moves on once it ends', () => {
    // A day past date_end, so the grace day is not what keeps it.
    const late = '2026-04-20T09:30:00.000Z';
    expect(weekend(late, live(34, null))).toBe(1003);
    expect(weekend(late)).toBe(1004);
    expect(weekend(late, live(34, '2026-04-19T09:25:00.000Z'))).toBe(1004);
    // An open recording of a session the season does not know changes nothing.
    expect(weekend(late, live(999, null))).toBe(1004);
  });

  it('keeps a finished meeting for 24 h after its last session ends (owner D1)', () => {
    expect(weekend('2026-03-08T06:00:01.000Z')).toBe(1001);
    expect(weekend('2026-03-09T05:59:00.000Z')).toBe(1001); // end + 23 h 59 min
    expect(weekend('2026-03-09T06:00:00.000Z')).toBe(1001); // end + 24 h, the last instant
    expect(weekend('2026-03-09T06:00:01.000Z')).toBe(1003);
  });

  it('prefers a meeting in progress to one in its grace day, and a grace day to the next meeting', () => {
    const two = Season.parse([
      meeting(2000, 'A', [session(60, 'Race', '2026-06-06T13:00:00.000Z')]),
      meeting(2001, 'B', [session(61, 'Race', '2026-06-07T10:00:00.000Z')]),
    ]);
    const key = (now: string) => thisWeekend(two, at(now), null)?.meeting_key;
    expect(key('2026-06-07T09:00:00.000Z')).toBe(2000); // A ended 14:00 the day before, B has not started
    expect(key('2026-06-07T10:30:00.000Z')).toBe(2001); // B is in progress, A is still in its grace day
  });
});

describe('started', () => {
  it('is true once a non-cancelled session of the meeting has started', () => {
    const m = meetingOf(1003);
    expect(started(m, at('2026-04-17T03:29:59.000Z'))).toBe(false);
    expect(started(m, at('2026-04-17T03:30:00.000Z'))).toBe(true);
    // Bahrain's sessions are all cancelled.
    expect(started(meetingOf(1002), at('2026-04-20T00:00:00.000Z'))).toBe(false);
  });
});

describe('nextSession', () => {
  it('is the first open session to start after now, across meetings', () => {
    expect(nextSession(season, at('2026-03-08T04:00:00.000Z'))?.session.session_key).toBe(30);
    expect(nextSession(season, at('2026-04-17T04:00:00.000Z'))?.session.session_key).toBe(32);
    expect(nextSession(season, at('2026-11-27T13:30:00.000Z'))).toBeNull();
  });
});

describe('sessionState', () => {
  const now = at('2026-04-18T08:00:00.000Z');
  const none = Recordings.parse([]);
  const state = (s: SeasonSession, o: { recordings?: Recordings; live?: Live | null; now?: number } = {}) =>
    sessionState(s, o.recordings ?? none, o.live ?? null, o.now ?? now, 34);
  const recording = (id: number, session_key: number, ended_at: string | null) => ({
    id,
    session_key,
    year: 2026,
    meeting_name: 'Chinese Grand Prix',
    session_name: 'Race',
    session_type: 'Race',
    date_start: '2026-04-19T07:00:00.000Z',
    started_at: '2026-04-19T06:00:00.000Z',
    ended_at,
    complete: ended_at !== null,
  });

  it('cancelled beats everything', () => {
    expect(state(sessionOf(31), { live: live(31, null) })).toEqual({ kind: 'cancelled' });
  });

  it('live now, also when the recording is still open after date_end', () => {
    expect(state(sessionOf(34), { live: live(34, null) })).toEqual({ kind: 'live' });
    expect(state(sessionOf(34), { live: live(34, null), now: at('2026-04-19T12:00:00.000Z') })).toEqual({
      kind: 'live',
    });
    expect(state(sessionOf(34), { live: live(33, null) })).toEqual({ kind: 'next' });
    expect(state(sessionOf(34), { live: live(34, '2026-04-19T09:30:00.000Z') })).toEqual({ kind: 'next' });
  });

  it('recorded, with the newest ended recording, beats laps ready', () => {
    const recordings = Recordings.parse([
      recording(9, 12, null),
      recording(8, 12, '2026-03-08T06:30:00.000Z'),
      recording(7, 12, '2026-03-08T06:20:00.000Z'),
      recording(6, 11, '2026-03-07T06:20:00.000Z'),
    ]);
    const s = state(sessionOf(12), { recordings });
    expect(s).toMatchObject({ kind: 'recorded', recording: { id: 8 } });
  });

  it('laps ready when fetched or final', () => {
    expect(state(sessionOf(12))).toEqual({ kind: 'ready' });
    expect(state({ ...sessionOf(33), ingest_state: 'fetched' })).toEqual({ kind: 'ready' });
  });

  it('laps pending once started without laps or a recording', () => {
    expect(state(sessionOf(33))).toEqual({ kind: 'pending' });
    expect(state({ ...sessionOf(33), ingest_state: 'failed' })).toEqual({ kind: 'pending' });
    expect(state(sessionOf(33), { now: at('2026-04-18T07:00:00.000Z') })).toEqual({ kind: 'pending' });
  });

  it('next for the next session, scheduled for the others', () => {
    expect(state(sessionOf(34))).toEqual({ kind: 'next' });
    expect(state(sessionOf(40))).toEqual({ kind: 'scheduled' });
  });
});

describe('roundNumbers', () => {
  const rounds = roundNumbers(season);

  it('numbers the meetings with a race: testing, a cancelled meeting and a cancelled race get none', () => {
    expect([...rounds]).toEqual([
      [1001, 1],
      [1003, 2],
      [1004, 3],
    ]);
  });

  it('numbers by the first open session start, not by array order', () => {
    expect([...roundNumbers([...season].reverse())]).toEqual([
      [1001, 1],
      [1003, 2],
      [1004, 3],
    ]);
  });

  it('counts a sprint weekend once, and M is the number of rounds', () => {
    expect(rounds.get(1003)).toBe(2);
    expect(rounds.size).toBe(3);
  });
});

describe('neighbours', () => {
  const keys = (key: number) => {
    const { prev, next } = neighbours(season, key);
    return [prev?.session.session_key ?? null, next?.session.session_key ?? null];
  };

  it('walks across meetings, skipping cancelled meetings and sessions', () => {
    expect(keys(12)).toEqual([11, 30]);
    expect(keys(30)).toEqual([12, 32]);
    expect(neighbours(season, 30).prev?.meeting.meeting_key).toBe(1001);
  });

  it('is null at either end of the season and for an unknown key', () => {
    expect(keys(1)).toEqual([null, 2]);
    expect(keys(50)).toEqual([41, null]);
    expect(keys(999)).toEqual([null, null]);
  });
});

describe('meetingTarget', () => {
  it('keeps the session name, else the first open session, else null', () => {
    expect(meetingTarget(meetingOf(1003), 'Qualifying')?.session_key).toBe(33);
    expect(meetingTarget(meetingOf(1001), 'Sprint')?.session_key).toBe(10);
    expect(meetingTarget(meetingOf(1003), 'Sprint Qualifying')?.session_key).toBe(30);
    expect(meetingTarget(meetingOf(1002), 'Race')).toBeNull();
  });
});

describe('shortName', () => {
  it.each([
    ['Practice 1', 'FP1'],
    ['Practice 3', 'FP3'],
    ['Qualifying', 'Quali'],
    ['Sprint Qualifying', 'SQ'],
    ['Sprint Shootout', 'SQ'],
    ['Sprint', 'Sprint'],
    ['Race', 'Race'],
    ['Day 2', 'Day 2'],
    ['constructor', 'constructor'],
    [null, '—'],
  ])('%s → %s', (name, short) => {
    expect(shortName(name)).toBe(short);
  });
});

describe('fmtTrack', () => {
  it.each([
    // Mexico City, OpenF1's negative form.
    ['2026-10-25T20:00:00.000Z', '-06:00:00', '14:00'],
    // Europe in summer, no `+`.
    ['2026-07-05T13:00:00.000Z', '02:00:00', '15:00'],
    ['2026-07-05T13:00:00.000Z', '02:00', '15:00'],
    // Las Vegas: Saturday night at the track is Sunday morning in Amsterdam.
    ['2026-11-22T06:00:00.000Z', '-08:00:00', 'Sat 22:00'],
    // Melbourne: Sunday morning at the track is Saturday night in Amsterdam.
    ['2026-03-07T22:30:00.000Z', '11:00:00', 'Sun 09:30'],
  ])('%s at %s → %s', (iso, offset, text) => {
    expect(fmtTrack(iso, offset)).toBe(text);
  });

  it.each([null, '', 'abc', '+02:00:00', '2:00:00', '02:60:00', '02:00:60', '15:00:00', ' 02:00:00', '02:00:00Z'])(
    '%j → null',
    (offset) => {
      expect(fmtTrack('2026-07-05T13:00:00.000Z', offset)).toBeNull();
    },
  );
});

describe('fmtCountdown', () => {
  it.each([
    [-1, 'now'],
    [0, 'now'],
    [1, '1 min'],
    [59_000, '1 min'],
    [59 * 60_000, '59 min'],
    [60 * 60_000, '1 h 0 min'],
    [(47 * 60 + 59) * 60_000, '47 h 59 min'],
    [48 * 3_600_000, '2 days 0 h'],
    [(77 * 60 + 1) * 60_000, '3 days 5 h'],
  ])('%i ms → %s', (ms, text) => {
    expect(fmtCountdown(ms)).toBe(text);
  });
});
