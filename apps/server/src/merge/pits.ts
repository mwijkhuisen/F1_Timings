// #219 (owner D1, A§7): one session's pit candidates from every source → one `pit` row per (car, lap). Pure. Each row
// keeps every source's values in `sources`, so a writer replaces only its own and another source's fills come back on
// every rewrite. Only counts leave it besides the rows: they go into a log line, never a value.

/** Highest first: the F1 feed wins over OpenF1 (owner, 2026-11-16), the archive before live as for laps. */
export const PIT_ORDER = ['f1-archive', 'f1-live', 'openf1', 'jolpica'] as const;
export type PitSource = (typeof PIT_ORDER)[number];
/** The columns merged per value; `filled` names only these. `date` is epoch ms here and in `sources`. */
const PIT_VALUES = ['date', 'pit_ms', 'lane_ms', 'stop_ms'] as const;
type Column = (typeof PIT_VALUES)[number];
export type PitValues = Record<Column, number | null>;
type Key = { driver_number: number; lap_number: number };
/** A stored row. `sources` {} is a row an image before #219 wrote: the candidate of its own `source`. */
export type StoredPit = Key & PitValues & { source: string; sources: Readonly<Record<string, Partial<PitValues>>> };
export type MergedPit = Key &
  PitValues & {
    source: PitSource;
    sources: Record<string, PitValues>;
    /** {column: source} for each value from another source than the row's own. */
    filled: Record<string, string>;
  };
type PerColumn = Record<string, Partial<Record<Column, number>>>;
export type PitCounts = {
  rows: number;
  /** Rows only a lower source than the session's highest has, per source. */
  added: Record<string, number>;
  filled: PerColumn;
  /** Values a lower source also has that differ from the row's: by more than 0 ms, a date by more than 1 s. */
  diffs: PerColumn;
};

const rank = (source: string) => {
  const i = PIT_ORDER.indexOf(source as PitSource);
  if (i < 0) throw new Error('a pit source outside PIT_ORDER'); // the CHECK on pit.source and PIT_ORDER disagree
  return i;
};
const values = (v: Partial<PitValues>): PitValues => ({
  date: v.date ?? null,
  pit_ms: v.pit_ms ?? null,
  lane_ms: v.lane_ms ?? null,
  stop_ms: v.stop_ms ?? null,
});
const tally = (o: PerColumn, source: string, column: Column) => {
  o[source] = { ...o[source], [column]: (o[source]?.[column] ?? 0) + 1 };
};
const same = (column: Column, a: number, b: number) => Math.abs(a - b) <= (column === 'date' ? 1000 : 0);

/**
 * `source`'s new candidates replace its old ones in every stored row; a row left with no source is dropped. Per row and
 * column the first non-null value in PIT_ORDER wins, and the highest source with the row is its `source`. The same
 * input gives the same rows, sorted by car, then lap. A source key outside PIT_ORDER throws.
 */
export function mergePits(
  stored: readonly StoredPit[],
  source: PitSource,
  rows: readonly (Key & Partial<PitValues>)[],
): { rows: MergedPit[]; counts: PitCounts } {
  const all = new Map<string, Key & { sources: Record<string, PitValues> }>();
  const keyOf = (r: Key) => `${r.driver_number}:${r.lap_number}`;
  for (const r of stored) {
    const own = Object.keys(r.sources).length === 0 ? { [r.source]: r } : r.sources;
    const sources: Record<string, PitValues> = {};
    for (const [s, v] of Object.entries(own)) if (s !== source) sources[s] = values(v);
    all.set(keyOf(r), { driver_number: r.driver_number, lap_number: r.lap_number, sources });
  }
  for (const r of rows) {
    const row = all.get(keyOf(r)) ?? { driver_number: r.driver_number, lap_number: r.lap_number, sources: {} };
    row.sources[source] = values(r);
    all.set(keyOf(r), row);
  }
  const ordered = [...all.values()]
    .map((r) => ({ ...r, order: Object.keys(r.sources).sort((a, b) => rank(a) - rank(b)) as PitSource[] }))
    .filter((r) => r.order.length > 0)
    .sort((a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number);
  const top = Math.min(...ordered.map((r) => rank(r.order[0] as PitSource)));
  const counts: PitCounts = { rows: ordered.length, added: {}, filled: {}, diffs: {} };
  const merged = ordered.map(({ order, ...r }): MergedPit => {
    const base = order[0] as PitSource;
    const row: MergedPit = { ...r, source: base, filled: {}, ...values({}) };
    if (rank(base) !== top) counts.added[base] = (counts.added[base] ?? 0) + 1;
    for (const col of PIT_VALUES) {
      const from = order.find((s) => r.sources[s]?.[col] != null);
      const value = from === undefined ? null : (r.sources[from]?.[col] ?? null);
      if (from === undefined || value === null) continue;
      row[col] = value;
      if (from !== base) {
        row.filled[col] = from;
        tally(counts.filled, from, col);
      }
      for (const s of order) {
        const other = r.sources[s]?.[col] ?? null;
        if (s !== from && other !== null && !same(col, other, value)) tally(counts.diffs, s, col);
      }
    }
    return row;
  });
  return { rows: merged, counts };
}
