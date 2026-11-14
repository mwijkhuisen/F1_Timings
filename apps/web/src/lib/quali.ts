import { type Lap, type Obj, type SessionDetail, view } from '@f1/contracts';
import { bestOf, compare } from './bests.ts';

// Qualifying by phase: each driver's best valid lap per phase (A§9's
// `quali_phase`), each phase's cut-off and the margins to it. The field size
// and how many go through come from the laps, never from 15, 16 or 10.

/** `ran`: any lap in the phase; `deleted`: the phase's deleted laps, for the DEL tag. */
export type PhaseCell = { best: Lap | null; deleted: Lap[]; ran: boolean };
/** `cells[i]` is phase i + 1; `reached`: the highest phase run (0: none); `timed`: laps with a time, neither in nor out. */
export type QualiRow = { driver: number; cells: PhaseCell[]; reached: number; timed: number };
/** `cutoff`: the slowest best among the drivers who went through; `through`: how many did. */
export type Phase = { fastest: Lap | null; cutoff: Lap | null; through: number };
/** `phases.length` is the highest `quali_phase` (0: no phase data). Pole is `phases.at(-1)?.fastest` once `hasPole`. */
export type Quali = { phases: Phase[]; rows: QualiRow[] };

const byLap = compare('lap_ms');
/** A§9 order with no time last. */
const byBest = (a: Lap | null, b: Lap | null) => (a && b ? byLap(a, b) : a ? -1 : b ? 1 : 0);

function rowOf(driver: number, own: readonly Lap[], phases: number, fed: number): QualiRow {
  const cells = Array.from({ length: phases }, (_, i) => {
    const inPhase = own.filter((l) => l.quali_phase === i + 1);
    return { best: bestOf(inPhase, 'lap_ms'), deleted: inPhase.filter((l) => l.deleted), ran: inPhase.length > 0 };
  });
  return {
    driver,
    cells,
    reached: Math.max(fed, ...own.map((l) => l.quali_phase ?? 0)),
    // Deleted laps count; a lap without a phase counts here only.
    timed: own.filter((l) => l.lap_ms !== null && !l.is_pit_in && !l.is_pit_out).length,
  };
}

/**
 * The player's D1 (#113): `feed` maps a driver to the part the feed says they reached (`feedReached`), which raises
 * that driver's phase and the phase count beyond what the lap rows show.
 */
export function qualiPhases(
  laps: readonly Lap[],
  results: SessionDetail['results'],
  feed: ReadonlyMap<number, number> = new Map(),
): Quali {
  const count = Math.max(0, ...laps.map((l) => l.quali_phase ?? 0), ...feed.values());
  const byDriver = new Map<number, Lap[]>([...results.map((r) => r.driver_number), ...feed.keys()].map((d) => [d, []]));
  for (const l of laps) {
    const own = byDriver.get(l.driver_number);
    if (own) own.push(l);
    else byDriver.set(l.driver_number, [l]);
  }
  const rows = [...byDriver].map(([driver, own]) => rowOf(driver, own, count, feed.get(driver) ?? 0));

  // ponytail: #113 D1, a driver went through phase p if they have any lap row
  // in phase p + 1, timed or not. One who goes through but never leaves the
  // garage shows as knocked out; the upgrade is the official classification.
  // The player also passes the feed's knock-outs (`feed`): a line not KnockedOut has reached the current part.
  const phases = Array.from({ length: count }, (_, i): Phase => {
    const through = rows.filter((r) => r.reached > i + 1);
    const bests = through.flatMap((r) => r.cells[i]?.best ?? []);
    return {
      fastest: bestOf(
        laps.filter((l) => l.quali_phase === i + 1),
        'lap_ms',
      ),
      cutoff: bests.sort(byLap).at(-1) ?? null,
      through: through.length,
    };
  });

  const position = new Map(results.map((r) => [r.driver_number, r.position ?? Number.POSITIVE_INFINITY]));
  const pos = (r: QualiRow) => position.get(r.driver) ?? Number.POSITIVE_INFINITY;
  const bestIn = (r: QualiRow) => r.cells[r.reached - 1]?.best ?? null;
  // Two missing positions give ∞ − ∞, NaN, which falls through to the number.
  rows.sort((a, b) => b.reached - a.reached || byBest(bestIn(a), bestIn(b)) || pos(a) - pos(b) || a.driver - b.driver);
  return { phases, rows };
}

/** The best minus the cut-off: < 0 inside, 0 on it, > 0 out; null without either. */
export const margin = (cell: PhaseCell, phase: Phase): number | null => {
  const best = cell.best?.lap_ms ?? null;
  const cut = phase.cutoff?.lap_ms ?? null;
  return best === null || cut === null ? null : best - cut;
};

// ponytail: the three-phase format (Q1–Q3) is assumed, so only a third phase's
// fastest is pole; before Q3 has laps the last phase's fastest is "Fastest in Q2".
// A format with another phase count needs it from the session.
export const hasPole = (q: Quali): boolean => q.phases.length >= 3;

/** Sprint Qualifying (Sprint Shootout in 2023) names its phases SQ1–SQ3. */
export const phaseName = (sessionName: string | null, p: number): string =>
  `${sessionName?.startsWith('Sprint') ? 'SQ' : 'Q'}${p}`;

/**
 * The part each TimingData line has reached, per the feed: SessionPart for every line that is not `KnockedOut`
 * (SessionPart advances in the message that sets it on the cars out). Empty outside qualifying and outside SessionPart 1–3.
 */
export function feedReached(state: Obj): Map<number, number> {
  if (view(state, 'SessionInfo')?.Type !== 'Qualifying') return new Map();
  const timing = view(state, 'TimingData');
  const part = timing?.SessionPart;
  // Qualifying has three parts: a hostile recording's huge SessionPart would size every row's cells.
  if (part === undefined || part < 1 || part > 3) return new Map();
  const lines = Object.entries(timing?.Lines ?? {});
  return new Map(
    lines.flatMap(([n, l]) => (l && /^\d{1,3}$/.test(n) && l.KnockedOut !== true ? [[Number(n), part]] : [])),
  );
}
