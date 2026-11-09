import { z } from 'zod';
import type { Views } from './live.ts';

export * from './live.ts';

// The zod contracts of every API answer (A§10), shared by the server and the web.
// Field names are the A§7 column names (snake_case, no mapping layer). Nullability
// follows the DDL: a NOT NULL column is never nullable here. Our own objects are
// strict, so drift between the server and a contract fails the tests. No z.config
// here: the web entry sets `jitless` (D12).

const int = z.number().int();
/** pg timestamptz → Date → toJSON. */
const date = z.iso.datetime();
const text = z.string().nullable();
const ms = int.nullable();
const segments = z.array(int.nullable()).nullable();
const ingestState = z.enum(['scheduled', 'due', 'fetched', 'final', 'failed']);

const Colour = z.enum(['purple', 'green', 'yellow']).nullable();

export const Seasons = z.array(z.strictObject({ year: int, meetings: int, sessions: int }));

const SeasonSession = z.strictObject({
  session_key: int,
  type: text,
  name: text,
  date_start: date,
  date_end: date,
  ingest_state: ingestState,
  is_cancelled: z.boolean(),
});

const MeetingFields = {
  meeting_key: int,
  name: text,
  official_name: text,
  location: text,
  country_code: text,
  circuit_short_name: text,
  gmt_offset: text,
  date_start: date.nullable(),
  date_end: date.nullable(),
  is_cancelled: z.boolean(),
};

export const Season = z.array(z.strictObject({ ...MeetingFields, sessions: z.array(SeasonSession) }));

export const SessionDetail = z.strictObject({
  session: z.strictObject({ ...SeasonSession.shape, meeting_key: int }),
  meeting: z.strictObject({ ...MeetingFields, year: int }),
  drivers: z.array(
    z.strictObject({
      driver_number: int,
      acronym: text,
      full_name: text,
      team_name: text,
      team_colour: text,
    }),
  ),
  results: z.array(
    z.strictObject({
      driver_number: int,
      position: int.nullable(),
      laps: int.nullable(),
      dnf: z.boolean().nullable(),
      dns: z.boolean().nullable(),
      dsq: z.boolean().nullable(),
      durations_ms: z.array(ms).nullable(),
      gaps_ms: z.array(ms).nullable(),
    }),
  ),
});

export const Lap = z.strictObject({
  driver_number: int,
  lap_number: int,
  date_start: date.nullable(),
  lap_ms: ms,
  s1_ms: ms,
  s2_ms: ms,
  s3_ms: ms,
  i1_kph: int.nullable(),
  i2_kph: int.nullable(),
  st_kph: int.nullable(),
  is_pit_out: z.boolean().nullable(),
  is_pit_in: z.boolean(),
  seg1: segments,
  seg2: segments,
  seg3: segments,
  deleted: z.boolean(),
  deleted_reason: text,
  quali_phase: int.nullable(),
  compound: text,
  colour: z.strictObject({ lap: Colour, s1: Colour, s2: Colour, s3: Colour }),
});
export const Laps = z.array(Lap);

export const Stints = z.array(
  z.strictObject({
    driver_number: int,
    stint_number: int,
    lap_start: int.nullable(),
    lap_end: int.nullable(),
    compound: text,
    tyre_age_at_start: int.nullable(),
  }),
);

export const Pits = z.array(
  z.strictObject({
    driver_number: int,
    lap_number: int,
    date: date.nullable(),
    pit_ms: ms,
    lane_ms: ms,
    stop_ms: ms,
  }),
);

export const RaceControl = z.array(
  z.strictObject({
    date: date.nullable(),
    category: text,
    flag: text,
    scope: text,
    sector: int.nullable(),
    driver_number: int.nullable(),
    lap_number: int.nullable(),
    qualifying_phase: int.nullable(),
    message: text,
  }),
);

// P5a: the track-side station's samples, by date (A§7). Temperatures °C, humidity %, pressure mbar (hPa), rainfall
// 0 or 1, wind direction in degrees, wind speed m/s; any of them may be null.
const reading = z.number().nullable();
export const Weather = z.array(
  z.strictObject({
    date,
    air_temperature: reading,
    track_temperature: reading,
    humidity: reading,
    pressure: reading,
    rainfall: int.nullable(),
    wind_direction: int.nullable(),
    wind_speed: reading,
  }),
);

// P5b (A§10, A§11.3): one feed WeatherData view as a Weather row at `t`. A field is its number when it is a non-blank
// string whose value is finite and fits the P5a column, else null: a `real` is 0 or 1e-37 ≤ |v| ≤ 3.4e38 (as in
// openf1/schemas.ts), rainfall and wind direction an integer within smallint. −0 becomes 0, so a row survives JSON.
// `t` is the receive time of a line the stream applied, so at most the stream's T (about now; the route bounds `at`
// to the recording), well within Date's range: toISOString would throw past ±8.64e15.
const num = (s: unknown, fits: (v: number) => boolean): number | null => {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) && fits(v) ? v + 0 : null;
};
const isReal = (v: number) => v === 0 || (Math.abs(v) >= 1e-37 && Math.abs(v) <= 3.4e38);
const isSmallint = (v: number) => Number.isInteger(v) && v >= -32768 && v <= 32767;

export function weatherRow(w: Views['WeatherData'] | undefined, t: number): Weather[number] {
  return {
    date: new Date(t).toISOString(),
    air_temperature: num(w?.AirTemp, isReal),
    track_temperature: num(w?.TrackTemp, isReal),
    humidity: num(w?.Humidity, isReal),
    pressure: num(w?.Pressure, isReal),
    rainfall: num(w?.Rainfall, isSmallint),
    wind_direction: num(w?.WindDirection, isSmallint),
    wind_speed: num(w?.WindSpeed, isReal),
  };
}

// A day at one a minute: bounds a stream's rows and the snapshot whatever the recording holds (real sessions send
// about one a minute, A§11.3).
export const MAX_WEATHER_ROWS = 1440;

/** A new array: `rows` plus `row`, the oldest dropped so it never holds more than MAX_WEATHER_ROWS. */
export function withWeatherRow(rows: Weather, row: Weather[number]): Weather {
  return [...rows.slice(Math.max(0, rows.length + 1 - MAX_WEATHER_ROWS)), row];
}

export const Status = z.strictObject({
  states: z.strictObject({ scheduled: int, due: int, fetched: int, final: int, failed: int }),
  cancelled: int,
  failed: z.array(
    z.strictObject({
      session_key: int,
      year: int,
      meeting_name: text,
      session_name: text,
      fail_count: int,
      last_error: text,
      next_fetch_at: date.nullable(),
    }),
  ),
  // The live recorder's one row (A§8), null until it has run; `stale` = no report for 5 minutes.
  recorder: z
    .strictObject({
      state: z.enum(['idle', 'connecting', 'recording']),
      session_key: int.nullable(),
      meeting_name: text,
      session_name: text,
      token_expires_at: date.nullable(),
      last_error: text,
      warning: z.enum(['token_expiring', 'login_failed', 'disk_low']).nullable(),
      stale: z.boolean(),
      updated_at: date,
    })
    .nullable(),
});

export const Live = z.strictObject({
  session: z
    .strictObject({ session_key: int, meeting_name: text, session_name: text, date_start: date, date_end: date })
    .nullable(),
  recording: z.strictObject({ id: int, started_at: date, ended_at: date.nullable(), complete: z.boolean() }).nullable(),
});

// Every recording, newest first, with its session and meeting.
export const Recordings = z.array(
  z.strictObject({
    id: int,
    session_key: int,
    year: int,
    meeting_name: text,
    session_name: text,
    session_type: text,
    date_start: date,
    started_at: date,
    ended_at: date.nullable(),
    complete: z.boolean(),
  }),
);

// The SSE events of /playback/:recording/stream (A§10); each event's data is one of these as JSON. `state` is
// {topic: value}; a delta's `data` is merged into state[topic] when it is an object, else it replaces it. A snapshot
// carries every lap and stint row so far; `laps` only the rows that changed since the last snapshot or `laps`, which
// replace the rows of the same (driver_number, lap_number) or (driver_number, stint_number). `weather` holds every
// WeatherData sample since the stream's last session switch, one row per applied WeatherData delta, at most the last
// MAX_WEATHER_ROWS; the client adds weatherRow of the merged view at the delta's t with withWeatherRow.
export const PlaybackSnapshot = z.strictObject({
  t: int,
  state: z.record(z.string(), z.unknown()),
  laps: Laps,
  stints: Stints,
  weather: Weather,
});
export const PlaybackLaps = z.strictObject({ t: int, laps: Laps, stints: Stints });
export const PlaybackDelta = z.strictObject({ t: int, topic: z.string(), data: z.unknown() });
export const PlaybackEnd = z.strictObject({ t: int });
// The heartbeat after 15 s without a write: a real event, because EventSource never delivers a comment to JS.
export const PlaybackPing = z.strictObject({ t: int });

export type Seasons = z.infer<typeof Seasons>;
export type Season = z.infer<typeof Season>;
export type SessionDetail = z.infer<typeof SessionDetail>;
export type Lap = z.infer<typeof Lap>;
export type Laps = z.infer<typeof Laps>;
export type Stints = z.infer<typeof Stints>;
export type Pits = z.infer<typeof Pits>;
export type RaceControl = z.infer<typeof RaceControl>;
export type Weather = z.infer<typeof Weather>;
export type Status = z.infer<typeof Status>;
export type Live = z.infer<typeof Live>;
export type Recordings = z.infer<typeof Recordings>;
export type PlaybackSnapshot = z.infer<typeof PlaybackSnapshot>;
export type PlaybackLaps = z.infer<typeof PlaybackLaps>;
export type PlaybackDelta = z.infer<typeof PlaybackDelta>;
export type PlaybackEnd = z.infer<typeof PlaybackEnd>;
export type PlaybackPing = z.infer<typeof PlaybackPing>;

export type SectorDelta = { lap_number: number; s1: number | null; s2: number | null; s3: number | null };

/** Per lap_number present in both lists: b − a per sector in ms, null when either value is null or either lap is deleted (D11). */
export function sectorDeltas(
  a: readonly Pick<Lap, 'lap_number' | 's1_ms' | 's2_ms' | 's3_ms' | 'deleted'>[],
  b: readonly Pick<Lap, 'lap_number' | 's1_ms' | 's2_ms' | 's3_ms' | 'deleted'>[],
): SectorDelta[] {
  const byLap = new Map(a.map((lap) => [lap.lap_number, lap]));
  const out: SectorDelta[] = [];
  for (const lb of b) {
    const la = byLap.get(lb.lap_number);
    if (!la) continue;
    const diff = (x: number | null, y: number | null) =>
      la.deleted || lb.deleted || x === null || y === null ? null : y - x;
    out.push({
      lap_number: lb.lap_number,
      s1: diff(la.s1_ms, lb.s1_ms),
      s2: diff(la.s2_ms, lb.s2_ms),
      s3: diff(la.s3_ms, lb.s3_ms),
    });
  }
  return out;
}
