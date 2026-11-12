import type { Insertable, Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import type { MergeCounts } from '../merge/merge.ts';
import { chunks, writeLaps } from '../merge/write.ts';
import { attachRound } from './attach.ts';
import { DumpError } from './csv.ts';
import { loadDump } from './dump.ts';
import { LAST_YEAR } from './keys.ts';
import { roundRows, type SessionRows } from './rows.ts';

// The jolpica job (P3c, A§7): `jolpica [<year>…] [--dir <path>]` reads the Jolpica-F1 CSV dump that the owner put in
// <dir> and writes its 1950–2017 races and qualifyings as f1_ingest, one transaction per session. From 2018 on it adds
// race lap times to the matching OpenF1 or archive race (attach.ts, the 2018+ tier). No network: the
// dump is a local copy (ADR-0009). Logs carry keys, counts and fixed codes only: never a name, time, path or value.

export const JOLPICA_DIR = '/srv/f1/jolpica';
/** The advisory lock that keeps a second run out (`busy`). */
export const LOCK_KEY = 0x4631_4a4f; // 'F1JO'
// Laps are not among them: writeLaps replaces jolpica's candidates only and rebuilds `lap` (P3b).
const CHILDREN = ['driver', 'result', 'pit'] as const;

export type JolpicaDeps = { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'> };
/** `years` empty: every year in the dump. */
export type JolpicaArgs = { years: readonly number[]; dir: string };

/**
 * One transaction: lock the meeting and session rows, refuse (`not_jolpica`) when either exists with another source,
 * else upsert both, replace the child rows and write the laps through the merge (its counts).
 */
async function write(
  db: Kysely<DB>,
  meeting: Insertable<DB['meeting']>,
  rows: SessionRows,
): Promise<'not_jolpica' | MergeCounts> {
  return db.transaction().execute(async (trx) => {
    const { meeting_key } = meeting;
    const m = await trx
      .selectFrom('meeting')
      .select('source')
      .where('meeting_key', '=', meeting_key)
      .forUpdate()
      .executeTakeFirst();
    const s = await trx
      .selectFrom('session')
      .select('source')
      .where('session_key', '=', rows.key)
      .forUpdate()
      .executeTakeFirst();
    if ((m && m.source !== 'jolpica') || (s && s.source !== 'jolpica')) return 'not_jolpica';
    if (m) await trx.updateTable('meeting').set(meeting).where('meeting_key', '=', meeting_key).execute();
    else await trx.insertInto('meeting').values(meeting).execute();
    if (s) await trx.updateTable('session').set(rows.session).where('session_key', '=', rows.key).execute();
    else await trx.insertInto('session').values(rows.session).execute();
    for (const table of CHILDREN) await trx.deleteFrom(table).where('session_key', '=', rows.key).execute();
    for (const chunk of chunks(rows.driver)) await trx.insertInto('driver').values(chunk).execute();
    for (const chunk of chunks(rows.result)) await trx.insertInto('result').values(chunk).execute();
    for (const chunk of chunks(rows.pit)) await trx.insertInto('pit').values(chunk).execute();
    return writeLaps(trx, rows.key, 'jolpica', rows.lap);
  });
}

/** The job. True when the dump was read and no session failed. Another run holding the lock stops it (`busy`). */
export async function jolpica(deps: JolpicaDeps, args: JolpicaArgs): Promise<boolean> {
  // One run at a time: a session-level lock on a connection held for the run (the archive job's pattern).
  return deps.db.connection().execute(async (conn) => {
    const { rows } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`.execute(conn);
    if (rows[0]?.ok !== true) {
      deps.log.error({ years: args.years, error: 'busy' }, 'jolpica_done');
      return false;
    }
    try {
      return await job(deps, args);
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
    }
  });
}

async function job({ db, log }: JolpicaDeps, args: JolpicaArgs): Promise<boolean> {
  const counts = {
    rounds: 0,
    imported: 0,
    failed: 0,
    bad_key: 0,
    no_date: 0,
    bad_time: 0,
    bad_pit_time: 0,
    no_year: 0,
    // the 2018+ tier
    attached: 0,
    no_laps: 0,
    no_match: 0,
    ambiguous: 0,
    unknown_driver: 0,
    stale_lap: 0,
  };
  const done = (ok: boolean, error?: string, extra?: object) => {
    const passed = ok && counts.failed === 0;
    log[passed ? 'info' : 'error']({ years: args.years, ...counts, error, ...extra }, 'jolpica_done');
    return passed;
  };
  log.info({ years: args.years }, 'jolpica_start');
  const wanted = (year: number) => args.years.length === 0 || args.years.includes(year);

  let dump: Awaited<ReturnType<typeof loadDump>>;
  try {
    // From 2018 on only the race laps (the 2018+ tier).
    dump = await loadDump(args.dir, (year, type) => wanted(year) && (year <= LAST_YEAR || type === 'R'));
  } catch (err) {
    if (err instanceof DumpError) return done(false, 'bad_dump', { code: err.code, file: err.file });
    throw err;
  }
  counts.bad_time = dump.badTime;
  counts.bad_pit_time = dump.badPitTime;
  counts.no_year = [...dump.rounds.values()].filter((r) => r.year === null).length; // its season has no year

  const rounds = [...dump.rounds.values()]
    .filter((r): r is typeof r & { year: number } => r.year !== null && wanted(r.year))
    .sort((a, b) => a.year - b.year || (a.number ?? 0) - (b.number ?? 0) || a.id - b.id);
  for (const round of rounds) {
    if (round.year > LAST_YEAR) {
      await attachRound({ db, log }, dump, round, counts);
      continue;
    }
    const built = roundRows(dump, round);
    if (!built.ok) {
      counts.bad_key++;
      counts.failed++;
      log.error({ year: round.year, round: round.number, error: built.error }, 'jolpica');
      continue;
    }
    if (built.value === undefined) continue;
    counts.rounds++;
    counts.no_date += built.value.no_date;
    const { meeting, year, round: number } = built.value;
    for (const rows of built.value.sessions) {
      const fields = {
        session_key: rows.key,
        year,
        round: number,
        type: rows.type,
        drivers: rows.driver.length,
        results: rows.result.length,
        laps: rows.lap.length,
        pits: rows.pit.length,
        renumbered: rows.renumbered,
        skipped: rows.skipped,
      };
      let written: 'not_jolpica' | MergeCounts;
      try {
        written = await write(db, meeting, rows);
      } catch (err) {
        counts.failed++;
        log.error({ ...fields, error: 'db', cause: codeOf(err) }, 'jolpica');
        continue;
      }
      if (written === 'not_jolpica') {
        counts.failed++;
        log.error({ ...fields, error: written }, 'jolpica');
        continue;
      }
      counts.imported++;
      log.info({ ...fields, merge: written }, 'jolpica');
    }
  }
  return done(true);
}
