import type { Insertable } from 'kysely';
import type { DB } from '../db/db.ts';
import type { Driver, Lap, Meeting, Pit, RaceControl, Session, SessionResult, Stint } from '../openf1/schemas.ts';

// OpenF1 rows → A§7 rows. Pure. Seconds become integer ms, nulls stay null, source is 'openf1'.

const source = 'openf1';

export const ms = (s: number | null): number | null => (s === null ? null : Math.round(s * 1000));
const kph = (v: number | null) => (v === null ? null : Math.round(v));
// PostgreSQL arrays keep null elements; kysely-codegen types them as number[].
const array = (values: (number | null)[] | null) => values as number[] | null;
// A race gives one number, qualifying Q1–Q3; a non-numeric gap ("+1 LAP") becomes a null element.
const perPhase = (v: number | string | (number | null)[] | null) =>
  v === null ? null : array(typeof v === 'string' ? [null] : Array.isArray(v) ? v.map(ms) : [ms(v)]);

export const meetingRow = (m: Meeting): Insertable<DB['meeting']> => ({
  meeting_key: m.meeting_key,
  source,
  year: m.year,
  name: m.meeting_name,
  official_name: m.meeting_official_name,
  location: m.location,
  country_code: m.country_code,
  circuit_short_name: m.circuit_short_name,
  gmt_offset: m.gmt_offset,
  date_start: m.date_start,
  date_end: m.date_end,
});

export const sessionRow = (s: Session) => ({
  session_key: s.session_key,
  source,
  meeting_key: s.meeting_key,
  type: s.session_type,
  name: s.session_name,
  date_start: s.date_start,
  date_end: s.date_end,
});

export type SessionData = {
  drivers: Driver[];
  laps: Lap[];
  stints: Stint[];
  pit: Pit[];
  race_control: RaceControl[];
  session_result: SessionResult[];
};

export type SessionRows = {
  driver: Insertable<DB['driver']>[];
  lap: Insertable<DB['lap']>[];
  stint: Insertable<DB['stint']>[];
  pit: Insertable<DB['pit']>[];
  race_control: Insertable<DB['race_control']>[];
  result: Insertable<DB['result']>[];
};

/**
 * The child rows of one session. A row of another session is skipped (replace-per-session
 * must own every row it writes); of duplicate keys in one response the last wins. Both count
 * as `skipped`.
 */
export function normaliseSession(key: number, data: SessionData): { rows: SessionRows; skipped: number } {
  const keyed = <T extends { session_key: number }, R>(rows: T[], id: (r: T) => string, row: (r: T) => R): R[] => {
    const out = new Map<string, R>();
    for (const r of rows) if (r.session_key === key) out.set(id(r), row(r));
    return [...out.values()];
  };
  const perDriver = (r: { driver_number: number }, n: number) => `${r.driver_number}/${n}`;

  const lap = keyed(
    data.laps,
    (l) => perDriver(l, l.lap_number),
    (l) => ({
      session_key: key,
      source,
      driver_number: l.driver_number,
      lap_number: l.lap_number,
      date_start: l.date_start,
      lap_ms: ms(l.lap_duration),
      s1_ms: ms(l.duration_sector_1),
      s2_ms: ms(l.duration_sector_2),
      s3_ms: ms(l.duration_sector_3),
      i1_kph: kph(l.i1_speed),
      i2_kph: kph(l.i2_speed),
      st_kph: kph(l.st_speed),
      is_pit_out: l.is_pit_out_lap,
      is_pit_in: false,
      seg1: array(l.segments_sector_1),
      seg2: array(l.segments_sector_2),
      seg3: array(l.segments_sector_3),
    }),
  );
  // A§9: lap n is an in-lap when the same driver's lap n + 1 is an out-lap (not from `pit`).
  const outLaps = new Set(lap.filter((l) => l.is_pit_out).map((l) => perDriver(l, l.lap_number)));
  for (const l of lap) l.is_pit_in = outLaps.has(perDriver(l, l.lap_number + 1));

  const rows: SessionRows = {
    driver: keyed(
      data.drivers,
      (d) => String(d.driver_number),
      (d) => ({
        session_key: key,
        source,
        driver_number: d.driver_number,
        acronym: d.name_acronym,
        full_name: d.full_name,
        team_name: d.team_name,
        team_colour: d.team_colour,
      }),
    ),
    lap,
    stint: keyed(
      data.stints,
      (s) => perDriver(s, s.stint_number),
      (s) => ({
        session_key: key,
        source,
        driver_number: s.driver_number,
        stint_number: s.stint_number,
        lap_start: s.lap_start,
        lap_end: s.lap_end,
        compound: s.compound,
        tyre_age_at_start: s.tyre_age_at_start,
      }),
    ),
    pit: keyed(
      data.pit,
      (p) => perDriver(p, p.lap_number),
      (p) => ({
        session_key: key,
        source,
        driver_number: p.driver_number,
        lap_number: p.lap_number,
        date: p.date,
        pit_ms: ms(p.pit_duration),
        lane_ms: ms(p.lane_duration),
        stop_ms: ms(p.stop_duration),
      }),
    ),
    // No natural key: every message is a row.
    race_control: data.race_control
      .filter((r) => r.session_key === key)
      .map((r) => ({
        session_key: key,
        source,
        date: r.date,
        category: r.category,
        flag: r.flag,
        scope: r.scope,
        sector: r.sector,
        driver_number: r.driver_number,
        lap_number: r.lap_number,
        qualifying_phase: r.qualifying_phase,
        message: r.message,
      })),
    result: keyed(
      data.session_result,
      (r) => String(r.driver_number),
      (r) => ({
        session_key: key,
        source,
        driver_number: r.driver_number,
        position: r.position,
        laps: r.number_of_laps,
        dnf: r.dnf,
        dns: r.dns,
        dsq: r.dsq,
        durations_ms: perPhase(r.duration),
        gaps_ms: perPhase(r.gap_to_leader),
      }),
    ),
  };
  const fetched = Object.values(data).reduce((n, list) => n + list.length, 0);
  const kept = Object.values(rows).reduce((n, list) => n + list.length, 0);
  return { rows, skipped: fetched - kept };
}
