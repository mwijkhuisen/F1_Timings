import type { Insertable } from 'kysely';
import { gmtOffset } from '../archive/rows.ts';
import type { DB } from '../db/db.ts';
import type { Result } from '../openf1/schemas.ts';
import type { Dump, Entry, Round, Session } from './dump.ts';
import { LAST_YEAR, meetingKey, type SessionType, sessionKey } from './keys.ts';

// Jolpica's 1950–2017 rounds → A§7 rows with source 'jolpica' (P3c). Pure: one round's meeting row, its Race and its
// Qualifying (every qualifying part collapsed into one session), each with its driver, result, pit and lap rows.

const source = 'jolpica';
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The qualifying types and their part order: Q1–Q3 by name, the single-session types by number and time. */
const QUALI: ReadonlyMap<string, number> = new Map([
  ['QA', 0],
  ['QB', 0],
  ['QO', 0],
  ['Q1', 1],
  ['Q2', 2],
  ['Q3', 3],
]);

type Rows<T extends keyof DB> = Insertable<DB[T]>[];
export type Skipped = { dnq: number; no_number: number; lap_dup: number; bad_pit: number; pit_dup: number };
export type SessionRows = {
  key: number;
  type: SessionType;
  session: Insertable<DB['session']>;
  driver: Rows<'driver'>;
  result: Rows<'result'>;
  pit: Rows<'pit'>;
  lap: Rows<'lap'>;
  /** entries that got E3's `1000 + k` */
  renumbered: number;
  skipped: Skipped;
};
export type RoundRows = {
  year: number;
  round: number;
  meeting: Insertable<DB['meeting']>;
  sessions: SessionRows[];
  /** race or qualifying sessions without a readable timestamp */
  no_date: number;
};

// The generated type says number[] for int[], which cannot show a null element.
const array = (values: (number | null)[]) => values as number[];
const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => Math.floor(ms / DAY) * DAY;
const small = (v: number | null, min = 0) => (v !== null && v >= min && v <= 32_767 ? v : null);
const get = <T>(map: ReadonlyMap<number, T>, key: number | null | undefined) =>
  key === null || key === undefined ? undefined : map.get(key);

const formats = new Map<string, Intl.DateTimeFormat | null>();
/** The zone's UTC offset at an instant, in OpenF1's `[-]HH:MM:SS` form and in ms; undefined for an unknown zone. */
export function zoneOffset(zone: string, at: number): { text: string; ms: number } | undefined {
  let format = formats.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    } catch {
      format = null; // RangeError: no such zone
    }
    formats.set(zone, format);
  }
  const name = format?.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
  return name === undefined ? undefined : gmtOffset(name === 'GMT' ? '00:00' : name.replace(/^GMT/, ''));
}

/** A wall-clock time in a zone (ms as if UTC) → the UTC instant; `near` is an instant close to it. */
function fromLocal(zone: string, wall: number, near: number): number | undefined {
  const guess = zoneOffset(zone, near);
  const offset = guess && zoneOffset(zone, wall - guess.ms);
  return offset && wall - offset.ms;
}

/** E3: a session's car numbers in entry order; a missing or taken number becomes 1000 + k. */
function numbering() {
  const taken = new Set<number>();
  const state = { renumbered: 0 };
  const next = (car: number | null) => {
    if (car !== null && car >= 0 && car < 1000 && !taken.has(car)) {
      taken.add(car);
      return car;
    }
    state.renumbered++;
    return 1000 + state.renumbered;
  };
  return { next, state };
}

function driverRow(dump: Dump, key: number, number: number, roundEntry: number | null): Rows<'driver'>[number] {
  const teamDriver = get(dump.teamDrivers, get(dump.roundEntries, roundEntry)?.teamDriver);
  const d = get(dump.drivers, teamDriver?.driver);
  const team = get(dump.teams, teamDriver?.team);
  const colour = team?.colour ? /^#([0-9A-Fa-f]{6})$/.exec(team.colour) : null;
  return {
    session_key: key,
    source,
    driver_number: number,
    acronym: d?.abbreviation ?? null,
    full_name: `${d?.forename ?? ''} ${d?.surname ?? ''}`.trim() || null,
    team_name: team?.name ?? null,
    team_colour: colour?.[1] ?? null,
  };
}

function sessionRow(
  key: number,
  meeting: number,
  type: SessionType,
  start: number,
  end: number,
  cancelled: boolean,
): Insertable<DB['session']> {
  return {
    session_key: key,
    source,
    meeting_key: meeting,
    type,
    name: type,
    date_start: iso(start),
    date_end: iso(end),
    is_cancelled: cancelled,
    ingest_state: 'final',
    next_fetch_at: null,
    fetch_count: 1,
    fail_count: 0,
    last_error: null,
  };
}

const skippedNone = (): Skipped => ({ dnq: 0, no_number: 0, lap_dup: 0, bad_pit: 0, pit_dup: 0 });

/** The race's local date (its start in its zone) plus a pit stop's local time of day, as UTC. */
function pitDate(race: Session, local: number | null): string | null {
  if (!race.timed || race.start === null || race.zone === null || local === null) return null;
  const offset = zoneOffset(race.zone, race.start);
  const at = offset && fromLocal(race.zone, day(race.start + offset.ms) + local * 1000, race.start);
  return at === undefined ? null : iso(at);
}

function raceRows(dump: Dump, race: Session & { start: number }, key: number, meeting: number): SessionRows {
  const skipped = skippedNone();
  const numbers = numbering();
  const entries = (dump.entries.get(race.id) ?? []).filter((e) => {
    const dnq = e.status === 40 || e.status === 41; // did not (pre-)qualify: no race result
    if (dnq) skipped.dnq++;
    return !dnq;
  });
  const numbered = entries.map((e) => ({ e, n: numbers.next(get(dump.roundEntries, e.roundEntry)?.car ?? null) }));
  const winner = entries.find((e) => e.position === 1)?.ms ?? null;

  const pit: Rows<'pit'> = [];
  const stops = new Set<string>();
  for (const { e, n } of numbered)
    for (const p of dump.pits.get(e.id) ?? []) {
      const lap = small(p.lap, 1);
      if (lap === null) skipped.bad_pit++;
      else if (stops.has(`${n}:${lap}`)) skipped.pit_dup++;
      else {
        stops.add(`${n}:${lap}`);
        pit.push({
          session_key: key,
          source,
          driver_number: n,
          lap_number: lap,
          date: pitDate(race, p.local),
          pit_ms: p.ms,
          lane_ms: p.ms,
          stop_ms: null,
        });
      }
    }

  const lap: Rows<'lap'> = [];
  for (const { e, n } of numbered) {
    const seen = new Set<number>();
    for (const l of dump.laps.get(e.id) ?? []) {
      const number = small(l.number, 1);
      if (number === null)
        skipped.no_number++; // a fastest-lap marker row
      else if (seen.has(number)) skipped.lap_dup++;
      else {
        seen.add(number);
        lap.push({
          session_key: key,
          source,
          driver_number: n,
          lap_number: number,
          date_start: null,
          lap_ms: l.ms,
          // The lap after a stop's lap is the out-lap; without pit data in the session nothing is known.
          is_pit_out: pit.length === 0 ? null : stops.has(`${n}:${number - 1}`),
        });
      }
    }
  }

  const flag = (e: Entry, ...codes: number[]) => (e.status === null ? null : codes.includes(e.status));
  return {
    key,
    type: 'Race',
    session: sessionRow(
      key,
      meeting,
      'Race',
      race.timed ? race.start : day(race.start),
      race.timed ? race.start + 2 * HOUR : day(race.start),
      race.cancelled,
    ),
    driver: numbered.map(({ e, n }) => driverRow(dump, key, n, e.roundEntry)),
    result: numbered.map(({ e, n }) => ({
      session_key: key,
      source,
      driver_number: n,
      position: e.classified === false ? null : small(e.position),
      laps: small(e.laps),
      grid: small(e.grid),
      dnf: flag(e, 10, 11),
      dsq: flag(e, 20),
      dns: flag(e, 30),
      durations_ms: array([e.ms]),
      gaps_ms: array([e.ms !== null && winner !== null ? e.ms - winner : null]),
    })),
    pit,
    lap,
    renumbered: numbers.state.renumbered,
    skipped,
  };
}

/**
 * Every qualifying part of the round as one session. A part's time is the entry's best lap-row time in it (a row
 * without a lap number counts); the position is the one in the last part the entry has one in (the S2 check against
 * the race grid). Undefined when no entry has a time or a position.
 */
function qualifyingRows(
  dump: Dump,
  parts: readonly (Session & { start: number })[],
  key: number,
  meeting: number,
): SessionRows | undefined {
  const byEntry = new Map<number, { first: number; roundEntry: number | null; parts: (Entry | undefined)[] }>();
  for (const [i, part] of parts.entries())
    for (const e of dump.entries.get(part.id) ?? []) {
      const id = e.roundEntry ?? -e.id;
      const row = byEntry.get(id) ?? { first: e.id, roundEntry: e.roundEntry, parts: [] };
      byEntry.set(id, row);
      row.first = Math.min(row.first, e.id);
      row.parts[i] ??= e; // a second entry of one car in one part: the first stays
    }
  const best = (e: Entry | undefined) =>
    (dump.laps.get(e?.id ?? Number.NaN) ?? []).reduce<number | null>(
      (min, l) => (l.ms === null ? min : Math.min(min ?? l.ms, l.ms)),
      null,
    );
  const rows = [...byEntry.values()]
    .sort((a, b) => a.first - b.first)
    .map((r) => ({
      ...r,
      times: parts.map((_, i) => best(r.parts[i])),
      position: small(r.parts.findLast((e) => e?.position != null)?.position ?? null),
    }));
  if (!rows.some((r) => r.position !== null || r.times.some((t) => t !== null))) return undefined;
  const fastest = parts.map((_, i) =>
    rows.reduce<number | null>((min, r) => {
      const t = r.times[i] ?? null;
      return t === null ? min : Math.min(min ?? t, t);
    }, null),
  );

  const numbers = numbering();
  const numbered = rows.map((r) => ({ r, n: numbers.next(get(dump.roundEntries, r.roundEntry)?.car ?? null) }));
  const [first] = parts;
  const last = parts.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const timed = parts.every((p) => p.timed);
  return {
    key,
    type: 'Qualifying',
    session: sessionRow(
      key,
      meeting,
      'Qualifying',
      timed ? first.start : day(first.start),
      timed ? last.start + HOUR : day(first.start),
      parts.every((p) => p.cancelled),
    ),
    driver: numbered.map(({ r, n }) => driverRow(dump, key, n, r.roundEntry)),
    result: numbered.map(({ r, n }) => ({
      session_key: key,
      source,
      driver_number: n,
      position: r.position,
      laps: null,
      grid: null,
      dnf: null,
      dns: null,
      dsq: null,
      durations_ms: array(r.times),
      gaps_ms: array(
        r.times.map((t, i) => {
          const min = fastest[i] ?? null;
          return t === null || min === null ? null : t - min;
        }),
      ),
    })),
    pit: [],
    lap: [],
    renumbered: numbers.state.renumbered,
    skipped: skippedNone(),
  };
}

const dated = (s: Session): s is Session & { start: number } => s.start !== null;
const partOrder = (a: Session, b: Session) =>
  (QUALI.get(a.type ?? '') ?? 0) - (QUALI.get(b.type ?? '') ?? 0) ||
  (a.number ?? 0) - (b.number ?? 0) ||
  (a.start ?? 0) - (b.start ?? 0) ||
  a.id - b.id;

/**
 * One round → its meeting and its Race and Qualifying rows. Practice and sprint sessions are not imported. Undefined
 * from 2018 on (P3c S4 attaches those laps to the existing sessions instead); `bad_key` outside 1950–2017 or rounds 1–99.
 */
export function roundRows(dump: Dump, round: Round): Result<RoundRows | undefined, 'bad_key'> {
  if (round.year !== null && round.year > LAST_YEAR) return { ok: true, value: undefined };
  const meeting = round.year === null || round.number === null ? undefined : meetingKey(round.year, round.number);
  if (meeting === undefined || round.year === null || round.number === null) return { ok: false, error: 'bad_key' };

  let no_date = 0;
  const sessions: SessionRows[] = [];
  const race = round.sessions.filter((s) => s.type === 'R').sort((a, b) => a.id - b.id)[0];
  if (race && !dated(race)) no_date++;
  else if (race) sessions.push(raceRows(dump, race, sessionKey(meeting, 'Race'), meeting));
  const parts = round.sessions
    .filter((s) => QUALI.has(s.type ?? '') && (dump.entries.get(s.id)?.length ?? 0) > 0)
    .sort(partOrder);
  if (parts.some((p) => !dated(p))) no_date++;
  else {
    const q = qualifyingRows(dump, parts.filter(dated), sessionKey(meeting, 'Qualifying'), meeting);
    if (q) sessions.unshift(q);
  }

  // The offset of the race (else the qualifying) at its start; none without a known start time.
  const timed = [race, ...parts].find((s) => s?.timed && s.start !== null && s.zone !== null);
  const offset = timed?.zone && timed.start !== null ? zoneOffset(timed.zone, timed.start) : undefined;
  const starts = sessions.map((s) => Date.parse(String(s.session.date_start)));
  const ends = sessions.map((s) => Date.parse(String(s.session.date_end)));
  const circuit = get(dump.circuits, round.circuit);
  return {
    ok: true,
    value: {
      year: round.year,
      round: round.number,
      no_date,
      sessions,
      meeting: {
        meeting_key: meeting,
        source,
        year: round.year,
        name: round.name,
        official_name: null,
        location: circuit?.locality ?? null,
        country_code: circuit?.country ?? null,
        circuit_short_name: circuit?.name ?? null,
        gmt_offset: offset?.text ?? null,
        date_start: sessions.length === 0 ? null : iso(Math.min(...starts)),
        date_end: sessions.length === 0 ? null : iso(Math.max(...ends)),
        is_cancelled: round.cancelled,
      },
    },
  };
}
