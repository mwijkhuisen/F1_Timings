import type { Insertable, Transaction } from 'kysely';
import type { DB } from '../db/db.ts';
import { type MergeCounts, merge, type Source, VALUES } from './merge.ts';

// 1,000 rows × ≤ 21 columns stays far below PostgreSQL's 65,535 bind parameters.
const CHUNK = 1_000;

export const chunks = <T>(rows: readonly T[]) =>
  Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

const lock = (trx: Transaction<DB>, key: number) =>
  trx.selectFrom('session').select('type').where('session_key', '=', key).forUpdate().executeTakeFirstOrThrow();

/**
 * The one lap write path (P3b, A§7), inside the writer's transaction: lock the session row, replace this source's
 * candidates in lap_source, merge every source's candidates of the session and replace its `lap` rows with the result.
 * Another source's candidates stay, so its fills come back on every rewrite. Returns the merge counts.
 */
export async function writeLaps(
  trx: Transaction<DB>,
  key: number,
  source: Source,
  laps: readonly Insertable<DB['lap']>[],
): Promise<MergeCounts> {
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
  return mergeSession(trx, key);
}

/** Merges the session's stored candidates again and replaces its `lap` rows (the `fill` job without files). */
export async function mergeSession(trx: Transaction<DB>, key: number): Promise<MergeCounts> {
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
  const { rows, counts } = merge(candidates, raceControl, type);

  await trx.deleteFrom('lap').where('session_key', '=', key).execute();
  // The JSON text: pg would turn a JS array into a PostgreSQL array, not jsonb.
  for (const chunk of chunks(rows))
    await trx
      .insertInto('lap')
      .values(chunk.map((r) => ({ ...r, filled: JSON.stringify(r.filled) })))
      .execute();
  return counts;
}
