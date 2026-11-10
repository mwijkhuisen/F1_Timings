import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import { chunks, live } from '../ingest/ingest.ts';
import { DISK_LOW_BYTES, freeBytes } from '../live/recorder.ts';
import { checkToken, readTokenFile } from '../live/token.ts';
import { download, type Failure, ORIGIN } from './files.ts';
import { type ArchiveRows, archiveRows, indexPlan, type Planned } from './rows.ts';

// The archive job (A§6.2, P3a): `archive <year> [<session_key>…]` walks static/<year>/Index.json, downloads each
// session's topics at a fixed rate, keeps them under <dir>/<session_key>/<Topic>.jsonStream and writes the rows as
// f1_ingest. Logs carry keys, counts and fixed codes only: never the token, a URL, a payload or a message text.

export const TOKEN_FILE = '/srv/f1/state/f1tv-token';
export const ARCHIVE_DIR = '/srv/f1/archive';
/** Only what the rows need; a later phase adds topics and the job resumes. */
export const TOPICS = [
  'SessionInfo',
  'Heartbeat',
  'SessionData',
  'ExtrapolatedClock',
  'TimingData',
  'TimingAppData',
  'DriverList',
  'RaceControlMessages',
  'WeatherData',
] as const;
/** One request at a time, at least this long between request starts (≤ 1,800 an hour). */
export const GAP_MS = 2_000;
/** The advisory lock that keeps a second run out (`busy`). */
export const LOCK_KEY = 0x4631_4152; // 'F1AR'
/** No request this close to the token's exp: the run stops with `token_expired` instead. */
const EXP_MARGIN_MS = 60_000;
/** A 403 or 404 on these leaves no marker: the session is incomplete for this run and a rerun asks again. */
const REQUIRED = new Set<string>(['SessionInfo', 'TimingData']);
const CHILDREN = ['driver', 'lap', 'stint', 'race_control', 'result', 'weather'] as const;

export type ArchiveDeps = {
  db: Kysely<DB>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: Pick<Logger, 'info' | 'error'>;
  /** Free bytes under a path (statfs); a test seam. */
  freeBytes?: (path: string) => number;
};
export type ArchiveArgs = { year: number; keys: readonly number[]; tokenFile: string; dir: string };

const code = (e: Failure) => (e.code === 'http' ? `http_${e.status}` : e.code);

/** Temp file (a fresh name, never an existing file), then rename: a present file is a complete one. */
function put(path: string, bytes: Buffer | string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  renameSync(tmp, path);
}

/**
 * One transaction: lock the meeting and session rows, refuse (`not_archive`) when either exists with another
 * source, else upsert both as `final` and replace the child rows.
 */
async function write(db: Kysely<DB>, plan: Planned, rows: ArchiveRows): Promise<'not_archive' | undefined> {
  return db.transaction().execute(async (trx) => {
    const { meeting_key } = plan.meeting;
    const m = await trx
      .selectFrom('meeting')
      .select('source')
      .where('meeting_key', '=', meeting_key)
      .forUpdate()
      .executeTakeFirst();
    const s = await trx
      .selectFrom('session')
      .select('source')
      .where('session_key', '=', plan.key)
      .forUpdate()
      .executeTakeFirst();
    if ((m && m.source !== plan.meeting.source) || (s && s.source !== plan.session.source)) return 'not_archive';
    if (m) await trx.updateTable('meeting').set(plan.meeting).where('meeting_key', '=', meeting_key).execute();
    else await trx.insertInto('meeting').values(plan.meeting).execute();
    if (s) await trx.updateTable('session').set(plan.session).where('session_key', '=', plan.key).execute();
    else await trx.insertInto('session').values(plan.session).execute();
    for (const table of CHILDREN) await trx.deleteFrom(table).where('session_key', '=', plan.key).execute();
    // The cast: Kysely cannot relate a table name from a loop to its row type.
    for (const [table, list] of Object.entries(rows) as [keyof ArchiveRows, object[]][]) {
      for (const chunk of chunks(list))
        await trx
          .insertInto(table)
          .values(chunk as never)
          .execute();
    }
    return undefined;
  });
}

/**
 * The job. True when nothing failed (an incomplete session or a bad path is no failure). Another run (`busy`), a bad
 * or expiring token, a 401, an Index failure, low disk or a live window stops it early with false. A database error
 * outside a session's write throws.
 */
export async function archive(deps: ArchiveDeps, args: ArchiveArgs): Promise<boolean> {
  // One run at a time: two would double the token's request rate. A session-level lock on a connection held for the run.
  return deps.db.connection().execute(async (conn) => {
    const { rows } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`.execute(conn);
    if (rows[0]?.ok !== true) {
      deps.log.error({ year: args.year, error: 'busy' }, 'archive_done');
      return false;
    }
    try {
      return await job(deps, args);
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
    }
  });
}

async function job(deps: ArchiveDeps, args: ArchiveArgs): Promise<boolean> {
  const { db, now, sleep, log, freeBytes: free = freeBytes } = deps;
  const { year, dir } = args;
  const counts = { imported: 0, failed: 0, incomplete: 0, bad_path: 0, t0_heartbeat: 0 };
  const done = (ok: boolean, error?: string) => {
    const passed = ok && counts.failed === 0;
    log[passed ? 'info' : 'error']({ year, ...counts, error }, 'archive_done');
    return passed;
  };
  const file = readTokenFile(args.tokenFile);
  const checked = file.ok ? checkToken(file.value, now().getTime()) : file;
  if (!checked.ok) return done(false, checked.error);
  const { token, exp } = checked.value;
  log.info({ year, token_expires_at: new Date(exp * 1000).toISOString() }, 'archive_start');

  let last = Number.NEGATIVE_INFINITY;
  /** Undefined once the token is about to expire: the caller stops the run with `token_expired`. */
  const get = async (path: string) => {
    const wait = last + GAP_MS - now().getTime();
    if (wait > 0) await sleep(wait);
    if (now().getTime() >= exp * 1000 - EXP_MARGIN_MS) return undefined;
    last = now().getTime();
    return download(`${ORIGIN}/static/${path}`, token);
  };
  const stopped = async () => ((await live(deps)) ? 'live_session' : undefined);

  const before = await stopped();
  if (before) return done(false, before);
  const index = await get(`${year}/Index.json`);
  if (index === undefined) return done(false, 'token_expired');
  if (!index.ok) return done(false, `index_${code(index.error)}`);
  mkdirSync(dir, { recursive: true });
  put(join(dir, `index-${year}.json`), index.value.bytes);
  const plan = indexPlan(index.value.bytes.toString('utf8'), year, now().getTime());
  if (plan === undefined) return done(false, 'index_format');

  const wanted = (key: number) => args.keys.length === 0 || args.keys.includes(key);
  for (const key of plan.badPath.filter(wanted)) {
    counts.bad_path++;
    log.error({ session_key: key, year, error: 'bad_path' }, 'archive');
  }
  if (plan.badIndex > 0) log.error({ year, sessions: plan.badIndex, error: 'bad_index' }, 'archive');
  for (const key of args.keys) {
    if (plan.sessions.some((s) => s.key === key) || plan.badPath.includes(key)) continue;
    counts.failed++;
    log.error({ session_key: key, year, error: 'not_in_index' }, 'archive');
  }

  for (const session of plan.sessions.filter((s) => wanted(s.key))) {
    const reason = await stopped();
    if (reason) return done(false, reason);
    // The recorder warns at this and stops at 1 GiB (A§11.2): the archive never pushes it there.
    if (free(dir) < DISK_LOW_BYTES) return done(false, 'disk_low');
    const started = performance.now();
    const line = (fields: Record<string, unknown>) => ({
      session_key: session.key,
      year,
      type: session.type,
      ...fields,
      ms: Math.round(performance.now() - started),
    });
    const into = join(dir, String(session.key));
    mkdirSync(into, { recursive: true });
    const files = new Map<string, string>();
    let missing = 0;
    let error: string | undefined;
    for (const topic of TOPICS) {
      const path = join(into, `${topic}.jsonStream`);
      // An empty marker: the archive answered 403 or 404, so a rerun does not ask again (never for REQUIRED).
      const marker = join(into, `${topic}.missing`);
      if (!existsSync(path) && !existsSync(marker)) {
        const got = await get(`${session.path}${topic}.jsonStream`);
        if (got === undefined || (!got.ok && got.error.code === 'http' && got.error.status === 401)) {
          const stop = got === undefined ? 'token_expired' : 'http_401';
          log.error(line({ error: stop }), 'archive');
          return done(false, stop);
        }
        if (got.ok) put(path, got.value.bytes);
        else if (got.error.code === 'http' && (got.error.status === 403 || got.error.status === 404)) {
          if (REQUIRED.has(topic)) {
            missing++;
            break;
          }
          put(marker, '');
        } else {
          error = code(got.error);
          break;
        }
      }
      if (existsSync(path)) files.set(topic, readFileSync(path, 'utf8'));
      else missing++;
    }
    if (error !== undefined) {
      counts.failed++;
      log.error(line({ files: files.size, skipped_files: missing, error }), 'archive');
      continue;
    }

    const built = archiveRows(files, session.key, session.type);
    if (!built.ok) {
      if (built.error === 'incomplete') counts.incomplete++;
      else counts.failed++;
      log.error(line({ files: files.size, skipped_files: missing, error: built.error }), 'archive');
      continue;
    }
    const { rows, stats } = built.value;
    const fields = {
      files: files.size,
      skipped_files: missing,
      t0: stats.t0,
      t0_heartbeat_delta_ms: stats.t0_heartbeat_delta_ms,
      laps: rows.lap.length,
      stints: rows.stint.length,
      drivers: rows.driver.length,
      race_control: rows.race_control.length,
      weather: rows.weather.length,
      phases: stats.phases,
      rules: stats.rules,
      skipped_lines: stats.skipped_lines,
    };
    let refused: 'not_archive' | undefined;
    try {
      refused = await write(db, session, rows);
    } catch (err) {
      counts.failed++;
      log.error(line({ ...fields, error: 'db', cause: codeOf(err) }), 'archive');
      continue;
    }
    if (refused) {
      counts.failed++;
      log.error(line({ ...fields, error: refused }), 'archive');
      continue;
    }
    counts.imported++;
    if (stats.t0 === 'heartbeat') counts.t0_heartbeat++;
    log.info(line(fields), 'archive');
  }
  return done(true);
}
