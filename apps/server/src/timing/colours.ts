import type { Lap } from '@f1/contracts';

// Final-semantics colours (A§9), computed per request in the api over a whole session. Pure.

export type ColourLap = Pick<
  Lap,
  'driver_number' | 'lap_number' | 'lap_ms' | 's1_ms' | 's2_ms' | 's3_ms' | 'is_pit_out' | 'is_pit_in' | 'deleted'
> & { date_start: Date | null };

const FIELDS = [
  ['lap', 'lap_ms'],
  ['s1', 's1_ms'],
  ['s2', 's2_ms'],
  ['s3', 's3_ms'],
] as const;

const time = (l: ColourLap) => l.date_start?.getTime() ?? Number.POSITIVE_INFINITY;
const eligible = (l: ColourLap) => !(l.deleted || l.is_pit_out || l.is_pit_in);

/**
 * Per lap and field, in input order: null without a value. A value is eligible unless its lap
 * is deleted, an out-lap or an in-lap; a non-eligible value is yellow. Each driver's own best
 * (the minimum eligible value; ties by date_start, nulls last, then lap_number) is green, and the
 * best of those is purple: first to set it holds it. Everything else is yellow.
 */
export function colours(laps: readonly ColourLap[]): Lap['colour'][] {
  const rows = laps.map((lap) => ({ lap, colour: { lap: null, s1: null, s2: null, s3: null } as Lap['colour'] }));
  type Row = (typeof rows)[number];
  for (const [key, field] of FIELDS) {
    // Infinity − Infinity is NaN, which `||` passes on: two null dates tie.
    const before = (a: ColourLap, b: ColourLap) =>
      ((a[field] ?? 0) - (b[field] ?? 0) ||
        time(a) - time(b) ||
        a.lap_number - b.lap_number ||
        a.driver_number - b.driver_number) < 0;
    const best = new Map<number, Row>(); // driver → own-best lap
    for (const row of rows) {
      const { lap } = row;
      if (lap[field] === null) continue;
      row.colour[key] = 'yellow';
      if (!eligible(lap)) continue;
      const own = best.get(lap.driver_number);
      if (!own || before(lap, own.lap)) best.set(lap.driver_number, row);
    }
    let purple: Row | undefined;
    for (const row of best.values()) {
      row.colour[key] = 'green';
      if (!purple || before(row.lap, purple.lap)) purple = row;
    }
    if (purple) purple.colour[key] = 'purple';
  }
  return rows.map((row) => row.colour);
}

/** A lap plus the epoch ms at which each of its values was set (null: unknown). */
export type ProgressiveLap = ColourLap & { at: Record<'lap' | 's1' | 's2' | 's3', number | null> };

/**
 * Tower colours as of the moment the caller shows (the flags are the caller's), per lap and field,
 * in input order. Per field the values go in `at` order, ties by driver_number then lap_number; a
 * value whose `at` is null goes after all dated ones (same ties). No value: null. Not eligible:
 * yellow. Strictly below every earlier eligible value in the session: purple (first to set a time
 * holds it); strictly below the driver's own earlier eligible values: green; else yellow.
 */
export function progressiveColours(laps: readonly ProgressiveLap[]): Lap['colour'][] {
  const out = laps.map(() => ({ lap: null, s1: null, s2: null, s3: null }) as Lap['colour']);
  for (const [key, field] of FIELDS) {
    const order = laps
      .flatMap((l, i) => (l[field] === null ? [] : [i]))
      .toSorted((i, j) => {
        const [a, b] = [laps[i] as ProgressiveLap, laps[j] as ProgressiveLap];
        // Infinity − Infinity is NaN, which `||` passes on: two null `at` tie.
        return (
          (a.at[key] ?? Number.POSITIVE_INFINITY) - (b.at[key] ?? Number.POSITIVE_INFINITY) ||
          a.driver_number - b.driver_number ||
          a.lap_number - b.lap_number
        );
      });
    let best = Number.POSITIVE_INFINITY;
    const own = new Map<number, number>(); // driver → own minimum so far
    for (const i of order) {
      const lap = laps[i] as ProgressiveLap;
      const colour = out[i] as Lap['colour'];
      const v = lap[field] as number;
      const mine = own.get(lap.driver_number) ?? Number.POSITIVE_INFINITY;
      if (!eligible(lap)) colour[key] = 'yellow';
      else {
        colour[key] = v < best ? 'purple' : v < mine ? 'green' : 'yellow';
        best = Math.min(best, v);
        own.set(lap.driver_number, Math.min(mine, v));
      }
    }
  }
  return out;
}
