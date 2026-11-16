import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import { live } from '../ingest/ingest.ts';
import { DISK_LOW_BYTES, freeBytes } from '../live/recorder.ts';
import { checkToken, readTokenFile } from '../live/token.ts';
import type { MergeCounts } from '../merge/merge.ts';
import { chunks, writeLaps } from '../merge/write.ts';
import {
  download,
  type Failure,
  INDEX_MAX_BYTES,
  type IndexSession,
  indexSessions,
  indexTopics,
  MAX_BYTES,
  MAX_SESSION_BYTES,
  ORIGIN,
  offIndexSession,
  RAW_MAX_BYTES,
} from './files.ts';
import { type ArchiveRows, archiveRows, type Planned, planSessions } from './rows.ts';

// The archive job (A§6.2, P3a, P3e): `archive <year> [<session_key>…]` walks static/<year>/Index.json (plus the
// OFF_INDEX sessions), downloads every topic of each session's own Index.json at a fixed rate, keeps them under
// <dir>/<session_key>/<Topic>.jsonStream and, through 2022, writes the rows from the TOPICS files as f1_ingest. Logs
// carry keys, counts and fixed codes only: never the token, a URL, a topic name, a payload or a message text.

export const TOKEN_FILE = '/srv/f1/state/f1tv-token';
export const ARCHIVE_DIR = '/srv/f1/archive';
/** The topics the rows read, in this order and before any other (the REQUIRED break); every other topic is raw-only. */
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
  'SessionStatus', // SessionData's StatusSeries where SessionData is a 403 (2018–2019)
] as const;
const PARSED = new Set<string>(TOPICS);
/**
 * A session without its own Index.json (403 or 404: before the 2018 US GP), or with one that is no `{Feeds: {…}}`:
 * the 29 topics the 2018 races before the US GP answered 200 for (P3d, A§6.2).
 */
export const OLD_TOPICS = [
  'ArchiveStatus',
  'AudioStreams',
  'CarData.z',
  'CurrentTyres',
  'DriverList',
  'ExtrapolatedClock',
  'Heartbeat',
  'LapSeries',
  'Position.z',
  'RaceControlMessages',
  'SessionInfo',
  'SessionStatus',
  'TimingAppData',
  'TimingData',
  'TimingDataF1',
  'TimingStats',
  'TlaRcm',
  'TopThree',
  'TrackStatus',
  'TyreStintSeries',
  'WeatherData',
  'WeatherDataSeries',
  'LapCount',
  'DriverRaceInfo',
  'ContentStreams',
  'DriverScore',
  'SPFeed',
  'PitLaneTimeCollection',
  'TeamRadio',
] as const;
/** More valid topics than this in a session Index fail the session (`too_many_topics`): 35 are known. */
export const MAX_TOPICS = 64;
/** From this year on the job downloads the files only and writes no rows (H3: the rows are OpenF1's). */
export const FILES_ONLY_FROM = 2023;
/**
 * Sessions the year Indexes lack (2018 Australia, the 2020 and 2021 tests) or list without a Path (2018 Bahrain and
 * China), from the P3e S1 probe and P3d (owner decision D1, A§6.2): keys and paths only. Each one's SessionInfo gives
 * its session and meeting; the key and the path stay the table's.
 */
export const OFF_INDEX: Readonly<Record<number, readonly { key: number; path: string }[]>> = {
  2018: [
    { key: 5067, path: '2018/2018-03-25_Australian_Grand_Prix/2018-03-23_Practice_1/' },
    { key: 5068, path: '2018/2018-03-25_Australian_Grand_Prix/2018-03-23_Practice_2/' },
    { key: 5069, path: '2018/2018-03-25_Australian_Grand_Prix/2018-03-24_Practice_3/' },
    { key: 5070, path: '2018/2018-03-25_Australian_Grand_Prix/2018-03-24_Qualifying/' },
    { key: 5066, path: '2018/2018-03-25_Australian_Grand_Prix/2018-03-25_Race/' },
    { key: 5075, path: '2018/2018-04-08_Bahrain_Grand_Prix/2018-04-06_Practice_1/' },
    { key: 5076, path: '2018/2018-04-08_Bahrain_Grand_Prix/2018-04-06_Practice_2/' },
    { key: 5077, path: '2018/2018-04-08_Bahrain_Grand_Prix/2018-04-07_Practice_3/' },
    { key: 5078, path: '2018/2018-04-08_Bahrain_Grand_Prix/2018-04-07_Qualifying/' },
    { key: 5085, path: '2018/2018-04-15_Chinese_Grand_Prix/2018-04-14_Practice_3/' },
  ],
  2020: [
    { key: 5738, path: '2020/2020-02-21_Pre-Season_Test_1/2020-02-19_Practice_1/' },
    { key: 5739, path: '2020/2020-02-21_Pre-Season_Test_1/2020-02-20_Practice_2/' },
    { key: 5740, path: '2020/2020-02-21_Pre-Season_Test_1/2020-02-21_Practice_3/' },
    { key: 5741, path: '2020/2020-02-28_Pre-Season_Test_2/2020-02-26_Practice_1/' },
    { key: 5742, path: '2020/2020-02-28_Pre-Season_Test_2/2020-02-27_Practice_2/' },
    { key: 5743, path: '2020/2020-02-28_Pre-Season_Test_2/2020-02-28_Practice_3/' },
  ],
  2021: [
    { key: 6394, path: '2021/2021-03-14_Pre-Season_Test/2021-03-12_Practice_1/' },
    { key: 6395, path: '2021/2021-03-14_Pre-Season_Test/2021-03-13_Practice_2/' },
    { key: 6396, path: '2021/2021-03-14_Pre-Season_Test/2021-03-14_Practice_3/' },
  ],
};
/** One request at a time, at least this long between request starts (≤ 1,800 an hour). */
export const GAP_MS = 2_000;
/** The advisory lock that keeps a second run out (`busy`). */
export const LOCK_KEY = 0x4631_4152; // 'F1AR'
/** No request this close to the token's exp: the run stops with `token_expired` instead. */
const EXP_MARGIN_MS = 60_000;
/** A session that ended less than this before the job's now is skipped (`recent`), as the rain job's final fetch. */
export const FINAL_AFTER_MS = 24 * 3_600_000;
/** The session types a log line names; any other Type text is `other` (remote text never reaches a log). */
const TYPES = new Set<string | null>(['Race', 'Qualifying', 'Practice']);
/** A 403 or 404 on these leaves no marker: the session is incomplete for this run and a rerun asks again. */
const REQUIRED = new Set<string>(['SessionInfo', 'TimingData']);
// Laps are not among them: writeLaps replaces the archive's candidates only and rebuilds `lap` (P3b).
const CHILDREN = ['driver', 'stint', 'race_control', 'result', 'weather'] as const;

export type ArchiveDeps = {
  db: Kysely<DB>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: Pick<Logger, 'info' | 'error'>;
  /** Free bytes under a path (statfs); a test seam. */
  freeBytes?: (path: string) => number;
  /** OFF_INDEX; a test seam. */
  offIndex?: typeof OFF_INDEX;
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
 * source, else upsert both as `final`, replace the child rows and write the laps through the merge (its counts).
 */
async function write(db: Kysely<DB>, plan: Planned, rows: ArchiveRows): Promise<'not_archive' | MergeCounts> {
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
    const { lap, ...children } = rows;
    // The cast: Kysely cannot relate a table name from a loop to its row type.
    for (const [table, list] of Object.entries(children) as [keyof ArchiveRows, object[]][]) {
      for (const chunk of chunks(list))
        await trx
          .insertInto(table)
          .values(chunk as never)
          .execute();
    }
    return writeLaps(trx, plan.key, 'f1-archive', lap);
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
  const { db, now, sleep, log, freeBytes: free = freeBytes, offIndex = OFF_INDEX } = deps;
  const { year, dir } = args;
  const filesOnly = year >= FILES_ONLY_FROM;
  // downloaded: sessions whose topics are all on disk or marked, SessionInfo and TimingData among them (both modes);
  // imported: sessions whose rows were written (through 2022 only).
  // recent: sessions that ended under FINAL_AFTER_MS ago, skipped.
  const counts = { downloaded: 0, imported: 0, failed: 0, incomplete: 0, bad_path: 0, t0_heartbeat: 0, recent: 0 };
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
  /**
   * One request, or the code that stops the run instead: `token_expired` (about to expire), `disk_low` (checked before
   * every request) or `http_401`.
   */
  const get = async (path: string, max?: number) => {
    const wait = last + GAP_MS - now().getTime();
    if (wait > 0) await sleep(wait);
    if (now().getTime() >= exp * 1000 - EXP_MARGIN_MS) return 'token_expired' as const;
    // The recorder warns at this and stops at 1 GiB (A§11.2): the archive never pushes it there.
    if (free(dir) < DISK_LOW_BYTES) return 'disk_low' as const;
    last = now().getTime();
    const got = await download(`${ORIGIN}/static/${path}`, token, max);
    if (!got.ok && got.error.code === 'http' && got.error.status === 401) return 'http_401' as const;
    // A 200 without a byte is no file (a present file is a complete one): a failed request, and a rerun asks again.
    return got.ok && got.value.bytes.length === 0 ? { ok: false as const, error: { code: 'empty' as const } } : got;
  };
  /** The archive answers 403 for what it does not serve (A§6.2). */
  const absent = (e: Failure) => e.code === 'http' && (e.status === 403 || e.status === 404);
  const stopped = async () => ((await live(deps)) ? 'live_session' : undefined);

  const before = await stopped();
  if (before) return done(false, before);
  mkdirSync(dir, { recursive: true }); // the disk floor is read under it
  const index = await get(`${year}/Index.json`);
  if (typeof index === 'string') return done(false, index === 'http_401' ? `index_${index}` : index);
  if (!index.ok) return done(false, `index_${code(index.error)}`);
  put(join(dir, `index-${year}.json`), index.value.bytes);
  const listed = indexSessions(index.value.bytes.toString('utf8'));
  if (listed === undefined) return done(false, 'index_format');

  const wanted = (key: number) => args.keys.length === 0 || args.keys.includes(key);
  // The off-Index sessions of the year (D1), whatever the keys, so a keyed run gives a meeting the same span; only a
  // wanted entry's failure counts. An Index session with a Path wins a duplicate key. A 403 or 404 leaves no marker
  // (incomplete): a rerun asks again.
  const table = offIndex[year] ?? [];
  const extras: IndexSession[] = [];
  const extraKeys: number[] = [];
  for (const { key, path } of table) {
    if (listed.some((s) => s.Key === key)) continue;
    const into = join(dir, String(key));
    const info = join(into, 'SessionInfo.jsonStream');
    if (!existsSync(info)) {
      const got = await get(`${path}SessionInfo.jsonStream`);
      if (typeof got === 'string') {
        log.error({ session_key: key, year, error: got }, 'archive');
        return done(false, got);
      }
      if (!got.ok) {
        if (!wanted(key)) continue;
        if (absent(got.error)) counts.incomplete++;
        else counts.failed++;
        log.error({ session_key: key, year, error: absent(got.error) ? 'incomplete' : code(got.error) }, 'archive');
        continue;
      }
      mkdirSync(into, { recursive: true });
      put(info, got.value.bytes);
    }
    extras.push(offIndexSession(readFileSync(info, 'utf8'), key, path));
    extraKeys.push(key);
  }
  const plan = planSessions([...listed, ...extras], year, now().getTime());

  for (const key of plan.badPath.filter(wanted)) {
    counts.bad_path++;
    log.error({ session_key: key, year, error: 'bad_path' }, 'archive');
  }
  // An off-Index entry planSessions dropped is a failure of its own (its SessionInfo lacks a field the plan needs).
  const planned = new Set([...plan.sessions.map((s) => s.key), ...plan.badPath]);
  const dropped = extraKeys.filter((key) => !planned.has(key));
  for (const key of dropped.filter(wanted)) {
    counts.failed++;
    log.error({ session_key: key, year, error: 'bad_index' }, 'archive');
  }
  const badIndex = plan.badIndex - dropped.length;
  if (badIndex > 0) log.error({ year, sessions: badIndex, error: 'bad_index' }, 'archive');
  for (const key of args.keys) {
    if (plan.sessions.some((s) => s.key === key) || plan.badPath.includes(key) || table.some((e) => e.key === key))
      continue;
    counts.failed++;
    log.error({ session_key: key, year, error: 'not_in_index' }, 'archive');
  }

  for (const session of plan.sessions.filter((s) => wanted(s.key))) {
    const type = TYPES.has(session.type) ? session.type : 'other';
    // The current year: the archive may not be final yet (an overrun, a file still being written).
    if (session.end > now().getTime() - FINAL_AFTER_MS) {
      counts.recent++;
      log.info({ session_key: session.key, year, type, state: 'recent' }, 'archive');
      continue;
    }
    const reason = await stopped();
    if (reason) return done(false, reason);
    const started = performance.now();
    const line = (fields: Record<string, unknown>) => ({
      session_key: session.key,
      year,
      type,
      ...fields,
      ms: Math.round(performance.now() - started),
    });
    const into = join(dir, String(session.key));
    mkdirSync(into, { recursive: true });

    // The session's own topic list: its Index.json, kept; a 403 or 404 leaves the `Index.missing` marker (before the
    // 2018 US GP), and that, or an Index that is no {Feeds: {…}} (not kept, so a rerun asks again), means OLD_TOPICS.
    // The URL is always <Path><Topic>.jsonStream, never the Index's StreamPath.
    const indexFile = join(into, 'Index.json');
    const indexMarker = join(into, 'Index.missing');
    let own = existsSync(indexFile) ? indexTopics(readFileSync(indexFile, 'utf8')) : undefined;
    if (!existsSync(indexFile) && !existsSync(indexMarker)) {
      const got = await get(`${session.path}Index.json`, INDEX_MAX_BYTES);
      if (typeof got === 'string') {
        log.error(line({ error: got }), 'archive');
        return done(false, got);
      }
      if (got.ok) {
        own = indexTopics(got.value.bytes.toString('utf8'));
        if (own !== undefined) put(indexFile, got.value.bytes);
      } else if (absent(got.error)) put(indexMarker, '');
      else {
        counts.failed++;
        log.error(line({ error: code(got.error) }), 'archive');
        continue;
      }
    }
    if (own !== undefined && own.length > MAX_TOPICS) {
      counts.failed++;
      log.error(line({ topics: own.length, error: 'too_many_topics' }), 'archive');
      continue;
    }
    // The parsed TOPICS first, so the REQUIRED break ends a session before any raw download.
    const list = [...new Set<string>([...TOPICS, ...(own ?? OLD_TOPICS)])];

    const paths = new Map<string, string>(); // the TOPICS files: the only ones ever read
    let raw = 0; // every other topic: written, never read or parsed
    let missing = 0;
    let error: string | undefined; // a parsed topic's failure: no rows
    let rawError: string | undefined; // a raw topic's failure: the rows are still written, the session fails
    for (const topic of list) {
      const parsed = PARSED.has(topic);
      const path = join(into, `${topic}.jsonStream`);
      // An empty marker: the archive answered 403 or 404, so a rerun does not ask again (never for REQUIRED).
      const marker = join(into, `${topic}.missing`);
      if (!existsSync(path) && !existsSync(marker)) {
        const got = await get(`${session.path}${topic}.jsonStream`, parsed ? MAX_BYTES : RAW_MAX_BYTES);
        if (typeof got === 'string') {
          log.error(line({ error: got }), 'archive');
          return done(false, got);
        }
        if (got.ok) put(path, got.value.bytes);
        else if (absent(got.error)) {
          if (REQUIRED.has(topic)) {
            missing++;
            break;
          }
          put(marker, '');
        } else {
          if (parsed) error = code(got.error);
          else rawError = code(got.error);
          break;
        }
      }
      if (!existsSync(path)) missing++;
      else if (parsed) paths.set(topic, path);
      else raw++;
    }
    const files = {
      files: paths.size,
      raw_files: raw,
      skipped_files: missing,
      topics: list.length,
      topics_from: own === undefined ? 'fallback' : 'index',
    };
    if (error !== undefined) {
      counts.failed++;
      log.error(line({ ...files, error }), 'archive');
      continue;
    }
    const whole = [...REQUIRED].every((t) => paths.has(t));
    if (whole && rawError === undefined) counts.downloaded++;
    if (filesOnly) {
      // H3: no row is written and no file is read; a session without SessionInfo or TimingData is still incomplete.
      if (rawError !== undefined) counts.failed++;
      else if (!whole) counts.incomplete++;
      const fail = rawError ?? (whole ? undefined : 'incomplete');
      log[fail === undefined ? 'info' : 'error'](line({ ...files, error: fail }), 'archive');
      continue;
    }
    // Sized before anything is read: the parse holds the whole session in memory (MAX_SESSION_BYTES). Raw files never
    // count: they are never read.
    if ([...paths.values()].reduce((n, p) => n + statSync(p).size, 0) > MAX_SESSION_BYTES) {
      counts.failed++;
      log.error(line({ ...files, error: 'too_large' }), 'archive');
      continue;
    }
    const texts = new Map([...paths].map(([topic, path]) => [topic, readFileSync(path, 'utf8')]));

    const built = archiveRows(texts, session.key, session.type);
    if (!built.ok) {
      if (built.error === 'incomplete') counts.incomplete++;
      else counts.failed++;
      log.error(line({ ...files, error: built.error }), 'archive');
      continue;
    }
    const { rows, stats } = built.value;
    const fields = {
      ...files,
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
    let written: 'not_archive' | MergeCounts;
    try {
      written = await write(db, session, rows);
    } catch (err) {
      counts.failed++;
      log.error(line({ ...fields, error: 'db', cause: codeOf(err) }), 'archive');
      continue;
    }
    if (written === 'not_archive') {
      counts.failed++;
      log.error(line({ ...fields, error: written }), 'archive');
      continue;
    }
    counts.imported++;
    if (stats.t0 === 'heartbeat') counts.t0_heartbeat++;
    // A raw topic failed: imported, and failed too, so the rerun asks for it again.
    if (rawError !== undefined) counts.failed++;
    // The Heartbeat t0 can be minutes off (A§6.2): imported, but an error line to look at.
    const bad = stats.t0 === 'heartbeat' || rawError !== undefined;
    log[bad ? 'error' : 'info'](line({ ...fields, merge: written, error: rawError }), 'archive');
  }
  return done(true);
}
