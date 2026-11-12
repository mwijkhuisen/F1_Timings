import type { Insertable, Transaction } from 'kysely';
import type { DB } from '../db/db.ts';
import { type MergeCounts, merge, type Source, VALUES } from './merge.ts';

// 1,000 rows × ≤ 21 columns stays far below PostgreSQL's 65,535 bind parameters.
const CHUNK = 1_000;

export const chunks = <T>(rows: readonly T[]) =>
  Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

const lock = (trx: Transaction<DB>, key: number) =>
  trx.selectFrom('session').select('type').where('session_key', '=', key).forUpdate().executeTakeFirstOrThrow();

/** The merge counts, or `no_candidates` (only with `keepWithoutCandidates`): `lap` rows but no candidates, nothing changed. */
export type Written = MergeCounts | 'no_candidates';

/**
 * The one lap write path (P3b, A§7), inside the writer's transaction: lock the session row, replace this source's
 * candidates in lap_source, merge every source's candidates of the session and replace its `lap` rows with the result.
 * Another source's candidates stay, so its fills come back on every rewrite. A writer's merge always replaces `lap`: an
 * empty result deletes the session's laps (an accepted-empty session, an archive rerun that parses none).
 */
export async function writeLaps(
  trx: Transaction<DB>,
  key: number,
  source: Source,
  laps: readonly Insertable<DB['lap']>[],
): Promise<MergeCounts> {
  await storeCandidates(trx, key, source, laps);
  return mergeSession(trx, key);
}

/** Locks the session row and replaces this source's candidates in lap_source; the `lap` rows wait for mergeSession. */
export async function storeCandidates(
  trx: Transaction<DB>,
  key: number,
  source: Source,
  laps: readonly Insertable<DB['lap']>[],
): Promise<void> {
  await lock(trx, key);
  await trx.deleteFrom('lap_source').where('session_key', '=', key).where('source', '=', source).execute();
  // The lap_source columns only: is_pit_in, deleted and deleted_reason are derived after the merge.
  const own = laps.map(
    (l) =>
      ({
        session_key: key,
        source,
        driver_number: l.driver_number,
        lap_number: l.lap_number,
        ...Object.fromEntries(VALUES.map((c) => [c, l[c] ?? null])),
      }) as Insertable<DB['lap_source']>,
  );
  for (const chunk of chunks(own)) await trx.insertInto('lap_source').values(chunk).execute();
}

/**
 * Merges the session's stored candidates again and replaces its `lap` rows. With `keepWithoutCandidates` (the `fill`
 * job's only) a session with `lap` rows but no candidate (an older image wrote `lap` only, A§7) is left unchanged and
 * gives `no_candidates`: an empty merge would delete those laps. Without it, an empty merge deletes them.
 */
export function mergeSession(
  trx: Transaction<DB>,
  key: number,
  opts: { keepWithoutCandidates: true },
): Promise<Written>;
export function mergeSession(trx: Transaction<DB>, key: number): Promise<MergeCounts>;
export async function mergeSession(
  trx: Transaction<DB>,
  key: number,
  opts?: { keepWithoutCandidates: true },
): Promise<Written> {
  const { type } = await lock(trx, key); // a second lock in the same transaction is a no-op

  // pg gives a timestamptz as a Date; an ISO string keeps its ms (Date.parse of a Date would drop them).
  const candidates = (await trx.selectFrom('lap_source').selectAll().where('session_key', '=', key).execute()).map(
    (c) => ({ ...c, date_start: c.date_start === null ? null : c.date_start.toISOString() }),
  );
  // Id order: markLaps breaks date ties by input order, as on the insert.
  const raceControl = (
    await trx
      .selectFrom('race_control')
      .select(['date', 'qualifying_phase', 'message'])
      .where('session_key', '=', key)
      .orderBy('id')
      .execute()
  ).map((m) => ({ ...m, date: m.date === null ? null : m.date.toISOString() }));
  if (
    opts?.keepWithoutCandidates &&
    candidates.length === 0 &&
    (await trx.selectFrom('lap').select('lap_number').where('session_key', '=', key).limit(1).executeTakeFirst())
  )
    return 'no_candidates';
  const { rows, counts } = merge(candidates, raceControl, type);

  await trx.deleteFrom('lap').where('session_key', '=', key).execute();
  // `filled` as JSON text, which the jsonb column parses as is (no reliance on pg's own serialisation of an object).
  for (const chunk of chunks(rows))
    await trx
      .insertInto('lap')
      .values(chunk.map((r) => ({ ...r, filled: JSON.stringify(r.filled) })))
      .execute();
  return counts;
}
