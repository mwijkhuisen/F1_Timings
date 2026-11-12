import type { Insertable, Kysely } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import { staleLap, writeLaps } from '../merge/write.ts';
import type { Result } from '../openf1/schemas.ts';
import type { Dump, Round, Session } from './dump.ts';

// The 2018+ tier (P3c, H6, A§7): a Jolpica race from 2018 on adds its lap times to the one OpenF1 or archive race it
// matches, as the lowest-ranked candidates. Only `lap_source` and `lap` change, through writeLaps: the merge's D3 rules
// decide what fills (a higher value stays, a conflict over 1 ms fills nothing, a lap the others lack is added). Logs
// carry keys, counts and codes only.

const HOUR = 3_600_000;
const SOURCES: readonly string[] = ['openf1', 'f1-archive'];

/** One of our sessions, `date_start` in epoch ms. */
export type Ours = {
  session_key: number;
  source: string;
  type: string | null;
  name: string | null;
  is_cancelled: boolean;
  date_start: number;
};
export type AttachSkipped = { unknown_driver: number; no_number: number; lap_dup: number };
export type AttachCounts = Record<
  'failed' | 'no_date' | 'no_laps' | 'no_match' | 'ambiguous' | 'unknown_driver' | 'stale_lap' | 'attached',
  number
>;

/**
 * The one race the Jolpica race starting at `start` belongs to: type and name 'Race' (so never a sprint, OpenF1's
 * 'Sprint' or the archive's 'Sprint Qualifying'), not cancelled, from OpenF1 or the archive, and starting within 1 h.
 */
export function matchRace(start: number, sessions: readonly Ours[]): Result<number, 'no_match' | 'ambiguous'> {
  const [hit, ...more] = sessions.filter(
    (s) =>
      s.type === 'Race' &&
      s.name === 'Race' &&
      !s.is_cancelled &&
      SOURCES.includes(s.source) &&
      Math.abs(s.date_start - start) <= HOUR,
  );
  if (hit === undefined) return { ok: false, error: 'no_match' };
  return more.length > 0 ? { ok: false, error: 'ambiguous' } : { ok: true, value: hit.session_key };
}

/** The race's laps as candidates of session `key`: lap number and time only, for the car numbers in `drivers`. */
export function lapCandidates(
  dump: Dump,
  race: Session,
  key: number,
  drivers: ReadonlySet<number>,
): { lap: Insertable<DB['lap']>[]; skipped: AttachSkipped } {
  const skipped: AttachSkipped = { unknown_driver: 0, no_number: 0, lap_dup: 0 };
  const lap: Insertable<DB['lap']>[] = [];
  const seen = new Set<string>();
  for (const e of dump.entries.get(race.id) ?? []) {
    const car = e.roundEntry === null ? undefined : dump.roundEntries.get(e.roundEntry)?.car;
    for (const l of dump.laps.get(e.id) ?? []) {
      if (l.number === null || l.number < 1 || l.number > 32_767)
        skipped.no_number++; // a fastest-lap marker row
      else if (car == null || !drivers.has(car)) skipped.unknown_driver++;
      else if (seen.has(`${car}:${l.number}`)) skipped.lap_dup++;
      else {
        seen.add(`${car}:${l.number}`);
        // storeCandidates writes every other value as null.
        lap.push({
          session_key: key,
          source: 'jolpica',
          driver_number: car,
          lap_number: l.number,
          lap_ms: l.ms,
          date_start: null,
          is_pit_out: null,
        });
      }
    }
  }
  return { lap, skipped };
}

/**
 * One 2018+ round: its first race with laps, matched to one of our races, gets its laps stored and merged in one
 * transaction, unless a `lap` row there lacks its own candidate (`stale_lap`, fill's guard: a merge would lose it).
 * Bumps `counts`; a stale lap or a database error is a failure, a round without a match is not.
 */
export async function attachRound(
  { db, log }: { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'> },
  dump: Dump,
  round: Round & { year: number },
  counts: AttachCounts,
): Promise<void> {
  const race = round.sessions.filter((s) => s.type === 'R').sort((a, b) => a.id - b.id)[0];
  if (race === undefined || !(dump.entries.get(race.id) ?? []).some((e) => dump.laps.has(e.id))) {
    counts.no_laps++; // a future round
    return;
  }
  const at = { year: round.year, round: round.number };
  const start = race.start;
  if (start === null) {
    counts.no_date++;
    log.info({ ...at, skip: 'no_date' }, 'jolpica_attach');
    return;
  }
  const near = await db
    .selectFrom('session')
    .select(['session_key', 'source', 'type', 'name', 'is_cancelled', 'date_start'])
    .where('date_start', '>=', new Date(start - HOUR))
    .where('date_start', '<=', new Date(start + HOUR))
    .execute();
  const match = matchRace(
    start,
    near.map((s) => ({ ...s, date_start: s.date_start.getTime() })),
  );
  if (!match.ok) {
    counts[match.error]++;
    log.info({ ...at, skip: match.error }, 'jolpica_attach');
    return;
  }
  const key = match.value;
  let done: 'stale_lap' | (ReturnType<typeof lapCandidates> & { merge: Awaited<ReturnType<typeof writeLaps>> });
  try {
    done = await db.transaction().execute(async (trx) => {
      if (await staleLap(trx, key)) return 'stale_lap' as const; // nothing written
      const drivers = await trx.selectFrom('driver').select('driver_number').where('session_key', '=', key).execute();
      const built = lapCandidates(dump, race, key, new Set(drivers.map((d) => d.driver_number)));
      return { ...built, merge: await writeLaps(trx, key, 'jolpica', built.lap) };
    });
  } catch (err) {
    counts.failed++;
    log.error({ session_key: key, ...at, error: 'db', cause: codeOf(err) }, 'jolpica_attach');
    return;
  }
  if (done === 'stale_lap') {
    counts.stale_lap++;
    counts.failed++;
    log.error({ session_key: key, ...at, error: done }, 'jolpica_attach');
    return;
  }
  counts.attached++;
  counts.unknown_driver += done.skipped.unknown_driver;
  log.info(
    { session_key: key, ...at, laps: done.lap.length, skipped: done.skipped, merge: done.merge },
    'jolpica_attach',
  );
}
