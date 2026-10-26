import { z } from 'zod';

// zod schemas for the OpenF1 endpoints P1 uses (A§6.1). Only the keys and the
// fields A§7 stores; unknown fields are stripped, so a new OpenF1 field never
// breaks parsing (the raw body is stored whole, A§2 principle 3). A field is
// nullable where the 2026-10-25 scan saw a null (full responses of 11388,
// 11392, 11383 and 7953, plus meetings and sessions for 2023–2026).

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

const date = z.iso.datetime({ offset: true });
const seconds = z.number().nullable();
const kph = z.number().nullable();
// 0 = n/a, 2048 yellow, 2049 green, 2051 purple, 2064 pit lane (A§6.1); single segments can be null.
const segments = z.array(z.number().nullable()).nullable();
// A race gives one number (gap_to_leader may be a string such as "+1 LAP"); qualifying gives Q1–Q3.
const perPhase = z.array(z.number().nullable());

const Meeting = z.object({
  meeting_key: z.number(),
  year: z.number(),
  meeting_name: z.string(),
  meeting_official_name: z.string(),
  location: z.string(),
  country_code: z.string(),
  circuit_short_name: z.string(),
  gmt_offset: z.string(),
  date_start: date,
  date_end: date,
  is_cancelled: z.boolean(),
});

const Session = z.object({
  session_key: z.number(),
  meeting_key: z.number(),
  year: z.number(),
  session_type: z.string(),
  session_name: z.string(),
  date_start: date,
  date_end: date,
  is_cancelled: z.boolean(),
});

const Driver = z.object({
  session_key: z.number(),
  driver_number: z.number(),
  name_acronym: z.string(),
  full_name: z.string(),
  team_name: z.string(),
  team_colour: z.string(),
});

const Lap = z.object({
  session_key: z.number(),
  driver_number: z.number(),
  lap_number: z.number(),
  date_start: date.nullable(),
  lap_duration: seconds,
  duration_sector_1: seconds,
  duration_sector_2: seconds,
  duration_sector_3: seconds,
  i1_speed: kph,
  i2_speed: kph,
  st_speed: kph,
  is_pit_out_lap: z.boolean(),
  segments_sector_1: segments,
  segments_sector_2: segments,
  segments_sector_3: segments,
});

const Stint = z.object({
  session_key: z.number(),
  driver_number: z.number(),
  stint_number: z.number(),
  lap_start: z.number(),
  lap_end: z.number(),
  compound: z.string(),
  tyre_age_at_start: z.number(),
});

const Pit = z.object({
  session_key: z.number(),
  driver_number: z.number(),
  lap_number: z.number(),
  date: date,
  pit_duration: seconds,
  lane_duration: seconds,
  stop_duration: seconds,
});

const RaceControl = z.object({
  session_key: z.number(),
  date: date,
  category: z.string(),
  flag: z.string().nullable(),
  scope: z.string().nullable(),
  sector: z.number().nullable(),
  driver_number: z.number().nullable(),
  lap_number: z.number().nullable(),
  qualifying_phase: z.number().nullable(),
  message: z.string(),
});

const SessionResult = z.object({
  session_key: z.number(),
  driver_number: z.number(),
  position: z.number().nullable(),
  number_of_laps: z.number(),
  dnf: z.boolean(),
  dns: z.boolean(),
  dsq: z.boolean(),
  duration: z.union([z.number(), perPhase]).nullable(),
  gap_to_leader: z.union([z.number(), z.string(), perPhase]).nullable(),
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
