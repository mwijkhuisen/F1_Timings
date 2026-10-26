import { z } from 'zod';

// zod schemas for the OpenF1 endpoints P1 uses (A§6.1). Only the keys and the
// fields A§7 stores; unknown fields are stripped, so a new OpenF1 field never
// breaks parsing (the raw body is stored whole, A§2 principle 3).
//
// Required: the row keys, `meeting.year` and the session dates (NOT NULL columns).
// Every other field may be null or missing (it parses to null): a four-session scan
// missed nulls that real 2023–2026 data has (the P1b backfill: a null stint
// compound, a null number_of_laps, a string position). Each field is checked
// against its column, so a value zod accepts never fails an INSERT: integers fit
// smallint/int, seconds fit int milliseconds, and text has no NUL character.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Null or missing → null. */
const opt = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);
const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const int16 = z.number().int().min(-32_768).max(32_767);
const text = z.string().refine((s) => !s.includes('\0'), 'NUL');
const date = z.iso.datetime({ offset: true });
// Rounded to integer ms / km/h by the normaliser: the bounds keep the result in int / smallint.
const seconds = z.number().min(-2_147_483).max(2_147_483);
const kph = z.number().min(-32_768).max(32_767);
// 0 = n/a, 2048 yellow, 2049 green, 2051 purple, 2064 pit lane (A§6.1); single segments can be null.
const segments = opt(z.array(int16.nullable()));
// A race gives one number (gap_to_leader may be a string such as "+1 LAP"); qualifying gives Q1–Q3.
const perPhase = z.array(seconds.nullable());

const Meeting = z.object({
  meeting_key: int32,
  year: int16,
  meeting_name: opt(text),
  meeting_official_name: opt(text),
  location: opt(text),
  country_code: opt(text),
  circuit_short_name: opt(text),
  gmt_offset: opt(text),
  date_start: opt(date),
  date_end: opt(date),
  is_cancelled: opt(z.boolean()),
});

const Session = z.object({
  session_key: int32,
  meeting_key: int32,
  year: opt(z.number()), // not stored
  session_type: opt(text),
  session_name: opt(text),
  date_start: date,
  date_end: date,
  is_cancelled: opt(z.boolean()),
});

const Driver = z.object({
  session_key: int32,
  driver_number: int16,
  name_acronym: opt(text),
  full_name: opt(text),
  team_name: opt(text),
  team_colour: opt(text),
});

const Lap = z.object({
  session_key: int32,
  driver_number: int16,
  lap_number: int16,
  date_start: opt(date),
  lap_duration: opt(seconds),
  duration_sector_1: opt(seconds),
  duration_sector_2: opt(seconds),
  duration_sector_3: opt(seconds),
  i1_speed: opt(kph),
  i2_speed: opt(kph),
  st_speed: opt(kph),
  is_pit_out_lap: opt(z.boolean()),
  segments_sector_1: segments,
  segments_sector_2: segments,
  segments_sector_3: segments,
});

const Stint = z.object({
  session_key: int32,
  driver_number: int16,
  stint_number: int16,
  lap_start: opt(int16),
  lap_end: opt(int16),
  compound: opt(text),
  tyre_age_at_start: opt(int16),
});

const Pit = z.object({
  session_key: int32,
  driver_number: int16,
  lap_number: int16,
  date: opt(date),
  pit_duration: opt(seconds),
  lane_duration: opt(seconds),
  stop_duration: opt(seconds),
});

const RaceControl = z.object({
  session_key: int32,
  date: opt(date),
  category: opt(text),
  flag: opt(text),
  scope: opt(text),
  sector: opt(int16),
  driver_number: opt(int16),
  lap_number: opt(int16),
  qualifying_phase: opt(int16),
  message: opt(text),
});

const SessionResult = z.object({
  session_key: int32,
  driver_number: int16,
  // A number, or a string such as "1" or "DQ" (the normaliser keeps only a number).
  position: opt(z.union([z.number(), z.string()])),
  number_of_laps: opt(int16),
  dnf: opt(z.boolean()),
  dns: opt(z.boolean()),
  dsq: opt(z.boolean()),
  duration: opt(z.union([seconds, perPhase])),
  gap_to_leader: opt(z.union([seconds, z.string(), perPhase])),
});

export const schemas = {
  meetings: z.array(Meeting),
  sessions: z.array(Session),
  drivers: z.array(Driver),
  laps: z.array(Lap),
  stints: z.array(Stint),
  pit: z.array(Pit),
  race_control: z.array(RaceControl),
  session_result: z.array(SessionResult),
};

export type Endpoint = keyof typeof schemas;
export const ENDPOINTS = Object.keys(schemas) as Endpoint[];
export type Rows<E extends Endpoint> = z.infer<(typeof schemas)[E]>;
export type Meeting = z.infer<typeof Meeting>;
export type Session = z.infer<typeof Session>;
export type Driver = z.infer<typeof Driver>;
export type Lap = z.infer<typeof Lap>;
export type Stint = z.infer<typeof Stint>;
export type Pit = z.infer<typeof Pit>;
export type RaceControl = z.infer<typeof RaceControl>;
export type SessionResult = z.infer<typeof SessionResult>;

/** Paths and codes only, never a value from the body. */
export type ShapeError = { code: 'shape'; issues: { path: string; code: string }[] };
const MAX_ISSUES = 10;

/** Never throws: a typed value or a typed error. */
export function parse<E extends Endpoint>(endpoint: E, body: unknown): Result<Rows<E>, ShapeError> {
  const result = schemas[endpoint].safeParse(body);
  if (result.success) return { ok: true, value: result.data as Rows<E> };
  const issues = result.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join(''),
    code: issue.code,
  }));
  return { ok: false, error: { code: 'shape', issues } };
}
