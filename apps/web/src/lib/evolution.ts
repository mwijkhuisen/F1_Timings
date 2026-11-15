import type { Lap } from '@f1/contracts';
import { phaseName } from './quali.ts';
import type { ClockPeriod } from './track.ts';

// Track evolution (#114, A§13): each timed lap at its start, and the running best of the session. Nothing is
// interpolated and no trend is fitted: the steps are the real improvements.

/** A timed lap (neither in- nor out-lap) at its `date_start` in epoch ms. */
export type EvoPoint = { t: number; ms: number; driver: number; lap: number; deleted: boolean; phase: number | null };
export type Step = { t: number; ms: number };
/** A qualifying phase (its first start to its last end) or, in practice, a red-flag period (`red`). */
export type Band = { label: string; from: number; to: number; red: boolean };
export type Evolution = { points: EvoPoint[]; steps: Step[]; bands: Band[]; noStart: number };

const byTime = (a: EvoPoint, b: EvoPoint) => a.t - b.t || a.lap - b.lap || a.driver - b.driver;

/** The points whose time beat every earlier non-deleted point's, in time order. */
const improvements = (points: readonly EvoPoint[]): EvoPoint[] => {
  const out: EvoPoint[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const p of points) {
    if (p.deleted || p.ms >= best) continue;
    best = p.ms;
    out.push(p);
  }
  return out;
};

/**
 * `steps`: the running best of the non-deleted points, one per strict improvement plus a closing one at the last
 * point's time (drawn with `step: 'end'`). `noStart`: timed laps without a `date_start`, left out. `bands`: per
 * `quali_phase` in qualifying, the red clock periods in practice.
 */
export function evolution(
  laps: readonly Lap[],
  type: string | null,
  sessionName: string | null,
  clock: readonly ClockPeriod[],
): Evolution {
  const points: EvoPoint[] = [];
  let noStart = 0;
  for (const l of laps) {
    if (l.lap_ms === null || l.is_pit_in || l.is_pit_out) continue;
    if (l.date_start === null) noStart++;
    else
      points.push({
        t: Date.parse(l.date_start),
        ms: l.lap_ms,
        driver: l.driver_number,
        lap: l.lap_number,
        deleted: l.deleted,
        phase: l.quali_phase,
      });
  }
  points.sort(byTime);
  const steps = improvements(points).map((p): Step => ({ t: p.t, ms: p.ms }));
  const last = points.at(-1);
  const closing = steps.at(-1);
  if (last && closing && last.t > closing.t) steps.push({ t: last.t, ms: closing.ms });

  const bands: Band[] = [];
  if (type === 'Qualifying') {
    const span = new Map<number, [number, number]>();
    for (const l of laps) {
      if (l.quali_phase === null || l.date_start === null) continue;
      const [from, to] = [Date.parse(l.date_start), Date.parse(l.date_start) + (l.lap_ms ?? 0)];
      const held = span.get(l.quali_phase);
      span.set(l.quali_phase, held ? [Math.min(held[0], from), Math.max(held[1], to)] : [from, to]);
    }
    for (const [p, [from, to]] of [...span].sort((a, b) => a[0] - b[0]))
      bands.push({ label: phaseName(sessionName, p), from, to, red: false });
  } else if (type === 'Practice') {
    for (const p of clock) if (p.kind === 'red') bands.push({ label: 'RED', from: p.from, to: p.to, red: true });
  }
  return { points, steps, bands, noStart };
}

export const SLOT_MS = 300_000;

/** `slot` is the 5-minute slot's start in epoch ms; `best`: the lap beat the session's running best. */
export type Slot = { phase: number | null; slot: number; point: EvoPoint; best: boolean };

/**
 * The fastest non-deleted lap per phase (null in practice) and 5-minute slot, `floor(t / 300 000)`, in time order;
 * a slot with only deleted laps is not listed.
 */
export function evolutionSlots(points: readonly EvoPoint[]): Slot[] {
  const sorted = [...points].sort(byTime);
  const improved = new Set(improvements(sorted));
  const held = new Map<string, Slot>();
  for (const point of sorted) {
    if (point.deleted) continue;
    const slot = Math.floor(point.t / SLOT_MS) * SLOT_MS;
    const key = `${point.phase}|${slot}`;
    const cur = held.get(key);
    if (cur === undefined || point.ms < cur.point.ms) held.set(key, { phase: point.phase, slot, point, best: false });
  }
  return [...held.values()]
    .map((s) => ({ ...s, best: improved.has(s.point) }))
    .sort((a, b) => a.slot - b.slot || (a.phase ?? 0) - (b.phase ?? 0));
}
