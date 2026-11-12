import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { MAX_SESSION_BYTES, reconstruct } from '../archive/files.ts';
import { TOPICS } from '../archive/job.ts';
import { archiveRows } from '../archive/rows.ts';
import { codeOf, type DB } from '../db/db.ts';
import { segment, segments } from '../live/playback.ts';
import { type FeedEvent, parseFeedLine } from '../live/read.ts';
import type { Source } from './merge.ts';
import { mergeSession, staleLap, storeCandidates } from './write.ts';

// The fill job (P3b, A§4): reads a session's archive files and complete recording from disk, stores their laps as
// candidates and merges the session again. No network: nothing here reaches the F1 host or OpenF1. Only OpenF1
// sessions get file candidates (a session of another source has its own rows). Logs carry counts, ids and codes only.

/** `maxBytes`: the size cap of one source's files, MAX_SESSION_BYTES unless a test sets it. */
export type FillDeps = { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'>; maxBytes?: number };
export type FillArgs = { keys: readonly number[] | 'all'; archiveDir: string; liveDir: string };
type Laps = Parameters<typeof storeCandidates>[3];
/** `undefined`: the source has no (complete) files here, so its stored candidates stay. A throw fails that source. */
type Read = Laps | undefined;

const fail = (code: string) => Object.assign(new Error(code), { code });
const absent = (err: unknown) => codeOf(err) === 'ENOENT';
/** The topics the archive job downloads and archiveRows reads; any other `*.jsonStream` (P3e's telemetry) is ignored. */
const FILES = new Set<string>(TOPICS.map((t) => `${t}.jsonStream`));
const PARSED = new Set<string>(TOPICS);
const RECORDING = /^[0-9]+-[0-9]+$/;

/** `<archiveDir>/<key>/`: rows of its topic files, each a regular file (a symlink fails), the size capped before any read. */
function fromArchive(dir: string, key: number, type: string | null, maxBytes: number): Read {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => FILES.has(f));
  } catch (err) {
    if (absent(err)) return undefined;
    throw err;
  }
  if (!['SessionInfo', 'TimingData'].every((t) => names.includes(`${t}.jsonStream`))) return undefined;
  const stats = names.map((f) => lstatSync(join(dir, f)));
  if (!stats.every((st) => st.isFile())) throw fail('not_file');
  if (stats.reduce((n, st) => n + st.size, 0) > maxBytes) throw fail('too_large');
  const files = new Map(names.map((f) => [f.slice(0, -'.jsonStream'.length), readFileSync(join(dir, f), 'utf8')]));
  const built = archiveRows(files, key, type);
  if (!built.ok && built.error === 'incomplete') return undefined; // no t0: as the archive job, not a failure
  if (!built.ok) throw fail(built.error);
  // The Heartbeat t0 can be minutes off (A§6.2): such times must not fill OpenF1's.
  if (built.value.stats.t0 === 'heartbeat') throw fail('t0_heartbeat');
  return built.value.rows.lap;
}

/**
 * Every sealed segment of a complete recording in file order, the events not sorted. Only the archive job's topics are
 * kept (so no `.z` topic): the parser reads no other. The directory must exist (`recording_missing`) and hold a sealed
 * segment and SessionInfo (`incomplete`).
 */
async function fromRecording(dir: string, key: number, maxBytes: number): Promise<Read> {
  const events: FeedEvent[] = [];
  let bytes = 0;
  let found: Awaited<ReturnType<typeof segments>>;
  try {
    found = await segments(dir);
  } catch (err) {
    if (absent(err)) throw fail('recording_missing');
    throw err;
  }
  if (found.length === 0) throw fail('incomplete');
  for (const s of found) {
    for await (const line of segment(dir, s.base, s.plain)) {
      const kept = parseFeedLine(line.text).filter((ev) => PARSED.has(ev.topic));
      if (kept.length === 0) continue;
      // ponytail: kept lines only (a snapshot line counts whole); the others are bounded per line (MAX_LINE) and in
      // memory by the splitter, not in total bytes or CPU. Fine for an owner-run job; count every line if fill ever
      // runs unattended.
      bytes += Buffer.byteLength(line.text);
      if (bytes > maxBytes) throw fail('too_large');
      events.push(...kept);
    }
  }
  const { info, rows } = reconstruct(events, 'f1-live');
  if (info?.Key === undefined || rows === undefined) throw fail('incomplete');
  if (info.Key !== key) throw fail('key_mismatch');
  return rows.laps.map(({ at: _, ...lap }) => lap);
}

/**
 * One session: read each source's files (a failing source is logged in `errors` and keeps its stored candidates),
 * then one transaction stores what read and merges the session once, unless a `lap` row lacks its own candidate
 * (`stale_lap`, A§7): then it changes nothing.
 */
async function fillSession(deps: FillDeps, args: Omit<FillArgs, 'keys'>, key: number) {
  const { db } = deps;
  const maxBytes = deps.maxBytes ?? MAX_SESSION_BYTES;
  const session = await db
    .selectFrom('session')
    .select(['source', 'type'])
    .where('session_key', '=', key)
    .executeTakeFirst();
  if (!session) throw fail('unknown_session');
  const read: [Source, Laps][] = [];
  const errors: Partial<Record<Source, string>> = {};
  const attempt = async (source: Source, get: () => Read | Promise<Read>) => {
    try {
      const laps = await get();
      if (laps) read.push([source, laps]);
    } catch (err) {
      errors[source] = codeOf(err);
    }
  };
  let recording: number | undefined;
  if (session.source === 'openf1') {
    await attempt('f1-archive', () => fromArchive(join(args.archiveDir, String(key)), key, session.type, maxBytes));
    // The earliest complete recording, found through the table and never by listing the directory.
    const rec = await db
      .selectFrom('recording')
      .select(['id', 'path'])
      .where('session_key', '=', key)
      .where('complete', '=', true)
      .orderBy('started_at')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    if (rec) {
      recording = Number(rec.id);
      // The CHECK pins the path already; checked again before it is joined to a directory.
      await attempt('f1-live', () => {
        if (!RECORDING.test(rec.path)) throw fail('bad_path');
        return fromRecording(join(args.liveDir, rec.path), key, maxBytes);
      });
    }
  }
  const merge = await db.transaction().execute(async (trx) => {
    if (await staleLap(trx, key)) throw fail('stale_lap');
    for (const [source, laps] of read) await storeCandidates(trx, key, source, laps);
    return mergeSession(trx, key);
  });
  return { sources: Object.fromEntries(read.map(([source, laps]) => [source, laps.length])), errors, recording, merge };
}

/**
 * The job. True when nothing failed. An unknown session, a failing source, a stale lap or a database error fails that
 * session only. `'all'` is every session, newest first.
 */
export async function fill(deps: FillDeps, args: FillArgs): Promise<boolean> {
  const { db, log } = deps;
  const keys =
    args.keys === 'all'
      ? (
          await db
            .selectFrom('session')
            .select('session_key')
            .orderBy('date_end', (o) => o.desc().nullsLast())
            .orderBy('session_key', 'desc')
            .execute()
        ).map((s) => s.session_key)
      : args.keys;
  let failed = 0;
  for (const key of keys) {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
      const done = await fillSession(deps, args, key);
      const bad = Object.keys(done.errors).length > 0;
      if (bad) failed++;
      log[bad ? 'error' : 'info']({ session_key: key, ...done, ms: ms() }, 'fill');
    } catch (err) {
      failed++;
      log.error({ session_key: key, error: codeOf(err), ms: ms() }, 'fill'); // the code only: a message could quote a value
    }
  }
  log[failed === 0 ? 'info' : 'error']({ sessions: keys.length, failed }, 'fill_done');
  return failed === 0;
}
