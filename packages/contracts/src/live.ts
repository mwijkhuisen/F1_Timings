import { z } from 'zod';

// The live feed state (A§11.3), shared by the server's parser and the web's stream client: browser-safe, zod is the
// only import.

// Topic deltas → state. Pure apart from mutating the state it is given.
//
// Objects merge key by key. An array in a delta is an index-keyed object ([a, b] ≡ {"0": a, "1": b}),
// so the state holds no arrays and a full state equals the merged deltas. A leaf (string, number,
// boolean, null) replaces, and so does an object replacing a leaf or the other way round. `_deleted: [k…]`
// removes those keys from the object it sits in (the archive's final .json states hold no `_deleted`), and
// the effective delta carries the keys that were really removed. Merge input
// is untrusted: the state's objects have no prototype, reads are own-property only, the keys
// __proto__, constructor and prototype are dropped, and objects nested deeper than MAX_DEPTH are dropped.

export type Obj = { [key: string]: unknown };

export const MAX_DEPTH = 32;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;
const empty = (): Obj => Object.create(null);

// `target` sits at nesting level `depth` (the root is 1); a child object would be at depth + 1.
function into(target: Obj, delta: object, depth: number): Obj | undefined {
  let effective: Obj | undefined;
  for (const [key, value] of Object.entries(delta)) {
    if (UNSAFE.has(key)) continue;
    if (key === '_deleted' && Array.isArray(value)) {
      const gone = value.map(String).filter((k) => Object.hasOwn(target, k));
      for (const k of gone) delete target[k];
      if (gone.length > 0) {
        effective ??= empty();
        effective[key] = gone;
      }
      continue;
    }
    const old = Object.hasOwn(target, key) ? target[key] : undefined;
    let changed: unknown;
    if (isObj(value)) {
      if (depth >= MAX_DEPTH) continue;
      if (isObj(old)) changed = into(old as Obj, value, depth + 1);
      else {
        // A new object counts as changed even when it is empty, so the effective deltas rebuild it.
        const fresh = empty();
        target[key] = fresh;
        changed = into(fresh, value, depth + 1) ?? empty();
      }
    } else {
      if (Object.hasOwn(target, key) && old === value) continue;
      target[key] = value;
      changed = value;
    }
    if (changed === undefined) continue;
    effective ??= empty();
    effective[key] = changed;
  }
  return effective;
}

/**
 * Merges `delta` into `target` (mutated) and returns the effective delta: only what changed, as
 * fresh objects that never alias the state. Undefined when nothing changed or `delta` is no object.
 */
export function merge(target: Obj, delta: unknown): Obj | undefined {
  return isObj(delta) ? into(target, delta, 1) : undefined;
}

// Typed views on the feed state. Every field is optional and a bad leaf becomes undefined
// (.catch), so one odd value never hides a topic; unknown fields pass through raw. Index-keyed
// collections (the state holds no arrays, see merge) are records. CarData.z and Position.z are
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
  // The gaps depend on the session type (A§11.3): a race sends GapToLeader and IntervalToPositionAhead, practice
  // TimeDiffToFastest and TimeDiffToPositionAhead, and qualifying both per part under Stats, with the interval spelt
  // TimeDifftoPositionAhead and the part's best lap under BestLapTimes, both keyed by SessionPart − 1. TimingData's
  // NoEntries holds the cars per part, so NoEntries[SessionPart] is the last place through.
  GapToLeader: str,
  IntervalToPositionAhead: obj({ Value: str, Catching: bool }),
  TimeDiffToFastest: str,
  TimeDiffToPositionAhead: str,
  Stats: rec(z.looseObject({ TimeDiffToFastest: str, TimeDifftoPositionAhead: str })),
  BestLapTimes: rec(z.looseObject({ Value: str, Lap: int })),
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
  TimingData: z.looseObject({
    SessionPart: int,
    NoEntries: rec(z.number().int()),
    Withheld: bool,
    Lines: rec(TimingLine),
  }),
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
