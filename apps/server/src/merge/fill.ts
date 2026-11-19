import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { overtakesOf } from '@f1/contracts';
import type { Insertable, Kysely } from 'kysely';
import type { Logger } from 'pino';
import { MAX_SESSION_BYTES, reconstruct } from '../archive/files.ts';
import { TOPICS } from '../archive/job.ts';
import { archiveRows } from '../archive/rows.ts';
import { codeOf, type DB } from '../db/db.ts';
import { createFeed } from '../live/merge.ts';
import { pitsSince } from '../live/pits.ts';
import { type FeedEvent, parseFeedLine, parseJsonStream } from '../live/read.ts';
import { readCapped, segment, segments } from '../live/recording.ts';
import type { Source } from './merge.ts';
import type { PitCounts } from './pits.ts';
import { chunks, mergeSession, type PitInput, staleLap, storeCandidates, writePits } from './write.ts';

// The fill job (P3b, A§4): reads a session's archive files and complete recording from disk, stores their laps as
// candidates and merges the session again. No network: nothing here reaches the F1 host or OpenF1. Only OpenF1
// sessions get file candidates (a session of another source has its own rows). Logs carry counts, ids and codes only.
// #236: the same read also replaces the session's `overtake` rows, the archive's entries first.
// #219: and writes each source's pit rows through writePits, as candidates next to OpenF1's.

/** `maxBytes`: the size cap of one source's files, MAX_SESSION_BYTES unless a test sets it. */
export type FillDeps = { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'>; maxBytes?: number };
export type FillArgs = { keys: readonly number[] | 'all'; archiveDir: string; liveDir: string };
type Laps = Parameters<typeof storeCandidates>[3];
type OvertakeRows = (Omit<Insertable<DB['overtake']>, 'session_key' | 'source' | 'date'> & { date: Date })[];
/**
 * `undefined`: the source has no (complete) files here, so its stored candidates stay. A throw fails that source.
 * `overtakes` is undefined when the source has no OvertakeSeries; `pits` is empty when it has no pit-lane entries
 * from an hour before the start on, and then the source's stored pit candidates stay.
 */
type Read = { laps: Laps; overtakes: OvertakeRows | undefined; pits: readonly PitInput[] } | undefined;

const fail = (code: string) => Object.assign(new Error(code), { code });
const absent = (err: unknown) => codeOf(err) === 'ENOENT';
/**
 * The topics the archive job downloads and archiveRows reads, and OvertakeSeries (#236), which only the overtake rows
 * read; any other `*.jsonStream` (P3e's telemetry) is ignored.
 */
const SERIES = 'OvertakeSeries';
const FILES = new Set<string>([...TOPICS, SERIES].map((t) => `${t}.jsonStream`));
const PARSED = new Set<string>([...TOPICS, SERIES]);
/** A recording's path, as its CHECK pins it: checked again before it is joined to a directory (fill, telemetry). */
export const RECORDING = /^[0-9]+-[0-9]+$/;

/** The earliest complete recording of a session, found through the table and never by listing the directory. */
export const firstComplete = (db: Kysely<DB>, key: number) =>
  db
    .selectFrom('recording')
    .select(['id', 'path'])
    .where('session_key', '=', key)
    .where('complete', '=', true)
    .orderBy('started_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();

/**
 * The keys, or for `'all'` every session but the jolpica ones (1950–2017: no files, and their laps have one source,
 * so neither job could change them), newest `date_end` first (fill, telemetry).
 */
export const sessionKeys = async (db: Kysely<DB>, keys: FillArgs['keys']): Promise<readonly number[]> =>
  keys !== 'all'
    ? keys
    : (
        await db
          .selectFrom('session')
          .select('session_key')
          .where('source', '<>', 'jolpica')
          .orderBy('date_end', (o) => o.desc().nullsLast())
          .orderBy('session_key', 'desc')
          .execute()
      ).map((s) => s.session_key);

/**
 * One source's OvertakeSeries events, in order, as overtake rows; undefined when none is valid, so the source counts
 * as absent. The Timestamps are absolute: no t0 is needed.
 */
function overtakeRows(events: readonly FeedEvent[]): OvertakeRows | undefined {
  const feed = createFeed();
  for (const ev of events) feed.apply(ev);
  const rows = overtakesOf(feed.state).map(({ t, ...o }) => ({ ...o, date: new Date(t) }));
  return rows.length > 0 ? rows : undefined;
}

/**
 * `<archiveDir>/<key>/`: rows of its topic files, each read through `readCapped` within what is left of `maxBytes`.
 * `start`: the session's date_start, epoch ms.
 */
async function fromArchive(
  dir: string,
  key: number,
  type: string | null,
  start: number,
  maxBytes: number,
): Promise<Read> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => FILES.has(f));
  } catch (err) {
    if (absent(err)) return undefined;
    throw err;
  }
  if (!['SessionInfo', 'TimingData'].every((t) => names.includes(`${t}.jsonStream`))) return undefined;
  const files = new Map<string, string>();
  let left = maxBytes;
  for (const f of names) {
    const buf = await readCapped(join(dir, f), left);
    left -= buf.length;
    files.set(f.slice(0, -'.jsonStream'.length), buf.toString('utf8'));
  }
  const series = files.get(SERIES);
  files.delete(SERIES);
  const built = archiveRows(files, key, type, start);
  if (!built.ok && built.error === 'incomplete') return undefined; // no t0: as the archive job, not a failure
  if (!built.ok) throw fail(built.error);
  // The Heartbeat t0 can be minutes off (A§6.2): such times must not fill OpenF1's.
  if (built.value.stats.t0 === 'heartbeat') throw fail('t0_heartbeat');
  const overtakes = series === undefined ? undefined : overtakeRows(parseJsonStream(series, SERIES, 0).events);
  return { laps: built.value.rows.lap, overtakes, pits: built.value.rows.pit };
}

/**
 * Every sealed segment of a complete recording in file order, the events not sorted. Only the archive job's topics and
 * OvertakeSeries are kept (so no `.z` topic): the parsers read no other. The directory must exist (`recording_missing`)
 * and hold a sealed segment and SessionInfo (`incomplete`). `start`: the session's date_start, epoch ms.
 */
async function fromRecording(dir: string, key: number, start: number, maxBytes: number): Promise<Read> {
  const events: FeedEvent[] = [];
  const series: FeedEvent[] = [];
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
      for (const ev of kept) (ev.topic === SERIES ? series : events).push(ev);
    }
  }
  const { info, rows } = reconstruct(events, 'f1-live');
  if (info?.Key === undefined || rows === undefined) throw fail('incomplete');
  if (info.Key !== key) throw fail('key_mismatch');
  return {
    laps: rows.laps.map(({ at: _, ...lap }) => lap),
    overtakes: overtakeRows(series),
    pits: pitsSince(events, start).rows,
  };
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
    .select(['source', 'type', 'date_start'])
    .where('session_key', '=', key)
    .executeTakeFirst();
  if (!session) throw fail('unknown_session');
  const read: [Source, Laps][] = [];
  const pits: ['f1-archive' | 'f1-live', readonly PitInput[]][] = [];
  const errors: Partial<Record<Source, string>> = {};
  let overtakes: { source: Source; rows: OvertakeRows } | undefined;
  const attempt = async (source: 'f1-archive' | 'f1-live', get: () => Read | Promise<Read>) => {
    try {
      const got = await get();
      if (!got) return;
      read.push([source, got.laps]);
      // A source without pit rows is absent: its stored pit candidates stay (as the overtakes').
      if (got.pits.length > 0) pits.push([source, got.pits]);
      // The archive is read first, so its entries win; else the recording's, else the stored rows stay.
      // Races only, from an hour before the start on: a Subscribe state or a stream can open with the day before's
      // entries. A source with none left is absent. A failed archive leaves the stored rows: the recording must not
      // replace them in that run.
      const from = session.date_start.getTime() - 3_600_000;
      const rows = session.type === 'Race' ? got.overtakes?.filter((r) => r.date.getTime() >= from) : undefined;
      if (rows?.length && !overtakes && !errors['f1-archive']) overtakes = { source, rows };
    } catch (err) {
      errors[source] = codeOf(err);
    }
  };
  let recording: number | undefined;
  if (session.source === 'openf1') {
    const start = session.date_start.getTime();
    await attempt('f1-archive', () =>
      fromArchive(join(args.archiveDir, String(key)), key, session.type, start, maxBytes),
    );
    const rec = await firstComplete(db, key);
    if (rec) {
      recording = Number(rec.id);
      // The CHECK pins the path already; checked again before it is joined to a directory.
      await attempt('f1-live', () => {
        if (!RECORDING.test(rec.path)) throw fail('bad_path');
        return fromRecording(join(args.liveDir, rec.path), key, start, maxBytes);
      });
    }
  }
  const { merge, pitMerge } = await db.transaction().execute(async (trx) => {
    if (await staleLap(trx, key)) throw fail('stale_lap');
    for (const [source, laps] of read) await storeCandidates(trx, key, source, laps);
    if (overtakes) {
      const { source, rows } = overtakes;
      await trx.deleteFrom('overtake').where('session_key', '=', key).execute();
      for (const chunk of chunks(rows))
        await trx
          .insertInto('overtake')
          .values(chunk.map((r) => ({ ...r, session_key: key, source })))
          .execute();
    }
    const merge = await mergeSession(trx, key);
    // Each writePits merges the whole session, so the last one's counts are the session's.
    let pitMerge: PitCounts | undefined;
    for (const [source, rows] of pits) pitMerge = await writePits(trx, key, source, rows);
    return { merge, pitMerge };
  });
  return {
    sources: Object.fromEntries(read.map(([source, laps]) => [source, laps.length])),
    errors,
    recording,
    ...(overtakes && { overtakes: { source: overtakes.source, rows: overtakes.rows.length } }),
    pits: Object.fromEntries(pits.map(([source, rows]) => [source, rows.length])),
    merge,
    ...(pitMerge && { pit_merge: pitMerge }),
  };
}

/**
 * The job. True when nothing failed. An unknown session, a failing source, a stale lap or a database error fails that
 * session only. `'all'` is every session but
 * the jolpica ones, newest first.
 */
export async function fill(deps: FillDeps, args: FillArgs): Promise<boolean> {
  const { db, log } = deps;
  const keys = await sessionKeys(db, args.keys);
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
