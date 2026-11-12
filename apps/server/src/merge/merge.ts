import type { Selectable } from 'kysely';
import type { DB } from '../db/db.ts';
import { markPitIn } from '../ingest/normalise.ts';
import { markLaps, type RuleCounts, type RuleMessage } from '../timing/rules.ts';

// P3b (A§7, owner D2–D4): one session's lap candidates from every source → one `lap` row per (driver, lap). Pure.
// Only counts leave it besides the rows: they go into a log line, never a value.

/** The H6 order, highest first; P3c and P3f append 'fia' and 'jolpica' together with their CHECK migration. */
export const ORDER = ['openf1', 'f1-archive', 'f1-live'] as const;
export type Source = (typeof ORDER)[number];
/** The columns merged per value; `filled` names only these. */
export const VALUES = [
  'date_start',
  'lap_ms',
  's1_ms',
  's2_ms',
  's3_ms',
  'i1_kph',
  'i2_kph',
  'st_kph',
  'is_pit_out',
  'seg1',
  'seg2',
  'seg3',
  'quali_phase',
] as const;
type Column = (typeof VALUES)[number];
const TIMED: readonly Column[] = ['lap_ms', 's1_ms', 's2_ms', 's3_ms'];

/** A lap_source row, `date_start` as an ISO string. */
export type Candidate = Omit<Selectable<DB['lap_source']>, 'date_start'> & { date_start: string | null };
export type Merged = Candidate & {
  is_pit_in: boolean;
  deleted: boolean;
  deleted_reason: string | null;
  /** {column: source} for each value from another source than the row's own. */
  filled: Record<string, string>;
};
type PerColumn = Record<string, Partial<Record<Column, number>>>;
export type MergeCounts = {
  rows: number;
  /** Laps that only a lower source has, per source. */
  added: Record<string, number>;
  filled: PerColumn;
  diffs: PerColumn;
  /** Laps a source filled nothing on: a lap or sector time both have differs by more than 1 ms. */
  conflicts: Record<string, number>;
  rules: RuleCounts;
};

const rank = (c: Candidate) => {
  const i = ORDER.indexOf(c.source as Source);
  if (i < 0) throw new Error('a lap source outside ORDER'); // the CHECK on lap_source.source and ORDER disagree
  return i;
};
const bump = <K extends string>(o: Partial<Record<K, number>>, k: K) => {
  o[k] = (o[k] ?? 0) + 1;
};
const tally = (o: PerColumn, source: string, column: Column) => {
  o[source] = { ...o[source], [column]: (o[source]?.[column] ?? 0) + 1 };
};

/** compare-laps' rules: a time within 1 ms, `date_start` within 1 s, everything else (segments element-wise) exactly. */
function same(column: Column, a: unknown, b: unknown): boolean {
  if (TIMED.includes(column)) return Math.abs(Number(a) - Number(b)) <= 1;
  if (column === 'date_start') return Math.abs(Date.parse(String(a)) - Date.parse(String(b))) <= 1000;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The merge (H6): per (driver, lap), the highest-ranked candidate is the base and gives the row its `source`. Each
 * lower candidate in order fills the row's null values, unless a lap or sector time both have differs by more than
 * 1 ms (a conflict: it fills nothing). Then the A§9 rules run on the merged rows: `markPitIn`, and `markLaps` on the
 * session's race control. Each row keeps a merged `quali_phase`, because the archive's phases come from SessionData
 * boundaries that `race_control` does not store; only where it is null does the race control's phase count. The same
 * candidates in any order give the same rows, sorted by driver, then lap.
 */
export function merge(
  candidates: readonly Candidate[],
  raceControl: readonly RuleMessage[],
  type: string | null,
): { rows: Merged[]; counts: MergeCounts } {
  const sorted = candidates.toSorted(
    (a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number || rank(a) - rank(b),
  );
  const top = sorted.reduce<number>((min, c) => Math.min(min, rank(c)), ORDER.length);
  const added: MergeCounts['added'] = {};
  const filled: PerColumn = {};
  const diffs: PerColumn = {};
  const conflicts: MergeCounts['conflicts'] = {};
  const rows: Merged[] = [];
  for (const c of sorted) {
    const row = rows.at(-1);
    if (row?.driver_number !== c.driver_number || row.lap_number !== c.lap_number) {
      rows.push({ ...c, is_pit_in: false, deleted: false, deleted_reason: null, filled: {} });
      if (rank(c) !== top) bump(added, c.source);
      continue;
    }
    const differs = (col: Column) => row[col] !== null && c[col] !== null && !same(col, row[col], c[col]);
    for (const col of VALUES) if (differs(col)) tally(diffs, c.source, col);
    if (TIMED.some(differs)) {
      bump(conflicts, c.source);
      continue;
    }
    // ponytail: whole-array fill only; element-wise if mini-sector holes matter
    for (const col of VALUES) {
      if (row[col] !== null || c[col] === null) continue;
      Object.assign(row, { [col]: c[col] });
      row.filled[col] = c.source;
      tally(filled, c.source, col);
    }
  }
  markPitIn(rows);
  const phases = rows.map((r) => r.quali_phase);
  const rules = markLaps(rows, raceControl, type);
  for (const [i, r] of rows.entries()) r.quali_phase = phases[i] ?? r.quali_phase;
  return { rows, counts: { rows: rows.length, added, filled, diffs, conflicts, rules } };
}
