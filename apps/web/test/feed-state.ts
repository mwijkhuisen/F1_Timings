import type { Obj } from '@f1/contracts';

// Synthetic feed states for the pit-wall tests (A§11.3 format, invented values; docs/design/…/mockup/synth.mjs is
// the example). Nothing here comes from a recording.

export const DRIVERS = {
  '1': { Tla: 'AAA', FullName: 'Ann A', TeamColour: 'FF0000' },
  '2': { Tla: 'BBB', FullName: 'Bob B', TeamColour: '00FF00' },
  '3': { Tla: 'CCC' },
  '4': { Tla: 'DDD' },
  '5': { Tla: 'EEE' },
};

/** A race-control message: lap, Category, text. */
export type Msg = [lap: number, category: string, text: string];

/** RaceControlMessages with `msgs` under keys `from`, `from + 1`, … */
export const messages = (msgs: Msg[], from = 0): Obj => ({
  Messages: Object.fromEntries(
    msgs.map(([Lap, Category, Message], i) => [
      String(from + i),
      { Utc: `2026-01-11T14:${String(10 + from + i).padStart(2, '0')}:00`, Lap, Category, Message },
    ]),
  ),
});

type Options = {
  session?: string;
  track?: string;
  msgs?: Msg[];
  /** Extra topics or replacements, merged over the defaults at the top level. */
  extra?: Obj;
};

/**
 * A race at lap 12 of 57. AAA leads (from P3 on the grid), BBB is 0.4 s behind (from pole), CCC 1.000 s behind BBB
 * (P2 on the grid), DDD is a lap down with no usable grid position, EEE is retired 0.2 s behind DDD (grid 5).
 * BBB holds the fastest lap.
 */
export function raceState({ session = 'Started', track = '1', msgs = [], extra = {} }: Options = {}): Obj {
  return {
    SessionInfo: { Key: 9100, Type: 'Race', Name: 'Race' },
    SessionStatus: { Status: session },
    TrackStatus: { Status: track },
    LapCount: { CurrentLap: 12, TotalLaps: 57 },
    ExtrapolatedClock: { Utc: '2026-01-11T14:20:00.000Z', Remaining: '01:30:05', Extrapolating: true },
    WeatherData: { AirTemp: '22.4', TrackTemp: '43.1', Rainfall: '0', Humidity: '40.0' },
    DriverList: DRIVERS,
    TimingData: {
      Lines: {
        '1': { Line: 1, Position: '1', GapToLeader: 'LAP 12', IntervalToPositionAhead: { Value: 'LAP 12' } },
        '2': { Line: 2, Position: '2', GapToLeader: '+0.400', IntervalToPositionAhead: { Value: '+0.400' } },
        '3': { Line: 3, Position: '3', GapToLeader: '+1.400', IntervalToPositionAhead: { Value: '+1.000' } },
        '4': { Line: 4, Position: '4', GapToLeader: '1L', IntervalToPositionAhead: { Value: '1L' } },
        '5': {
          Line: 5,
          Position: '5',
          GapToLeader: '1L',
          IntervalToPositionAhead: { Value: '+0.200' },
          Retired: true,
        },
      },
    },
    TimingAppData: {
      Lines: {
        '1': { GridPos: '3' },
        '2': { GridPos: '1' },
        '3': { GridPos: '2' },
        '4': { GridPos: '' },
        '5': { GridPos: '5' },
      },
    },
    TimingStats: {
      Lines: {
        '1': { PersonalBestLapTime: { Value: '1:21.000', Position: 2, Lap: 8 } },
        '2': { PersonalBestLapTime: { Value: '1:20.500', Position: 1, Lap: 9 } },
      },
    },
    RaceControlMessages: messages(msgs),
    ...extra,
  };
}

/** Practice: AAA fastest, BBB 0.3 s off and 0.3 s behind (no race, so nothing is "within a second"). */
export function practiceState({ session = 'Started', track = '1', extra = {} }: Options = {}): Obj {
  return {
    SessionInfo: { Key: 9101, Type: 'Practice', Name: 'Practice 1' },
    SessionStatus: { Status: session },
    TrackStatus: { Status: track },
    ExtrapolatedClock: { Utc: '2026-01-10T11:00:00Z', Remaining: '00:59:59', Extrapolating: false },
    DriverList: DRIVERS,
    TimingData: {
      Lines: {
        '1': { Line: 1, Position: '1', BestLapTime: { Value: '1:20.000' }, TimeDiffToFastest: '' },
        '2': {
          Line: 2,
          Position: '2',
          BestLapTime: { Value: '1:20.300' },
          TimeDiffToFastest: '+0.300',
          TimeDiffToPositionAhead: '+0.300',
          IntervalToPositionAhead: { Value: '+0.300' },
        },
      },
    },
    TimingAppData: { Lines: { '1': { GridPos: '2' }, '2': { GridPos: '1' } } },
    ...extra,
  };
}

/** Qualifying in Q2: BBB fastest, AAA 0.1 s off. */
export function qualifyingState({ session = 'Started', track = '1', extra = {} }: Options = {}): Obj {
  const stats = (gap: string) => ({ '1': { TimeDiffToFastest: gap, TimeDifftoPositionAhead: gap } });
  return {
    SessionInfo: { Key: 9102, Type: 'Qualifying', Name: 'Qualifying' },
    SessionStatus: { Status: session },
    TrackStatus: { Status: track },
    DriverList: DRIVERS,
    TimingData: {
      SessionPart: 2,
      Lines: {
        '2': { Line: 1, Position: '1', Stats: stats(''), BestLapTimes: { '1': { Value: '1:19.900' } } },
        '1': { Line: 2, Position: '2', Stats: stats('+0.100'), BestLapTimes: { '1': { Value: '1:20.000' } } },
      },
    },
    TimingAppData: { Lines: { '1': { GridPos: '1' }, '2': { GridPos: '2' } } },
    ...extra,
  };
}
