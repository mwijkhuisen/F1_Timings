import { Live, Recordings, Season, Seasons } from '@f1/contracts';

// A hand-built 2026 for the season page and the header (P4c). NOW is Sat 7 Nov 14:30Z, inside São Paulo's weekend,
// where every state shows once: FP1 ready, FP2 cancelled, SQ recorded, FP3 pending, Sprint live, Quali next,
// Race scheduled. Rounds: testing none, Mexico 1, Emilia Romagna (cancelled) none, São Paulo 2, Las Vegas 3.

export const NOW = Date.parse('2026-11-07T14:30:00.000Z');

const hour = 3_600_000;
const session = (
  session_key: number,
  name: string,
  date_start: string,
  ingest_state = 'scheduled',
  is_cancelled = false,
) => ({
  session_key,
  type: name === 'Race' || name === 'Sprint' ? 'Race' : 'Practice',
  name,
  date_start,
  date_end: new Date(Date.parse(date_start) + hour).toISOString(),
  ingest_state,
  is_cancelled,
});
const meeting = (
  meeting_key: number,
  name: string,
  country_code: string,
  circuit_short_name: string,
  gmt_offset: string,
  sessions: ReturnType<typeof session>[],
  is_cancelled = false,
) => ({
  meeting_key,
  name,
  official_name: null,
  location: circuit_short_name,
  country_code,
  circuit_short_name,
  gmt_offset,
  date_start: null,
  date_end: null,
  is_cancelled,
  sessions,
});

export const season = Season.parse([
  meeting(1300, 'Pre-Season Testing', 'BRN', 'Sakhir', '03:00:00', [
    session(9000, 'Day 1', '2026-02-11T07:00:00.000Z', 'final'),
  ]),
  meeting(1310, 'Mexico City Grand Prix', 'MEX', 'Mexico City', '-06:00:00', [
    session(9001, 'Qualifying', '2026-10-24T21:00:00.000Z', 'final'),
    session(9002, 'Race', '2026-10-25T20:00:00.000Z', 'final'),
  ]),
  meeting(
    1315,
    'Emilia Romagna Grand Prix',
    'ITA',
    'Imola',
    '02:00:00',
    [session(9010, 'Race', '2026-11-01T13:00:00.000Z')],
    true,
  ),
  meeting(1320, 'São Paulo Grand Prix', 'BRA', 'Interlagos', '-03:00:00', [
    session(9101, 'Practice 1', '2026-11-06T14:30:00.000Z', 'final'),
    session(9102, 'Practice 2', '2026-11-06T16:00:00.000Z', 'scheduled', true),
    session(9103, 'Sprint Qualifying', '2026-11-06T18:30:00.000Z', 'fetched'),
    session(9104, 'Practice 3', '2026-11-07T12:00:00.000Z', 'due'),
    session(9105, 'Sprint', '2026-11-07T14:00:00.000Z', 'due'),
    session(9106, 'Qualifying', '2026-11-07T18:00:00.000Z'),
    session(9107, 'Race', '2026-11-08T17:00:00.000Z'),
  ]),
  meeting(1330, 'Las Vegas Grand Prix', 'USA', 'Las Vegas', '-08:00:00', [
    session(9201, 'Race', '2026-11-22T04:00:00.000Z'),
  ]),
]);

export const seasons = Seasons.parse([
  { year: 2027, meetings: 0, sessions: 0 },
  { year: 2026, meetings: 5, sessions: 11 },
  { year: 2025, meetings: 24, sessions: 120 },
]);

const recording = (id: number, session_key: number, session_name: string, ended_at: string | null) => ({
  id,
  session_key,
  year: 2026,
  meeting_name: 'São Paulo Grand Prix',
  session_name,
  session_type: 'Race',
  date_start: '2026-11-06T18:30:00.000Z',
  started_at: '2026-11-06T17:30:00.000Z',
  ended_at,
  complete: ended_at !== null,
});

/** Newest first: the open Sprint recording, then the Sprint Qualifying one. */
export const recordings = Recordings.parse([
  recording(42, 9105, 'Sprint', null),
  recording(41, 9103, 'Sprint Qualifying', '2026-11-06T19:40:00.000Z'),
]);

export const live = Live.parse({
  session: {
    session_key: 9105,
    meeting_name: 'São Paulo Grand Prix',
    session_name: 'Sprint',
    date_start: '2026-11-07T14:00:00.000Z',
    date_end: '2026-11-07T15:00:00.000Z',
  },
  recording: { id: 42, started_at: '2026-11-07T13:00:00.000Z', ended_at: null, complete: false },
});
