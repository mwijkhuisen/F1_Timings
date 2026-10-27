// The A§9 timing rules on one session's lap rows. Pure. They run in the normaliser on the
// rows before the insert, inside the ingest transaction (A§8). A race-control message is
// never logged: the caller gets counts only.

export type RuleLap = {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_ms: number | null;
  deleted: boolean;
  deleted_reason: string | null;
  quali_phase: number | null;
};
export type RuleMessage = { date: string | null; qualifying_phase: number | null; message: string | null };

export type Ruling = {
  kind: 'deleted' | 'reinstated';
  car: number;
  time_ms: number | null;
  /** The `LAP n` of the text, not yet mapped to the driver's lap (see `resolve`). */
  lap: number | null;
  reason: string | null;
};
/** Messages, not laps: `unmatched` parsed but named no lap of the session, `unparsed` fits no known form. */
export type RuleCounts = { deleted: number; reinstated: number; unmatched: number; unparsed: number };

// After the whitespace collapse. The car comes from the text: driver_number is null in the data.
// The trailing `LAP n hh:mm:ss ( (PIT))` is optional: "… (NEXT LAP)" forms carry none.
const DELETED =
  /^CAR (\d{1,2}) \([A-Z]{3}\) (?:TIME (\d+):(\d{2}\.\d{3})|LAP) DELETED - (.+?)(?: LAP (\d{1,3}) \d{2}:\d{2}:\d{2}(?: \(PIT\))?)?$/;
const REINSTATED = /^CAR (\d{1,2}) \([A-Z]{3}\) (?:TIME (\d+):(\d{2}\.\d{3})|LAP (\d{1,3})) WILL BE REINSTATED$/;

const ms = (min: string | undefined, sec: string | undefined) =>
  min === undefined || sec === undefined ? null : Number(min) * 60_000 + Math.round(Number(sec) * 1000);
const int = (s: string | undefined) => (s === undefined ? null : Number(s));

/** A ruling; `unparsed` for a DELETED/REINSTATED message in no known form; undefined for any other message. */
export function parseRuling(message: string): Ruling | 'unparsed' | undefined {
  if (!/\b(?:DELETED|REINSTATED)\b/.test(message)) return undefined;
  const text = message.replace(/\s+/g, ' ').trim();
  const d = DELETED.exec(text);
  if (d) return { kind: 'deleted', car: Number(d[1]), time_ms: ms(d[2], d[3]), lap: int(d[5]), reason: d[4] ?? null };
  const r = REINSTATED.exec(text);
  if (r) return { kind: 'reinstated', car: Number(r[1]), time_ms: ms(r[2], r[3]), lap: int(r[4]), reason: null };
  return 'unparsed';
}

/**
 * The car's lap a ruling names, or undefined (A§9, owner 2026-10-26/27). A TIME matches the
 * laps within 1 ms: one → it; several → the one exact match, else the expected lap if it is one
 * of them; none → on to `LAP n`. The expected lap is n in a race or sprint (`type` 'Race') and
 * n − 1 elsewhere.
 */
export function resolve<L extends RuleLap>(laps: readonly L[], ruling: Ruling, type: string | null): L | undefined {
  const own = laps.filter((l) => l.driver_number === ruling.car);
  const n = ruling.lap === null ? undefined : type === 'Race' ? ruling.lap : ruling.lap - 1;
  const expected = own.find((l) => l.lap_number === n);
  const t = ruling.time_ms;
  if (t !== null) {
    const timed = own.filter((l) => l.lap_ms !== null && Math.abs(l.lap_ms - t) <= 1);
    if (timed.length === 1) return timed[0];
    if (timed.length > 1) {
      const exact = timed.filter((l) => l.lap_ms === t);
      if (exact.length === 1) return exact[0];
      return expected && timed.includes(expected) ? expected : undefined;
    }
  }
  return expected;
}

const at = (m: RuleMessage) => (m.date === null ? Number.POSITIVE_INFINITY : Date.parse(m.date));
// Stable: input order breaks ties. Dates are compared parsed, as they mix `+00:00` and `.095000+00:00`.
const byDate = (rows: readonly RuleMessage[]) => rows.toSorted((a, b) => at(a) - at(b));

/**
 * Sets `deleted`, `deleted_reason` and `quali_phase` on the laps in place. In date order, a
 * DELETED message deletes its lap (a second one keeps the first reason) and a REINSTATED one
 * clears it, only among the laps deleted at that moment. A lap's qualifying phase is that of
 * the last race-control row with a phase dated at or before its `date_start`; in a qualifying
 * session whose first phase row is Q2 (OpenF1 left Q1's rows without one), Q1 before that row.
 */
export function markLaps(laps: RuleLap[], raceControl: readonly RuleMessage[], type: string | null): RuleCounts {
  const counts: RuleCounts = { deleted: 0, reinstated: 0, unmatched: 0, unparsed: 0 };
  const sorted = byDate(raceControl);
  for (const { message } of sorted) {
    const ruling = message === null ? undefined : parseRuling(message);
    if (ruling === undefined) continue;
    if (ruling === 'unparsed') {
      counts.unparsed++;
      continue;
    }
    const reinstate = ruling.kind === 'reinstated';
    const lap = resolve(reinstate ? laps.filter((l) => l.deleted) : laps, ruling, type);
    if (!lap) counts.unmatched++;
    else if (reinstate) {
      lap.deleted = false;
      lap.deleted_reason = null;
      counts.reinstated++;
    } else {
      if (!lap.deleted) lap.deleted_reason = ruling.reason;
      lap.deleted = true;
      counts.deleted++;
    }
  }
  // Null without such a row or without a date_start (NaN compares false). Only qualifying
  // sessions have phase rows; the Q1 inference (owner 2026-10-27) checks the type as well.
  const phases = sorted.filter((m) => m.qualifying_phase !== null && m.date !== null);
  const first = phases[0];
  const q1Before = type === 'Qualifying' && first?.qualifying_phase === 2 ? at(first) : Number.NEGATIVE_INFINITY;
  for (const lap of laps) {
    const start = lap.date_start === null ? Number.NaN : Date.parse(lap.date_start);
    lap.quali_phase = phases.findLast((m) => at(m) <= start)?.qualifying_phase ?? (start < q1Before ? 1 : null);
  }
  return counts;
}
