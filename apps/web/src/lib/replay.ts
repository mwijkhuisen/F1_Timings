import { type Lap, type Obj, view } from '@f1/contracts';
import { driverOf } from '../views/Tower.tsx';
import { isValid } from './bests.ts';
import { kindOf } from './pitwall.ts';
import { phaseName } from './quali.ts';
import type { Driver } from './session.ts';
import { type Feed, utc } from './stream.ts';
import type { ClockPeriod, Kind, Period } from './track.ts';
import { leaderLap } from './weather.ts';

// The player's view of the state at T (A§13, P4e): the seek-bar marks, the "Back to" chips, the last stop and the
// events a forward seek skipped; since #112 the bands as laps and the race-control texts for the session tabs. Pure:
// `statusSeries` runs once per store flush and once more per `laps` event while Laps, Compare or Stints is shown,
// `skipped` once per seek and `feedRaceControl` once per `laps` event on Compare; everything else works on their
// results, so the 1 s tick parses nothing.

/** One `SessionData.StatusSeries` entry. */
export type Status = { t: number; track?: string | undefined; session?: string | undefined };
export type MarkKind = 'start' | Kind | 'chequered';
/** A point (start, chequered flag) or a band (SC, VSC, red flag) from `t` to `end`; `open` while it still runs at T. */
export type Mark = { kind: MarkKind; t: number; end?: number; open?: true };

/** The status series, sorted by time; an entry without a usable Utc is dropped. */
export function statusSeries(state: Obj): Status[] {
  return Object.values(view(state, 'SessionData')?.StatusSeries ?? {})
    .flatMap((s) => (s ? [{ t: utc(s.Utc), track: s.TrackStatus, session: s.SessionStatus }] : []))
    .filter((s) => !Number.isNaN(s.t))
    .sort((a, b) => a.t - b.t);
}

/**
 * The band in force (A§11.3): a red flag while TrackStatus is Red or the session is Aborted (until Started or
 * Finished: the race's red flag runs to its restart, its TrackStatus clears earlier), else SC, else VSC (VSCEnding is
 * still the VSC).
 */
const bandOf = (track: string | undefined, aborted: boolean): Kind | undefined =>
  track === 'Red' || aborted
    ? 'red'
    : track === 'SCDeployed'
      ? 'sc'
      : track === 'VSCDeployed' || track === 'VSCEnding'
        ? 'vsc'
        : undefined;

/**
 * The marks at or before T, by time. A start is a `Started` unless the next entry with a SessionStatus follows within
 * 60 s (the race's 2 s blip, A§11.1); a band is a run of one kind (`bandOf`, from the latest TrackStatus and whether
 * the session is aborted), from the entry where it comes into force to the entry where it stops (SC → Aborted closes
 * SC and opens red); every `Finished` is a chequered flag. A mark that starts outside [lo, hi] is dropped and a band's
 * end is clipped to hi.
 */
export function markersUpTo(series: readonly Status[], T: number, [lo, hi]: readonly [number, number]): Mark[] {
  const seen = series.filter((s) => s.t <= T);
  const out: Mark[] = [];
  let track: string | undefined;
  let aborted = false;
  let band: { kind: Kind; t: number } | undefined;
  seen.forEach((s, i) => {
    if (s.track !== undefined) track = s.track;
    if (s.session === 'Aborted') aborted = true;
    else if (s.session === 'Started' || s.session === 'Finished') aborted = false;
    const kind = bandOf(track, aborted);
    if (band && kind !== band.kind) {
      out.push({ kind: band.kind, t: band.t, end: s.t });
      band = undefined;
    }
    if (kind && !band) band = { kind, t: s.t };
    if (s.session === 'Finished') out.push({ kind: 'chequered', t: s.t });
    if (s.session !== 'Started') return;
    const next = seen.slice(i + 1).find((n) => n.session !== undefined);
    if (!(next && next.t - s.t <= 60_000)) out.push({ kind: 'start', t: s.t });
  });
  if (band) out.push({ kind: band.kind, t: band.t, end: T, open: true });
  return out
    .filter((m) => m.t >= lo && m.t <= hi)
    .map((m) => (m.end !== undefined && m.end > hi ? { ...m, end: hi } : m))
    .sort((a, b) => a.t - b.t);
}

/**
 * The SC, VSC and red bands at or before T (`markersUpTo` from `lo`) as the leader's laps (#112): a band runs from the
 * leader's lap at its start (lap 1 before the first lap) to the leader's lap at its end, an open band's end being T; a
 * closed red flag ends a lap before its restart's, which is green (as `trackPeriods`). A band that ended before lap 1
 * started is dropped, and one that starts at or before the end of the previous band of its kind extends that band.
 * `leaderLap` is null outside `Race`-type sessions, so there are none.
 */
export function lapPeriods(
  series: readonly Status[],
  laps: readonly Pick<Lap, 'lap_number' | 'date_start'>[],
  T: number,
  lo: number,
  type: string | null,
): Period[] {
  const out: Period[] = [];
  for (const m of markersUpTo(series, T, [lo, Number.POSITIVE_INFINITY])) {
    if (m.kind === 'start' || m.kind === 'chequered') continue;
    const end = leaderLap(laps, m.end ?? T, type);
    if (end === null) continue;
    const from = leaderLap(laps, m.t, type) ?? 1;
    const to = m.kind === 'red' && !m.open ? Math.max(from, end - 1) : end;
    const prev = out.findLast((p) => p.kind === m.kind);
    if (prev && from <= prev.to) prev.to = Math.max(prev.to, to);
    else out.push({ kind: m.kind, from, to });
  }
  return out;
}

/**
 * The SC, VSC and red bands at or before T on the clock (#114, practice): `markersUpTo` from `lo`, each from its start
 * to its end, an open one ending at T. The track evolution and the run plan read these, as the session page reads
 * `clockPeriods`.
 */
export function feedClock(series: readonly Status[], T: number, lo: number): ClockPeriod[] {
  return markersUpTo(series, T, [lo, Number.POSITIVE_INFINITY]).flatMap((m) =>
    // `markersUpTo` always sets `end` on a band (an open one ends at T).
    m.kind === 'start' || m.kind === 'chequered' ? [] : [{ kind: m.kind, from: m.t, to: m.end as number }],
  );
}

/** The feed's race-control messages that have a text (#112, the player's pit cycles); `date` is null without a Utc. */
export function feedRaceControl(state: Obj): { date: string | null; message: string }[] {
  return Object.values(view(state, 'RaceControlMessages')?.Messages ?? {}).flatMap((m) => {
    if (m?.Message === undefined) return [];
    const t = utc(m.Utc);
    return [{ date: Number.isNaN(t) ? null : new Date(t).toISOString(), message: m.Message }];
  });
}

/** The driver's latest stop at or before T: its out-lap's start, and the in-lap (a pit-out on lap 1 is no stop). */
export function lastStop(laps: Iterable<Lap>, driver: number, T: number): { t: number; lap: number } | null {
  let last: { t: number; lap: number } | null = null;
  for (const l of laps) {
    if (l.driver_number !== driver || !l.is_pit_out || l.lap_number <= 1 || l.date_start === null) continue;
    const t = Date.parse(l.date_start);
    if (t <= T && (last === null || t > last.t)) last = { t, lap: l.lap_number - 1 };
  }
  return last;
}

export type Skipped = { sc: number; vsc: number; red: number; stops: number; deleted: number; incidents: number };

/** The first race-control message of an incident (A§11.3); its investigation and verdict repeat it. */
const NOTED = /INCIDENT INVOLVING\b.*\bNOTED\b/;
/** A ruling that deletes a lap (A§9's forms, loosely), with its car number. */
const RULING = /^(?:CORRECTION - )?CAR (\d{1,2}) .*\bDELETED\b/;

/**
 * One event of the catch-up list (#234). `t` is when it happened as the feed knew it, the T a replay seeks to: a
 * band's start, a message's Utc, a stop's pit exit (the out-lap's start, as `lastStop`), a fastest lap's end, a
 * deletion's ruling (D5). `lap` is the leader's for a flag, the message's for an incident, the in-lap for a stop.
 */
export type CatchUpEvent =
  | { kind: 'flag'; t: number; flag: Kind; lap: number | null }
  | { kind: 'incident'; t: number; text: string; lap: number | null; noted: boolean }
  | { kind: 'stop'; t: number; driver: Driver; lap: number; compound: string | null }
  | { kind: 'deleted'; t: number; driver: Driver; lap: number }
  | { kind: 'fastest'; t: number; driver: Driver; lap: number; ms: number; part: string | null };

const ALL = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const;

/**
 * What a forward seek jumped over, in (old.t, next.t], oldest first (#234), from `next` only (its laps are what was
 * known at its T): SC, VSC and red bands that started there; the incident messages (`kindOf`, plus every NOTED one);
 * stops; laps deleted since, each at the first unused ruling of its driver in the window (in lap order), else at its
 * end clamped into the window (D5); and each valid lap that was strictly the best at its end, per qualifying part (D4).
 * Null unless next is later.
 */
export function skippedEvents(old: Feed, next: Feed): CatchUpEvent[] | null {
  if (!(next.t > old.t)) return null;
  const inside = (t: number) => t > old.t && t <= next.t;
  const laps = [...next.laps.values()];
  const info = view(next.state, 'SessionInfo');
  const list = view(next.state, 'DriverList') ?? {};
  const driver = (n: number) => driverOf(list, String(n));
  const out: CatchUpEvent[] = [];
  for (const m of markersUpTo(statusSeries(next.state), next.t, ALL))
    if (m.kind !== 'start' && m.kind !== 'chequered' && inside(m.t))
      out.push({ kind: 'flag', t: m.t, flag: m.kind, lap: leaderLap(laps, m.t, info?.Type ?? null) });
  const rulings: { t: number; car: number }[] = [];
  for (const m of Object.values(view(next.state, 'RaceControlMessages')?.Messages ?? {})) {
    const t = utc(m?.Utc);
    if (m?.Message === undefined || !inside(t)) continue;
    const noted = NOTED.test(m.Message);
    if (noted || kindOf(m.Category, m.Message).kind === 'incidents')
      out.push({ kind: 'incident', t, text: m.Message, lap: m.Lap ?? null, noted });
    const car = RULING.exec(m.Message)?.[1];
    if (car !== undefined) rulings.push({ t, car: Number(car) });
  }
  rulings.sort((a, b) => a.t - b.t);
  const struck = [...next.laps]
    .filter(([key, l]) => l.deleted && old.laps.get(key)?.deleted !== true)
    .map(([, l]) => l)
    .sort((a, b) => a.lap_number - b.lap_number);
  for (const l of struck) {
    const i = rulings.findIndex((r) => r.car === l.driver_number);
    const end = l.date_start === null ? next.t : Date.parse(l.date_start) + (l.lap_ms ?? 0);
    const t = i < 0 ? Math.min(next.t, Math.max(old.t + 1, end)) : (rulings.splice(i, 1)[0]?.t ?? next.t);
    out.push({ kind: 'deleted', t, driver: driver(l.driver_number), lap: l.lap_number });
  }
  for (const l of laps) {
    if (!(l.is_pit_out && l.lap_number > 1 && l.date_start !== null)) continue;
    const t = Date.parse(l.date_start);
    if (inside(t))
      out.push({ kind: 'stop', t, driver: driver(l.driver_number), lap: l.lap_number - 1, compound: l.compound });
  }
  const timed = laps
    .flatMap((l) =>
      isValid(l) && l.lap_ms !== null && l.date_start !== null
        ? [{ l, ms: l.lap_ms, end: Date.parse(l.date_start) + l.lap_ms }]
        : [],
    )
    .sort((a, b) => a.end - b.end);
  const best = new Map<number, number>(); // per qualifying part, 0 outside qualifying
  for (const { l, ms, end } of timed) {
    const part = l.quali_phase ?? 0;
    if (end > next.t || ms >= (best.get(part) ?? Number.POSITIVE_INFINITY)) continue;
    best.set(part, ms);
    if (end > old.t)
      out.push({
        kind: 'fastest',
        t: end,
        driver: driver(l.driver_number),
        lap: l.lap_number,
        ms,
        part: l.quali_phase === null ? null : phaseName(info?.Name ?? null, l.quali_phase),
      });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The counts `skippedText` reads: SC, VSC and red bands, stops, deletions and incidents noted. */
export function tally(events: readonly CatchUpEvent[]): Skipped {
  const n: Skipped = { sc: 0, vsc: 0, red: 0, stops: 0, deleted: 0, incidents: 0 };
  for (const e of events)
    if (e.kind === 'flag') n[e.flag]++;
    else if (e.kind === 'stop') n.stops++;
    else if (e.kind === 'deleted') n.deleted++;
    else if (e.kind === 'incident' && e.noted) n.incidents++;
  return n;
}

/** What a forward seek jumped over, counted (`tally` of `skippedEvents`); null unless next is later. */
export function skipped(old: Feed, next: Feed): Skipped | null {
  const events = skippedEvents(old, next);
  return events && tally(events);
}

/** The catch-up's head (#234): the leader's laps at both T (from lap 1; null outside a race) and whole minutes, ≥ 1. */
export function skippedWindow(old: Feed, next: Feed): { laps: [number, number] | null; minutes: number } {
  const laps = [...next.laps.values()];
  const type = view(next.state, 'SessionInfo')?.Type ?? null;
  const to = leaderLap(laps, next.t, type);
  return {
    laps: to === null ? null : [leaderLap(laps, old.t, type) ?? 1, to],
    minutes: Math.max(1, Math.round((next.t - old.t) / 60_000)),
  };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1 SC · 1 VSC · 21 pit stops · 1 lap deleted · 1 incident noted": the non-zero counts; '' when there are none. */
export function skippedText(s: Skipped): string {
  return [
    s.sc > 0 && `${s.sc} SC`,
    s.vsc > 0 && `${s.vsc} VSC`,
    s.red > 0 && count(s.red, 'red flag'),
    s.stops > 0 && count(s.stops, 'pit stop'),
    s.deleted > 0 && `${count(s.deleted, 'lap')} deleted`,
    s.incidents > 0 && `${count(s.incidents, 'incident')} noted`,
  ]
    .filter((p) => typeof p === 'string')
    .join(' · ');
}
