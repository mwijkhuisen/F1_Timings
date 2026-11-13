import { createDb } from '../apps/server/src/db/db.ts';
import { markPitIn } from '../apps/server/src/ingest/normalise.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { markLaps, type RuleLap, type RuleMessage, type Ruling } from '../apps/server/src/timing/rules.ts';

// The A§9 rule checks behind A§6.1 (P1c), reproducible: the real `markLaps` over the final sessions of a dev
// backfill, counts only, of the OpenF1 sessions (`source = 'openf1'`: the Jolpica and F1-archive sessions of a
// dev database have no race-control rules to check). (a) Per form of race-control message, how it found its lap;
// (b) per qualifying phase, the fastest valid lap of each driver against the official time (`result.durations_ms`). Never a time, a message or a
// name: only counts and session keys. Read-only, on the owner's machine (`DATABASE_URL`); refuses under CI
// (A§12.1 invariant 4).

export const FORMS = [
  'deleted, time and LAP n',
  'deleted, time only',
  'deleted, LAP form',
  'reinstated, time',
  'reinstated, lap',
  'unparsed',
] as const;
export const OUTCOMES = ['unique time', 'exact time among several', 'LAP n', 'no lap'] as const;
export type Form = (typeof FORMS)[number];
export type Outcome = (typeof OUTCOMES)[number];

type FactLap = RuleLap & { is_pit_out: boolean | null; is_pit_in?: boolean };
export type FactSession = {
  session_key: number;
  type: string | null;
  laps: FactLap[];
  race_control: RuleMessage[];
  results: { driver_number: number; durations_ms: number[] | null }[];
};
export type Facts = {
  forms: Record<Form, Record<Outcome, number>>;
  /** Sessions with a message that named no lap or fits no form. */
  unresolved: number[];
  phases: { equal: number; differs: number; sessions: number[]; noLap: number; noOfficial: number }[];
};

const formOf = (r: Ruling | 'unparsed'): Form =>
  r === 'unparsed'
    ? 'unparsed'
    : r.kind === 'reinstated'
      ? r.time_ms === null
        ? 'reinstated, lap'
        : 'reinstated, time'
      : r.time_ms === null
        ? 'deleted, LAP form'
        : r.lap === null
          ? 'deleted, time only'
          : 'deleted, time and LAP n';

/** The pure part: every count, from sessions the caller loaded. Resets what markLaps sets, then runs it. */
export function facts(sessions: readonly FactSession[]): Facts {
  const forms = Object.fromEntries(
    FORMS.map((f) => [f, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))]),
  ) as Facts['forms'];
  const unresolved = new Set<number>();
  const phases = [1, 2, 3].map(() => ({ equal: 0, differs: 0, sessions: [] as number[], noLap: 0, noOfficial: 0 }));

  for (const s of sessions) {
    const laps = s.laps.map((l) => ({ ...l, deleted: false, deleted_reason: null, quali_phase: null }));
    const marked = markPitIn(laps);
    markLaps(marked, s.race_control, s.type, (ruling, lap) => {
      let outcome: Outcome = 'no lap';
      if (lap && ruling !== 'unparsed') {
        // Called before the lap changes, so `marked` is what resolve saw.
        const own = marked.filter((l) => l.driver_number === ruling.car && (ruling.kind === 'deleted' || l.deleted));
        const t = ruling.time_ms;
        const timed = t === null ? [] : own.filter((l) => l.lap_ms !== null && Math.abs(l.lap_ms - t) <= 1);
        outcome =
          timed.length === 1 && timed[0] === lap
            ? 'unique time'
            : timed.length > 1 && lap.lap_ms === t && timed.filter((l) => l.lap_ms === t).length === 1
              ? 'exact time among several'
              : 'LAP n';
      }
      forms[formOf(ruling)][outcome]++;
      if (outcome === 'no lap') unresolved.add(s.session_key);
    });
    if (s.type !== 'Qualifying') continue;

    const drivers = new Set([...marked.map((l) => l.driver_number), ...s.results.map((r) => r.driver_number)]);
    for (const d of drivers) {
      const official = s.results.find((r) => r.driver_number === d)?.durations_ms ?? [];
      phases.forEach((tally, i) => {
        const times = marked
          .filter(
            (l) => l.driver_number === d && l.quali_phase === i + 1 && !l.deleted && !l.is_pit_out && !l.is_pit_in,
          )
          .flatMap((l) => (l.lap_ms === null ? [] : [l.lap_ms]));
        const best = times.length ? Math.min(...times) : null;
        const time = official[i] ?? null;
        if (time === null) {
          if (best !== null) tally.noOfficial++;
        } else if (best === null) tally.noLap++;
        else if (best === time) tally.equal++;
        else {
          tally.differs++;
          if (!tally.sessions.includes(s.session_key)) tally.sessions.push(s.session_key);
        }
      });
    }
  }
  return { forms, unresolved: [...unresolved].sort((a, b) => a - b), phases };
}

export function report(f: Facts): string[] {
  const lines = ['(a) race-control messages by form and how they found their lap'];
  for (const form of FORMS) lines.push(`${form}: ${OUTCOMES.map((o) => `${o} ${f.forms[form][o]}`).join(', ')}`);
  lines.push(`sessions with a message naming no lap: ${f.unresolved.join(' ') || 'none'}`);
  lines.push('(b) qualifying: fastest valid lap per driver against the official time');
  for (const [i, p] of f.phases.entries())
    lines.push(
      `Q${i + 1}: equal ${p.equal}, differs ${p.differs} (sessions ${p.sessions.join(' ') || 'none'}), no lap ${p.noLap}, no official time ${p.noOfficial}`,
    );
  return lines;
}

class Rollback extends Error {}

async function load(url: string): Promise<FactSession[]> {
  const db = createDb(url);
  const out: FactSession[] = [];
  try {
    await db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        const sessions = await trx
          .selectFrom('session')
          .select(['session_key', 'type'])
          .where('ingest_state', '=', 'final')
          .where('source', '=', 'openf1')
          .where('is_cancelled', '=', false)
          .orderBy('session_key')
          .execute();
        for (const s of sessions) {
          const [laps, rc, results] = await Promise.all([
            trx
              .selectFrom('lap')
              .select(['driver_number', 'lap_number', 'date_start', 'lap_ms', 'is_pit_out'])
              .where('session_key', '=', s.session_key)
              .execute(),
            trx
              .selectFrom('race_control')
              .select(['date', 'qualifying_phase', 'message'])
              .where('session_key', '=', s.session_key)
              .orderBy('id') // markLaps breaks date ties by input order
              .execute(),
            trx
              .selectFrom('result')
              .select(['driver_number', 'durations_ms'])
              .where('session_key', '=', s.session_key)
              .execute(),
          ]);
          const iso = (d: Date | null) => (d === null ? null : d.toISOString());
          out.push({
            ...s,
            laps: laps.map((l) => ({
              ...l,
              date_start: iso(l.date_start),
              deleted: false,
              deleted_reason: null,
              quali_phase: null,
            })),
            race_control: rc.map((r) => ({ ...r, date: iso(r.date) })),
            results,
          });
        }
        throw new Rollback();
      });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  } finally {
    await db.destroy();
  }
  return out;
}

export async function main(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  if (env.CI) {
    log('rules-facts refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  if (!env.DATABASE_URL) {
    log('usage: DATABASE_URL=<a dev backfill> rules-facts.ts');
    return EXIT_USAGE;
  }
  for (const line of report(facts(await load(env.DATABASE_URL)))) log(line);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.env, (line) => console.log(line));
}
