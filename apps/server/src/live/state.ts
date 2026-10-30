import { z } from 'zod';

// Typed views on the feed state (A§11.3). Every field is optional and a bad leaf becomes undefined
// (.catch), so one odd value never hides a topic; unknown fields pass through raw. Index-keyed
// collections (the state holds no arrays, merge.ts) are records. CarData.z and Position.z are
// recorded only, never parsed.

const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const str = opt(z.string());
const int = opt(z.number().int());
const bool = opt(z.boolean());
const obj = <T extends z.ZodRawShape>(shape: T) => opt(z.looseObject(shape));
const rec = <T extends z.ZodType>(value: T) => opt(z.record(z.string(), opt(value)));

const Driver = z.looseObject({
  RacingNumber: str,
  BroadcastName: str,
  FullName: str,
  FirstName: str,
  LastName: str,
  Tla: str,
  Line: int,
  TeamName: str,
  TeamColour: str,
  CountryCode: str,
});
const Flagged = { Value: str, Status: int, OverallFastest: bool, PersonalFastest: bool };
const Sector = z.looseObject({
  ...Flagged,
  PreviousValue: str,
  Segments: rec(z.looseObject({ Status: int })),
});
const TimingLine = z.looseObject({
  RacingNumber: str,
  Line: int,
  Position: str,
  NumberOfLaps: int,
  NumberOfPitStops: int,
  LastLapTime: obj(Flagged),
  BestLapTime: obj({ Value: str, Lap: int }),
  Sectors: rec(Sector),
  Speeds: obj({ I1: obj(Flagged), I2: obj(Flagged), FL: obj(Flagged), ST: obj(Flagged) }),
  InPit: bool,
  PitOut: bool,
  GapToLeader: str,
  IntervalToPositionAhead: obj({ Value: str, Catching: bool }),
  Retired: bool,
  Stopped: bool,
  KnockedOut: bool,
});
// The feed sends New and TyresNotChanged as strings ("true", "0"; FastF1 compares New with "true").
const Stint = z.looseObject({
  Compound: str,
  New: str,
  TyresNotChanged: str,
  TotalLaps: int,
  StartLaps: int,
  LapNumber: int,
  LapTime: str,
});
const Best = { Value: str, Position: int };
const StatsLine = z.looseObject({
  RacingNumber: str,
  Line: int,
  PersonalBestLapTime: obj({ ...Best, Lap: int }),
  BestSectors: rec(z.looseObject(Best)),
  BestSpeeds: obj({ I1: obj(Best), I2: obj(Best), FL: obj(Best), ST: obj(Best) }),
});
const Message = z.looseObject({
  Utc: str,
  Lap: int,
  Category: str,
  Flag: str,
  Scope: str,
  Sector: int,
  RacingNumber: str,
  Message: str,
});

const views = {
  DriverList: z.record(z.string(), opt(Driver)),
  TimingData: z.looseObject({ SessionPart: int, Withheld: bool, Lines: rec(TimingLine) }),
  TimingAppData: z.looseObject({ Lines: rec(z.looseObject({ RacingNumber: str, GridPos: str, Stints: rec(Stint) })) }),
  TimingStats: z.looseObject({ Withheld: bool, SessionType: str, Lines: rec(StatsLine) }),
  SessionInfo: z.looseObject({
    Key: int,
    Type: str,
    Name: str,
    Path: str,
    StartDate: str,
    EndDate: str,
    GmtOffset: str,
    Meeting: obj({ Key: int, Name: str, OfficialName: str, Location: str }),
  }),
  SessionStatus: z.looseObject({ Status: str, Started: str }),
  SessionData: z.looseObject({
    Series: rec(z.looseObject({ Utc: str, Lap: int, QualifyingPart: int })),
    StatusSeries: rec(z.looseObject({ Utc: str, SessionStatus: str, TrackStatus: str })),
  }),
  TrackStatus: z.looseObject({ Status: str, Message: str }),
  LapCount: z.looseObject({ CurrentLap: int, TotalLaps: int }),
  RaceControlMessages: z.looseObject({ Messages: rec(Message) }),
  ExtrapolatedClock: z.looseObject({ Utc: str, Remaining: str, Extrapolating: bool }),
  WeatherData: z.looseObject({
    AirTemp: str,
    Humidity: str,
    Pressure: str,
    Rainfall: str,
    TrackTemp: str,
    WindDirection: str,
    WindSpeed: str,
  }),
};

export type Views = { [K in keyof typeof views]: z.output<(typeof views)[K]> };

/** The typed value of one topic, or undefined when it is absent or no object. */
export function view<N extends keyof Views>(state: Readonly<Record<string, unknown>>, name: N): Views[N] | undefined {
  if (!Object.hasOwn(state, name)) return undefined;
  const parsed = views[name].safeParse(state[name]);
  return parsed.success ? (parsed.data as Views[N]) : undefined;
}
