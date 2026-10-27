import { z } from 'zod';

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
});

export type Seasons = z.infer<typeof Seasons>;
export type Season = z.infer<typeof Season>;
export type SessionDetail = z.infer<typeof SessionDetail>;
export type Lap = z.infer<typeof Lap>;
export type Laps = z.infer<typeof Laps>;
export type Stints = z.infer<typeof Stints>;
export type Pits = z.infer<typeof Pits>;
export type RaceControl = z.infer<typeof RaceControl>;
export type Status = z.infer<typeof Status>;

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
