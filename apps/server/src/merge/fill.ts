import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { MAX_SESSION_BYTES, readStreams, reconstruct } from '../archive/files.ts';
import { archiveRows } from '../archive/rows.ts';
import { codeOf, type DB } from '../db/db.ts';
import { segment, segments } from '../live/playback.ts';
import { type FeedEvent, parseFeedLine } from '../live/read.ts';
import type { MergeCounts, Source } from './merge.ts';
import { mergeSession, writeLaps } from './write.ts';

// The fill job (P3b, A§4): reads a session's archive files and complete recording from disk, stores their laps as
// candidates and merges the session again. No network: nothing here reaches the F1 host or OpenF1. Only OpenF1
// sessions get file candidates (a session of another source has its own rows). Logs carry counts and ids only.

export type FillDeps = { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'> };
export type FillArgs = { keys: readonly number[] | 'all'; archiveDir: string; liveDir: string };
type Laps = Parameters<typeof writeLaps>[3];
/** `undefined`: the source has no files here, so its stored candidates stay. */
type Read = { laps: Laps; recording?: string } | undefined;

const fail = (code: string) => Object.assign(new Error(code), { code });
const absent = (err: unknown) => codeOf(err) === 'ENOENT';

/** `<archiveDir>/<key>/`: rows of its SessionInfo and TimingData streams, the size capped before any read. */
function fromArchive(dir: string, key: number, type: string | null): Read {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.jsonStream'));
  } catch (err) {
    if (absent(err)) return undefined;
    throw err;
  }
  if (!['SessionInfo', 'TimingData'].every((t) => names.includes(`${t}.jsonStream`))) return undefined;
  if (names.reduce((n, f) => n + statSync(join(dir, f)).size, 0) > MAX_SESSION_BYTES) throw fail('too_large');
  const built = archiveRows(readStreams(dir), key, type);
  if (!built.ok) throw fail(built.error);
  return { laps: built.value.rows.lap };
}

/** Every sealed segment of a recording in file order, `.z` topics skipped as playback does, the events not sorted. */
async function fromRecording(dir: string, key: number): Promise<Read> {
  const events: FeedEvent[] = [];
  let bytes = 0;
  let found: Awaited<ReturnType<typeof segments>>;
  try {
    found = await segments(dir);
  } catch (err) {
    if (absent(err)) return undefined;
    throw err;
  }
  for (const s of found) {
    for await (const line of segment(dir, s.base, s.plain)) {
      const kept = parseFeedLine(line.text).filter((ev) => !ev.topic.endsWith('.z'));
      if (kept.length === 0) continue;
      bytes += Buffer.byteLength(line.text);
      if (bytes > MAX_SESSION_BYTES) throw fail('too_large');
      events.push(...kept);
    }
  }
  const { info, rows } = reconstruct(events, 'f1-live');
  if (info?.Key !== key || rows === undefined) throw fail('key_mismatch');
  return { laps: rows.laps.map(({ at: _, ...lap }) => lap) };
}

/** One session: read what the files give, then one transaction writes those sources and merges (or only merges). */
async function fillSession(deps: FillDeps, args: Omit<FillArgs, 'keys'>, key: number) {
  const { db } = deps;
  const session = await db
    .selectFrom('session')
    .select(['source', 'type'])
    .where('session_key', '=', key)
    .executeTakeFirst();
  if (!session) throw fail('unknown_session');
  const read: [Source, Laps][] = [];
  let recording: number | undefined;
  if (session.source === 'openf1') {
    const archive = fromArchive(join(args.archiveDir, String(key)), key, session.type);
    if (archive) read.push(['f1-archive', archive.laps]);
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
    const live = rec && (await fromRecording(join(args.liveDir, rec.path), key));
    if (rec && live) {
      recording = Number(rec.id);
      read.push(['f1-live', live.laps]);
    }
  }
  const merge: MergeCounts = await db.transaction().execute(async (trx) => {
    let counts: MergeCounts | undefined;
    for (const [source, laps] of read) counts = await writeLaps(trx, key, source, laps);
    return counts ?? mergeSession(trx, key);
  });
  return { sources: Object.fromEntries(read.map(([source, laps]) => [source, laps.length])), recording, merge };
}

/**
 * The job. True when nothing failed. An unknown session, a too large or mismatched file or a database error fails that
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
      log.info({ session_key: key, ...(await fillSession(deps, args, key)), ms: ms() }, 'fill');
    } catch (err) {
      failed++;
      log.error({ session_key: key, error: codeOf(err), ms: ms() }, 'fill'); // the code only: a message could quote a value
    }
  }
  log[failed === 0 ? 'info' : 'error']({ sessions: keys.length, failed }, 'fill_done');
  return failed === 0;
}
