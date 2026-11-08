import { type Lap, type Obj, view } from '@f1/contracts';
import { type Feed, utc } from './stream.ts';
import type { Kind } from './track.ts';

// The player's view of the state at T (A§13, P4e): the seek-bar marks, the "Back to" chips, the last stop and the
// events a forward seek skipped. Pure: `statusSeries` runs once per store flush (the one `view()` here besides
// `skipped`'s, once per seek), everything else works on its result, so the 1 s tick parses nothing.

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

/** The TrackStatus words of each band (A§11.3): VSCEnding is still the VSC. */
const BAND = new Map<string, Kind>([
  ['SCDeployed', 'sc'],
  ['VSCDeployed', 'vsc'],
  ['VSCEnding', 'vsc'],
  ['Red', 'red'],
]);

/**
 * The marks at or before T, by time. A start is a `Started` unless the next entry with a SessionStatus follows within
 * 60 s (the race's 2 s blip, A§11.1); a band runs from its first entry to the next TrackStatus outside it (SC → Red
 * closes SC and opens Red); every `Finished` is a chequered flag. A mark that starts outside [lo, hi] is dropped and a
 * band's end is clipped to hi.
 */
export function markersUpTo(series: readonly Status[], T: number, [lo, hi]: readonly [number, number]): Mark[] {
  const seen = series.filter((s) => s.t <= T);
  const out: Mark[] = [];
  let band: { kind: Kind; t: number } | undefined;
  seen.forEach((s, i) => {
    if (s.track !== undefined) {
      const kind = BAND.get(s.track);
      if (band && kind !== band.kind) {
        out.push({ kind: band.kind, t: band.t, end: s.t });
        band = undefined;
      }
      if (kind && !band) band = { kind, t: s.t };
    }
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

/**
 * What a forward seek jumped over, in (old.t, next.t]: SC, VSC and red periods that started there, stops, laps
 * deleted since (`next.laps` holds what was known at its T), and incidents noted. Null unless next is later.
 */
export function skipped(old: Feed, next: Feed): Skipped | null {
  if (!(next.t > old.t)) return null;
  const inside = (t: number) => t > old.t && t <= next.t;
  const n: Skipped = { sc: 0, vsc: 0, red: 0, stops: 0, deleted: 0, incidents: 0 };
  const all = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const;
  for (const m of markersUpTo(statusSeries(next.state), next.t, all))
    if (m.kind !== 'start' && m.kind !== 'chequered' && inside(m.t)) n[m.kind]++;
  for (const [key, l] of next.laps) {
    if (l.is_pit_out && l.lap_number > 1 && l.date_start !== null && inside(Date.parse(l.date_start))) n.stops++;
    if (l.deleted && old.laps.get(key)?.deleted !== true) n.deleted++;
  }
  for (const m of Object.values(view(next.state, 'RaceControlMessages')?.Messages ?? {}))
    if (m?.Message !== undefined && NOTED.test(m.Message) && inside(utc(m.Utc))) n.incidents++;
  return n;
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
