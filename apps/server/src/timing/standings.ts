import type { Standings } from '@f1/contracts';

// The championship standings (A§9 "Standings"; P8, owner, 2026-11-15, #123, D5), computed per request in the api from
// one season's rows. Pure. Of the sessions after S it reads only the next counted session's points_start.

export type StandingsSession = {
  session_key: number;
  source: string;
  type: string | null;
  name: string | null;
  date_start: Date;
  meeting_name: string | null;
  is_cancelled: boolean;
};
export type StandingsDriver = {
  session_key: number;
  driver_number: number;
  full_name: string | null;
  acronym: string | null;
  team_name: string | null;
  team_colour: string | null;
};
export type StandingsResult = {
  session_key: number;
  driver_number: number;
  position: number | null;
  points: number | null;
};
export type ChampionshipDriverRow = { session_key: number; driver_number: number; points_start: number | null };
export type ChampionshipTeamRow = { session_key: number; team_name: string; points_start: number | null };
/** One season's rows: its sessions (any kind; only the counted ones are used) and the rows of any of its sessions. */
export type StandingsSeason = {
  year: number;
  sessions: readonly StandingsSession[];
  drivers: readonly StandingsDriver[];
  results: readonly StandingsResult[];
  championship_drivers: readonly ChampionshipDriverRow[];
  championship_teams: readonly ChampionshipTeamRow[];
};
export type StandingsMismatch = {
  session_key: number;
  year: number;
  meeting_name: string | null;
  session_name: string | null;
  rows: number;
};

const FIRST_YEAR = 2023; // P8 covers 2023 on; 1950–2022 is #189 (D3)
const EMPTY: Standings = { drivers: [], teams: [], rounds: [], provisional: false };

/** The season's non-cancelled openf1 races and sprints, by date_start then session_key (A§9). */
function counted(season: StandingsSeason): StandingsSession[] {
  if (season.year < FIRST_YEAR) return [];
  return season.sessions
    .filter((s) => s.source === 'openf1' && s.type === 'Race' && !s.is_cancelled)
    .sort((a, b) => a.date_start.getTime() - b.date_start.getTime() || a.session_key - b.session_key);
}

// One session's facts about one kind of competitor: drivers keyed by full_name, teams by team_name.
type Own = {
  appear: Set<string>; // listed from this session on
  points: Map<string, number>; // session_result.points, null as 0
  places: Map<string, number[]>; // race finishing positions: places[p] = how many
};
type Kind = {
  own: (s: StandingsSession) => Own;
  /** The session's points_start, undefined without rows (or without a session). */
  start: (s: StandingsSession | undefined) => Map<string, number> | undefined;
};

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const count = (m: Map<string, number[]>, k: string, place: number, n: number) => {
  const p = m.get(k) ?? [];
  p[place] = (p[place] ?? 0) + n;
  m.set(k, p);
};

function kinds(season: StandingsSeason): { drivers: Kind; teams: Kind } {
  // A number maps to a person through the season's driver rows, never the session's alone (A§6.1).
  const person = new Map<number, string>();
  const team = new Map<string, string>(); // `${session_key}:${number}` → that session's team_name
  for (const d of season.drivers) {
    if (d.full_name !== null) person.set(d.driver_number, d.full_name);
    if (d.team_name !== null) team.set(`${d.session_key}:${d.driver_number}`, d.team_name);
  }
  type Car = { session_key: number; driver_number: number };
  const driverKey = (r: Car) => person.get(r.driver_number);
  const teamKey = (r: Car) => team.get(`${r.session_key}:${r.driver_number}`);

  const start = <R extends { session_key: number; points_start: number | null }>(
    rows: readonly R[],
    key: (r: R) => string | undefined,
    s: StandingsSession | undefined,
  ) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = r.session_key === s?.session_key && r.points_start !== null ? key(r) : undefined;
      if (k !== undefined && r.points_start !== null) add(m, k, r.points_start); // one person's two numbers: summed
    }
    return m.size ? m : undefined;
  };
  const kind = (key: (r: Car) => string | undefined, starts: Kind['start']): Kind => ({
    start: starts,
    own: (s) => {
      const o: Own = { appear: new Set(starts(s)?.keys()), points: new Map(), places: new Map() };
      for (const d of season.drivers) {
        const k = d.session_key === s.session_key ? key(d) : undefined;
        if (k !== undefined) o.appear.add(k);
      }
      for (const r of season.results) {
        const k = r.session_key === s.session_key ? key(r) : undefined;
        if (k === undefined) continue;
        o.appear.add(k);
        add(o.points, k, r.points ?? 0);
        if (s.name === 'Race' && r.position !== null) count(o.places, k, r.position, 1);
      }
      return o;
    },
  });
  return {
    drivers: kind(driverKey, (s) => start(season.championship_drivers, driverKey, s)),
    teams: kind(teamKey, (s) => start(season.championship_teams, (r) => r.team_name, s)),
  };
}

type Ranked = { key: string; points: number; position: number };
type Round = { session: StandingsSession; rows: Ranked[]; fallback: boolean };

/**
 * The standing after each of `sessions` (counted, in order; `next` is the counted session after the last one): the next
 * session's points_start where it has rows, the previous standing plus the session's points for anyone absent from them,
 * and that sum for everyone without such rows (`fallback`). Only those who appeared up to a session are in its rows.
 */
function chain(kind: Kind, sessions: readonly StandingsSession[], next: StandingsSession | undefined): Round[] {
  const rounds: Round[] = [];
  const seen = new Set<string>();
  const places = new Map<string, number[]>();
  let before = new Map<string, number>();
  sessions.forEach((session, i) => {
    const o = kind.own(session);
    for (const k of o.appear) seen.add(k);
    for (const [k, p] of o.places)
      p.forEach((n, place) => {
        count(places, k, place, n);
      });
    const start = kind.start(sessions[i + 1] ?? next);
    const after = new Map<string, number>();
    for (const k of seen) after.set(k, start?.get(k) ?? (before.get(k) ?? 0) + (o.points.get(k) ?? 0));
    rounds.push({ session, rows: rank(after, places), fallback: !start });
    before = after;
  });
  return rounds;
}

// Points, then the countback over race results only: most firsts, then seconds, and so on (A§9). A full tie shares
// the position and is listed by name.
function rank(points: Map<string, number>, places: Map<string, number[]>): Ranked[] {
  const rows = [...points].map(([key, pts]) => ({ key, points: pts, places: places.get(key) ?? [], position: 0 }));
  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    if (a.points !== b.points) return b.points - a.points;
    for (let p = 1; p < Math.max(a.places.length, b.places.length); p++) {
      const d = (b.places[p] ?? 0) - (a.places[p] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  rows.sort((a, b) => cmp(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let prev: (typeof rows)[number] | undefined;
  rows.forEach((row, i) => {
    row.position = prev && cmp(prev, row) === 0 ? prev.position : i + 1;
    prev = row;
  });
  return rows.map(({ key, points: pts, position }) => ({ key, points: pts, position }));
}

/** The place change and this session's points of the last round against the one before it. */
function table(rounds: readonly Round[]) {
  const now = rounds.at(-1)?.rows ?? [];
  const prev = new Map(rounds.at(-2)?.rows.map((r) => [r.key, r]));
  return now.map((r) => {
    const before = prev.get(r.key);
    return {
      key: r.key,
      position: r.position,
      change: before ? before.position - r.position : null,
      points: r.points,
      session_points: r.points - (before?.points ?? 0),
    };
  });
}

/** The standings after session `sessionKey` (A§9, A§10); empty unless it is a counted session of 2023 on. */
export function standings(season: StandingsSeason, sessionKey: number): Standings {
  const all = counted(season);
  const i = all.findIndex((s) => s.session_key === sessionKey);
  if (i < 0) return EMPTY;
  const upTo = all.slice(0, i + 1);
  const { drivers, teams } = kinds(season);
  const d = chain(drivers, upTo, all[i + 1]);
  const t = chain(teams, upTo, all[i + 1]);

  // Display fields from the counted sessions up to S only, the latest first, so S's team leads team_names.
  const info = new Map<string, { acronym: string | null; team_colour: string | null; team_names: string[] }>();
  const colour = new Map<string, string>();
  for (const s of upTo.toReversed()) {
    for (const r of season.drivers) {
      if (r.session_key !== s.session_key || r.full_name === null) continue;
      const p = info.get(r.full_name) ?? { acronym: null, team_colour: null, team_names: [] };
      info.set(r.full_name, p);
      p.acronym ??= r.acronym;
      p.team_colour ??= r.team_colour;
      if (r.team_name === null) continue;
      if (!p.team_names.includes(r.team_name)) p.team_names.push(r.team_name);
      if (r.team_colour !== null && !colour.has(r.team_name)) colour.set(r.team_name, r.team_colour);
    }
  }
  // A person listed only through result or championship rows: the acronym is stable per season (A§6.1).
  const acronym = new Map<string, string>();
  for (const r of season.drivers) if (r.full_name !== null && r.acronym !== null) acronym.set(r.full_name, r.acronym);

  return {
    drivers: table(d).map(({ key, ...row }) => ({
      ...row,
      full_name: key,
      acronym: info.get(key)?.acronym ?? acronym.get(key) ?? null,
      team_names: info.get(key)?.team_names ?? [],
      team_colour: info.get(key)?.team_colour ?? null,
    })),
    teams: table(t).map(({ key, ...row }) => ({ ...row, team_name: key, team_colour: colour.get(key) ?? null })),
    rounds: d.map((r, k) => ({
      session_key: r.session.session_key,
      meeting_name: r.session.meeting_name,
      session_name: r.session.name,
      date_start: r.session.date_start.toISOString(),
      drivers: r.rows.map((x) => ({ full_name: x.key, points: x.points })),
      teams: (t[k]?.rows ?? []).map((x) => ({ team_name: x.key, points: x.points })),
    })),
    provisional: Boolean(d.at(-1)?.fallback || t.at(-1)?.fallback),
  };
}

/**
 * The /status cross-check (A§10): per counted session S with driver championship rows for both S and the next counted
 * session N, how many people's N points_start − S points_start differs from S's session_result points, newest first.
 * Only people in both S's and N's rows count: the absent-person rule carries the others (A§9).
 */
export function standingsMismatches(season: StandingsSeason): StandingsMismatch[] {
  const all = counted(season);
  const { drivers } = kinds(season);
  const out: StandingsMismatch[] = [];
  all.forEach((s, i) => {
    const start = drivers.start(s);
    const next = drivers.start(all[i + 1]);
    if (!start || !next) return;
    const { points } = drivers.own(s);
    let rows = 0;
    for (const [k, n] of next) {
      const b = start.get(k);
      if (b !== undefined && n - b !== (points.get(k) ?? 0)) rows++;
    }
    if (rows)
      out.push({
        session_key: s.session_key,
        year: season.year,
        meeting_name: s.meeting_name,
        session_name: s.name,
        rows,
      });
  });
  return out.reverse();
}
