import type { Lap } from '@f1/contracts';

// The session's bests in the browser, by the server's own rules (A§9): the
// same valid laps and the same tie order as the purple and green colours, so
// a tile and the boxed cell always name the same lap.

export type Field = 'lap_ms' | 's1_ms' | 's2_ms' | 's3_ms';

/** A§9: not deleted, not an in-lap, not an out-lap (a null `is_pit_out` counts as false). */
export const isValid = (l: Lap): boolean => !l.deleted && !l.is_pit_in && !l.is_pit_out;

// Dates are compared parsed: the API mixes `+00:00` and `.095000+00:00`.
const startOf = (l: Lap) => (l.date_start === null ? Number.POSITIVE_INFINITY : Date.parse(l.date_start));

/** A§9 after the value: earlier `date_start` (nulls last), lower lap number, lower driver number. */
const tie = (a: Lap, b: Lap): number =>
  startOf(a) - startOf(b) || a.lap_number - b.lap_number || a.driver_number - b.driver_number; // ∞ − ∞ is NaN: falls through

/** A§9 order on one field: faster first, nulls last. */
export const compare =
  (field: Field) =>
  (a: Lap, b: Lap): number =>
    (a[field] ?? Number.POSITIVE_INFINITY) - (b[field] ?? Number.POSITIVE_INFINITY) || tie(a, b);

const first = (laps: Iterable<Lap>, keep: (l: Lap) => boolean, cmp: (a: Lap, b: Lap) => number): Lap | null => {
  let best: Lap | null = null;
  for (const l of laps) if (keep(l) && (best === null || cmp(l, best) < 0)) best = l;
  return best;
};

const timed = (field: Field) => (l: Lap) => isValid(l) && l[field] !== null;

/** The session's best valid value of a field (the purple one), or null. */
export const bestOf = (laps: readonly Lap[], field: Field): Lap | null => first(laps, timed(field), compare(field));

/** Each driver's own best valid lap for a field (the green one, or the purple). */
export function ownBests(laps: readonly Lap[], field: Field): Map<number, Lap> {
  const cmp = compare(field);
  const out = new Map<number, Lap>();
  for (const l of laps) {
    if (!timed(field)(l)) continue;
    const held = out.get(l.driver_number);
    if (held === undefined || cmp(l, held) < 0) out.set(l.driver_number, l);
  }
  return out;
}

/** `sum`: best S1 + best S2 + best S3 (the sum of best sectors, never an "ideal lap"); `top`: the speed trap. */
export type SessionBests = {
  lap: Lap | null;
  s1: Lap | null;
  s2: Lap | null;
  s3: Lap | null;
  sum: number | null;
  top: Lap | null;
};

export function sessionBests(laps: readonly Lap[]): SessionBests {
  const s1 = bestOf(laps, 's1_ms');
  const s2 = bestOf(laps, 's2_ms');
  const s3 = bestOf(laps, 's3_ms');
  const [a, b, c] = [s1?.s1_ms ?? null, s2?.s2_ms ?? null, s3?.s3_ms ?? null];
  const sum = a === null || b === null || c === null ? null : a + b + c;
  const top = first(
    laps,
    (l) => isValid(l) && l.st_kph !== null,
    (a, b) => (b.st_kph ?? 0) - (a.st_kph ?? 0) || tie(a, b),
  );
  return { lap: bestOf(laps, 'lap_ms'), s1, s2, s3, sum, top };
}

/** Owner D3: the Δ to the driver's own best as a step, 0 below 0.5 %, 1 below 1 %, 2 below 2 %, else 3. */
export function deltaStep(diffMs: number, bestMs: number): 0 | 1 | 2 | 3 {
  if (diffMs <= 0) return 0;
  const r = diffMs / bestMs;
  return r < 0.005 ? 0 : r < 0.01 ? 1 : r < 0.02 ? 2 : 3;
}
