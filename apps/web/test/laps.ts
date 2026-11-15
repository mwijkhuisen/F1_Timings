import { readFileSync } from 'node:fs';
import { type Lap, type RaceControl, SessionDetail } from '@f1/contracts';

// Synthetic rows for the lib and view tests: everything null or false unless given.

export const lap = (driver_number: number, lap_number: number, extra: Partial<Lap> = {}): Lap => ({
  driver_number,
  lap_number,
  date_start: null,
  lap_ms: null,
  s1_ms: null,
  s2_ms: null,
  s3_ms: null,
  i1_kph: null,
  i2_kph: null,
  st_kph: null,
  is_pit_out: false,
  is_pit_in: false,
  seg1: null,
  seg2: null,
  seg3: null,
  deleted: false,
  deleted_reason: null,
  quali_phase: null,
  compound: null,
  colour: { lap: null, s1: null, s2: null, s3: null },
  ...extra,
});

export const rc = (
  lap_number: number | null,
  message: string | null,
  extra: Partial<RaceControl[number]> = {},
): RaceControl[number] => ({
  date: null,
  category: 'Other',
  flag: null,
  scope: null,
  sector: null,
  driver_number: null,
  lap_number,
  qualifying_phase: null,
  message,
  ...extra,
});

type Result = SessionDetail['results'][number];
export const result = (driver_number: number, position: number | null = null, grid: number | null = null): Result => ({
  driver_number,
  position,
  laps: null,
  grid,
  dnf: null,
  dns: null,
  dsq: null,
  durations_ms: null,
  gaps_ms: null,
});

type RawResult = {
  driver_number: number;
  position: number | null;
  number_of_laps: number | null;
  dnf: boolean | null;
  dns: boolean | null;
  dsq: boolean | null;
  duration: number | (number | null)[] | null;
  gap_to_leader: number | string | (number | null)[] | null;
};
const ms = (s: number | null) => (s === null ? null : Math.round(s * 1000));
const perPhase = (v: RawResult['duration'] | RawResult['gap_to_leader']) =>
  v === null ? null : typeof v === 'string' ? [null] : Array.isArray(v) ? v.map(ms) : [ms(v)];

/** A server fixture `session_result-<name>` as ingest stores it (`perPhase` in ingest/normalise.ts: seconds as ms, a string gap such as "+1 LAP" as [null], Q1–Q3 per phase). */
export const resultFixture = (name: string): Result[] =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../server/src/openf1/fixtures/session_result-${name}.golden.json`, import.meta.url),
        'utf8',
      ),
    ) as RawResult[]
  ).map((r) => ({
    driver_number: r.driver_number,
    position: r.position,
    laps: r.number_of_laps,
    grid: null,
    dnf: r.dnf,
    dns: r.dns,
    dsq: r.dsq,
    durations_ms: perPhase(r.duration),
    gaps_ms: perPhase(r.gap_to_leader),
  }));

/** Qualifying: car d's best in phase p is (81 − p) s + 10·d ms, so car 1 is fastest everywhere. */
export const time = (d: number, p: number) => (81 - p) * 1000 + 10 * d;

/** `sizes[p − 1]` cars run phase p: an out-lap, a timed lap and an in-lap each. */
export function field(sizes: number[]): Lap[] {
  const laps: Lap[] = [];
  const next = new Map<number, number>();
  const add = (d: number, extra: Partial<Lap>) => {
    const n = (next.get(d) ?? 0) + 1;
    next.set(d, n);
    laps.push(lap(d, n, extra));
  };
  sizes.forEach((size, i) => {
    const p = i + 1;
    for (let d = 1; d <= size; d++) {
      add(d, { quali_phase: p, is_pit_out: true });
      add(d, { quali_phase: p, lap_ms: time(d, p) });
      add(d, { quali_phase: p, lap_ms: time(d, p) + 9000, is_pit_in: true });
    }
  });
  return laps;
}

const iso = '2026-10-31T21:00:00.000Z';

/** A `SessionDetail.session`'s fetch fields (#99): an OpenF1 session fetched once without a failure. */
export const fetched = {
  source: 'openf1',
  fetch_count: 1,
  fail_count: 0,
  last_error: null,
  next_fetch_at: null,
} as const;

/** A session of `type` and `name` with `drivers` as [number, acronym] and those results. */
export const sessionDetail = (
  type: string,
  name: string,
  drivers: [number, string][] = [],
  results: Result[] = [],
): SessionDetail =>
  SessionDetail.parse({
    session: {
      session_key: 11000,
      type,
      name,
      date_start: iso,
      date_end: iso,
      ingest_state: 'final',
      is_cancelled: false,
      meeting_key: 1300,
      ...fetched,
    },
    meeting: {
      meeting_key: 1300,
      name: 'Mexico City Grand Prix',
      official_name: null,
      location: null,
      country_code: null,
      circuit_short_name: null,
      gmt_offset: null,
      date_start: null,
      date_end: null,
      is_cancelled: false,
      year: 2026,
    },
    drivers: drivers.map(([driver_number, acronym]) => ({
      driver_number,
      acronym,
      full_name: null,
      team_name: null,
      team_colour: null,
    })),
    results,
  });
