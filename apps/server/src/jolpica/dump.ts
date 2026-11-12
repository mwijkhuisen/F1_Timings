import { join } from 'node:path';
import { type CsvRecord, DumpError, readCsv } from './csv.ts';

// The tables of the Jolpica-F1 CSV dump that the importer needs (P3c, A§6.3), one `formula_one_<table>.csv` each,
// read by header name. The small tables go into maps; `sessionentry`, `pitstop` and `lap` keep only the rows of the
// wanted sessions. Durations become integer ms; a value of another shape is null and counted (`bad_time`).

const COLUMNS = {
  season: ['id', 'year'],
  round: ['id', 'season_id', 'circuit_id', 'number', 'name', 'is_cancelled'],
  session: ['id', 'round_id', 'type', 'number', 'timestamp', 'has_time_data', 'timezone', 'is_cancelled'],
  circuit: ['id', 'name', 'locality', 'country_code'],
  driver: ['id', 'forename', 'surname', 'abbreviation'],
  team: ['id', 'name', 'primary_color'],
  teamdriver: ['id', 'team_id', 'driver_id'],
  roundentry: ['id', 'round_id', 'team_driver_id', 'car_number'],
  sessionentry: [
    'id',
    'session_id',
    'round_entry_id',
    'position',
    'grid',
    'status',
    'time',
    'laps_completed',
    'is_classified',
  ],
  pitstop: ['id', 'session_entry_id', 'lap_id', 'duration', 'local_timestamp'],
  lap: ['id', 'session_entry_id', 'number', 'time'],
} as const;
type Table = keyof typeof COLUMNS;

/** The session types whose entries the importer reads: the race and every qualifying type. */
export const ENTRY_TYPES: ReadonlySet<string> = new Set(['R', 'Q1', 'Q2', 'Q3', 'QA', 'QB', 'QO']);

export type Round = {
  id: number;
  year: number | null;
  circuit: number | null;
  number: number | null;
  name: string | null;
  cancelled: boolean;
  sessions: Session[];
};
export type Session = {
  id: number;
  round: number | null;
  type: string | null;
  number: number | null;
  /** epoch ms (UTC), or null when the timestamp has another shape */
  start: number | null;
  timed: boolean;
  zone: string | null;
  cancelled: boolean;
};
export type Entry = {
  id: number;
  session: number;
  roundEntry: number | null;
  position: number | null;
  grid: number | null;
  status: number | null;
  ms: number | null;
  laps: number | null;
  classified: boolean | null;
};
export type Lap = { number: number | null; ms: number | null };
/** `lap` is the lap number through `lap_id`, null when that lap row is absent or has none. */
export type Pit = { id: number; lap: number | null; ms: number | null; local: number | null };
export type Dump = {
  rounds: Map<number, Round>;
  circuits: Map<number, { name: string | null; locality: string | null; country: string | null }>;
  drivers: Map<number, { forename: string | null; surname: string | null; abbreviation: string | null }>;
  teams: Map<number, { name: string | null; colour: string | null }>;
  teamDrivers: Map<number, { team: number | null; driver: number | null }>;
  roundEntries: Map<number, { car: number | null; teamDriver: number | null }>;
  /** session id → its entries in id order (wanted sessions only) */
  entries: Map<number, Entry[]>;
  /** session entry id → its lap rows in dump order */
  laps: Map<number, Lap[]>;
  /** session entry id → its pit stops in dump order */
  pits: Map<number, Pit[]>;
  /** durations of an unknown shape, read as null */
  badTime: number;
};

const int = (v: string | null) => (v !== null && /^-?\d{1,9}$/.test(v) ? Number(v) : null);
const bool = (v: string | null) => (v === 't' ? true : v === 'f' ? false : null);
/** PostgreSQL text cannot hold NUL. */
const text = (v: string | null) => (v === null || v.includes('\0') ? null : v);
const timestamp = (v: string | null) => {
  const m = v === null ? null : /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+00:00$/.exec(v);
  const ms = m ? Date.parse(`${m[1]}T${m[2]}Z`) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};
/** `HH:MM:SS` → seconds of the day. */
const clock = (v: string | null) => {
  const m = v === null ? null : /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(v);
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3]) : null;
};

/** A duration `H+:MM:SS[.f{0,3}]` → integer ms; undefined for any other shape (null stays null). */
export function duration(v: string | null): number | null | undefined {
  if (v === null) return null;
  const m = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d{0,3}))?$/.exec(v);
  if (!m) return undefined;
  const [, h = '', min = '', s = '', f = ''] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, '0'));
}

/** The records of a table with their integer id; a record without one is `bad_record`. */
async function* rows(dir: string, table: Table): AsyncGenerator<[number, CsvRecord]> {
  const file = `formula_one_${table}.csv`;
  for await (const r of readCsv(join(dir, file), COLUMNS[table])) {
    const id = int(r.id ?? null);
    if (id === null) throw new DumpError('bad_record', file);
    yield [id, r];
  }
}

/**
 * Reads the dump in `dir`. `keep` picks the years and session types (R, Q1…) whose race and qualifying entries, pit
 * stops and laps are kept.
 * Throws a DumpError on a missing or unreadable file, a missing column or a record over the caps.
 */
export async function loadDump(dir: string, keep: (year: number, type: string) => boolean): Promise<Dump> {
  let badTime = 0;
  const ms = (v: string | null) => {
    const d = duration(v);
    if (d !== undefined) return d;
    badTime++;
    return null;
  };

  const years = new Map<number, number | null>();
  for await (const [id, r] of rows(dir, 'season')) years.set(id, int(r.year ?? null));
  const rounds: Dump['rounds'] = new Map();
  for await (const [id, r] of rows(dir, 'round')) {
    const season = int(r.season_id ?? null);
    rounds.set(id, {
      id: id,
      year: season === null ? null : (years.get(season) ?? null),
      circuit: int(r.circuit_id ?? null),
      number: int(r.number ?? null),
      name: text(r.name ?? null),
      cancelled: bool(r.is_cancelled ?? null) === true,
      sessions: [],
    });
  }
  const wanted = new Set<number>();
  for await (const [id, r] of rows(dir, 'session')) {
    const session: Session = {
      id: id,
      round: int(r.round_id ?? null),
      type: text(r.type ?? null),
      number: int(r.number ?? null),
      start: timestamp(r.timestamp ?? null),
      timed: bool(r.has_time_data ?? null) === true,
      zone: text(r.timezone ?? null),
      cancelled: bool(r.is_cancelled ?? null) === true,
    };
    const round = session.round === null ? undefined : rounds.get(session.round);
    round?.sessions.push(session);
    const { type } = session;
    if (round?.year != null && type !== null && ENTRY_TYPES.has(type) && keep(round.year, type)) wanted.add(id);
  }

  const circuits: Dump['circuits'] = new Map();
  for await (const [id, r] of rows(dir, 'circuit'))
    circuits.set(id, {
      name: text(r.name ?? null),
      locality: text(r.locality ?? null),
      country: text(r.country_code ?? null),
    });
  const drivers: Dump['drivers'] = new Map();
  for await (const [id, r] of rows(dir, 'driver'))
    drivers.set(id, {
      forename: text(r.forename ?? null),
      surname: text(r.surname ?? null),
      abbreviation: text(r.abbreviation ?? null),
    });
  const teams: Dump['teams'] = new Map();
  for await (const [id, r] of rows(dir, 'team'))
    teams.set(id, { name: text(r.name ?? null), colour: text(r.primary_color ?? null) });
  const teamDrivers: Dump['teamDrivers'] = new Map();
  for await (const [id, r] of rows(dir, 'teamdriver'))
    teamDrivers.set(id, { team: int(r.team_id ?? null), driver: int(r.driver_id ?? null) });
  const roundEntries: Dump['roundEntries'] = new Map();
  for await (const [id, r] of rows(dir, 'roundentry'))
    roundEntries.set(id, { car: int(r.car_number ?? null), teamDriver: int(r.team_driver_id ?? null) });

  const entries: Dump['entries'] = new Map();
  const kept = new Set<number>();
  for await (const [id, r] of rows(dir, 'sessionentry')) {
    const session = int(r.session_id ?? null);
    if (session === null || !wanted.has(session)) continue;
    kept.add(id);
    const list = entries.get(session) ?? [];
    entries.set(session, list);
    list.push({
      id: id,
      session,
      roundEntry: int(r.round_entry_id ?? null),
      position: int(r.position ?? null),
      grid: int(r.grid ?? null),
      status: int(r.status ?? null),
      ms: ms(r.time ?? null),
      laps: int(r.laps_completed ?? null),
      classified: bool(r.is_classified ?? null),
    });
  }
  for (const list of entries.values()) list.sort((a, b) => a.id - b.id);

  // Pit stops before laps: their lap ids are few, and the lap stream records those laps' numbers on the way.
  const pits: Dump['pits'] = new Map();
  const pitLaps = new Map<number, Pit[]>(); // lap id → the stops that name it
  for await (const [id, r] of rows(dir, 'pitstop')) {
    const entry = int(r.session_entry_id ?? null);
    if (entry === null || !kept.has(entry)) continue;
    const pit: Pit = { id: id, lap: null, ms: ms(r.duration ?? null), local: clock(r.local_timestamp ?? null) };
    const list = pits.get(entry) ?? [];
    pits.set(entry, list);
    list.push(pit);
    const lapId = int(r.lap_id ?? null);
    if (lapId !== null) pitLaps.set(lapId, [...(pitLaps.get(lapId) ?? []), pit]);
  }
  const laps: Dump['laps'] = new Map();
  for await (const [id, r] of rows(dir, 'lap')) {
    const entry = int(r.session_entry_id ?? null);
    if (entry === null || !kept.has(entry)) continue;
    const number = int(r.number ?? null);
    for (const pit of pitLaps.get(id) ?? []) pit.lap = number;
    const list = laps.get(entry) ?? [];
    laps.set(entry, list);
    list.push({ number, ms: ms(r.time ?? null) });
  }

  return { rounds, circuits, drivers, teams, teamDrivers, roundEntries, entries, laps, pits, badTime };
}
