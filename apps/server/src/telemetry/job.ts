import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Insertable, Kysely } from 'kysely';
import type { Logger } from 'pino';
import { RAW_MAX_BYTES } from '../archive/files.ts';
import { codeOf, type DB } from '../db/db.ts';
import { parseFeedLine, parseJsonStream } from '../live/read.ts';
import { readCapped, segment, segments } from '../live/recording.ts';
import { carData, decodeZ, positions, zCounts } from '../live/telemetry.ts';
import { type FillArgs, firstComplete, RECORDING, sessionKeys } from '../merge/fill.ts';
import { type CarRow, type Coverage, type PosRow, packCar, packPos, pick, statusCode, t6, whole } from './pack.ts';

// The telemetry job (P7b, A§4, A§7, T1, T2): a session's CarData.z and Position.z, from its earliest complete
// recording and its archive files, into one packed `telemetry_lap` row per driver-lap of the `lap` table. The `fill`
// pattern: no network, the files read before the transaction opens. Logs carry counts and fixed codes only, never a
// value, a path or a payload (decoded telemetry is F1 data, A§12.1 invariant 3).

/**
 * `maxBytes`: both caps (a recording's kept lines, MAX_Z_BYTES; one archive file, RAW_MAX_BYTES), and `maxSamples`
 * MAX_SOURCE_SAMPLES, when a test sets them.
 */
export type TelemetryDeps = {
  db: Kysely<DB>;
  log: Pick<Logger, 'info' | 'error'>;
  maxBytes?: number;
  maxSamples?: number;
};
type Source = 'f1-live' | 'f1-archive';

/** A recording's kept `.z` lines in all: the bound on its decode work and memory. */
export const MAX_Z_BYTES = 64 * 1024 * 1024;
/**
 * A source's samples placed in a lap window, both topics (`too_many_samples`): the bound on the objects it holds until
 * it is packed. The largest real session, the 2021 test day 6396, places about 664 k CarData and 728 k Position samples.
 * About 150 B of heap each (11404: 1.15 M samples, a live set of 128–192 MB), so 2 M is about 300 MB, inside the 408 MB
 * heap Node takes under the job's 768m: the job fails here cleanly before it runs out of memory.
 */
export const MAX_SOURCE_SAMPLES = 2_000_000;
const TOPICS = ['CarData.z', 'Position.z'];
const CHUNK = 500;
const CHUNK_BYTES = 8 * 1024 * 1024;

/** One source's packed lap: its T1 coverage (`any`: it has a sample), both columns and the T6 figures. */
type Built = Coverage & { car: Buffer; pos: Buffer; drsPartial: boolean } & ReturnType<typeof t6>;
/** A lap's window [start, end) in epoch ms, the samples of the source being read, and each source's packed lap. */
type Window = {
  lap: number;
  start: number;
  end: number;
  car: CarRow[];
  pos: PosRow[];
  built: Partial<Record<Source, Built>>;
};

const fail = (code: string) => Object.assign(new Error(code), { code });
const absent = (err: unknown) => codeOf(err) === 'ENOENT';
/** Sorted by t, the first of equal t kept (a reconnect replays lines). */
const distinct = <T extends { t: number }>(rows: T[]) =>
  rows.sort((a, b) => a.t - b.t).filter((r, i, all) => i === 0 || r.t !== all[i - 1]?.t);

/**
 * Per driver, the laps with a date_start, by start. A lap ends at date_start + lap_ms, else at the date_start of the
 * driver's next lap number; with neither it has no window.
 */
async function windows(db: Kysely<DB>, key: number): Promise<Map<number, Window[]>> {
  const laps = await db
    .selectFrom('lap')
    .select(['driver_number', 'lap_number', 'date_start', 'lap_ms'])
    .where('session_key', '=', key)
    .orderBy('driver_number')
    .orderBy('lap_number')
    .execute();
  const out = new Map<number, Window[]>();
  for (const [i, l] of laps.entries()) {
    if (l.date_start === null) continue;
    const start = l.date_start.getTime();
    const next = laps[i + 1];
    const after =
      next?.driver_number === l.driver_number && next.lap_number === l.lap_number + 1 ? next.date_start : null;
    const end = l.lap_ms !== null ? start + l.lap_ms : after?.getTime();
    if (end === undefined || end <= start) continue;
    const ws = out.get(l.driver_number) ?? [];
    out.set(l.driver_number, ws);
    ws.push({ lap: l.lap_number, start, end, car: [], pos: [], built: {} });
  }
  for (const ws of out.values()) ws.sort((a, b) => a.start - b.start || a.lap - b.lap);
  return out;
}

/** The last window whose start ≤ t, if t is before its end: a sample lands in at most one lap. */
function find(ws: Window[] | undefined, t: number): Window | undefined {
  if (!ws) return undefined;
  let [lo, hi] = [0, ws.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ws[mid] as Window).start <= t) lo = mid + 1;
    else hi = mid;
  }
  const w = ws[lo - 1];
  return w && t < w.end ? w : undefined;
}

/** The two topics whose `<dir>/<Topic>.jsonStream` exists, as anything: `readCapped` reads only a regular file. */
const archiveFiles = (dir: string) =>
  TOPICS.filter((topic) => lstatSync(join(dir, `${topic}.jsonStream`), { throwIfNoEntry: false }) !== undefined);

/**
 * Every sealed segment's `.z` lines, Subscribe states skipped (they can be an hour old, as in P7a). The directory must
 * exist (`recording_missing`) and hold a sealed segment (`incomplete`).
 */
async function fromRecording(dir: string, max: number, take: (topic: string, payload: unknown) => void) {
  let found: Awaited<ReturnType<typeof segments>>;
  try {
    found = await segments(dir);
  } catch (err) {
    if (absent(err)) throw fail('recording_missing');
    throw err;
  }
  if (found.length === 0) throw fail('incomplete');
  let bytes = 0;
  for (const s of found) {
    for await (const line of segment(dir, s.base, s.plain)) {
      const kept = parseFeedLine(line.text).filter((ev) => TOPICS.includes(ev.topic) && !ev.full);
      if (kept.length === 0) continue;
      // ponytail: kept lines only, as fill: the others are bounded per line (MAX_LINE) and in memory by the
      // splitter, not in total bytes or CPU. Count every line if the job ever runs unattended.
      bytes += Buffer.byteLength(line.text);
      if (bytes > max) throw fail('too_large');
      for (const ev of kept) take(ev.topic, ev.payload);
    }
  }
}

/**
 * One session: each source decoded and packed per lap in turn, `pick` per lap, then one transaction replaces the
 * session's rows. A failing source throws, so the session stays as it was (the archive never stands in for a recording
 * that failed to read).
 */
async function telemetrySession(deps: TelemetryDeps, args: Omit<FillArgs, 'keys'>, key: number) {
  const { db } = deps;
  const session = await db
    .selectFrom('session')
    .select('session_key')
    .where('session_key', '=', key)
    .executeTakeFirst();
  if (!session) throw fail('unknown_session');
  const byDriver = await windows(db, key);
  if (byDriver.size === 0) return { skip: 'no_laps' };
  const dir = join(args.archiveDir, String(key));
  const archive = archiveFiles(dir);
  const rec = await firstComplete(db, key);
  if (!rec && archive.length === 0) return { skip: 'no_files' };

  const z = { 'f1-live': zCounts(), 'f1-archive': zCounts() };
  const dropped = { bad_sample: 0, bad_status: 0, drs_partial: 0, too_many_entries: 0, bad_entry: 0 };
  let tooLong = 0;
  const maxSamples = deps.maxSamples ?? MAX_SOURCE_SAMPLES;
  // Samples outside every window are dropped at once (garage and pre-session time).
  // ponytail: a source's in-window samples are held as objects until it is packed, bounded by MAX_SOURCE_SAMPLES (1.4
  // times the largest real session); pack per lap while reading if a recorded test day ever hits it.
  const take = (source: Source) => {
    let placed = 0;
    const into = (w: Window | undefined) => {
      if (w && ++placed > maxSamples) throw fail('too_many_samples');
      return w;
    };
    return (topic: string, payload: unknown) => {
      const d = decodeZ(payload);
      if (!d.ok) {
        z[source][d.fail]++;
        return;
      }
      if (topic === 'CarData.z') {
        const { entries, dropped: bad } = carData(d.value, dropped);
        dropped.bad_sample += bad;
        for (const { t, cars } of entries) {
          for (const [id, s] of cars) into(find(byDriver.get(id), t))?.car.push({ ...s, t });
        }
        return;
      }
      for (const { t, cars } of positions(d.value, dropped)) {
        for (const [id, s] of cars) {
          if (statusCode(s.status) === null) dropped.bad_status++;
          else into(find(byDriver.get(id), t))?.pos.push({ ...s, t });
        }
      }
    };
  };
  const pack = (source: Source) => {
    for (const w of [...byDriver.values()].flat()) {
      const [car, pos] = [distinct(w.car), distinct(w.pos)];
      [w.car, w.pos] = [[], []]; // dropped before the next source is read
      if (car.length + pos.length === 0) continue;
      const [c, p] = [packCar(car, w.start), packPos(pos, w.start)];
      if (!c || !p) {
        tooLong++;
        continue;
      }
      const ts = (rows: { t: number }[]) => rows.map((r) => r.t);
      const full = whole(ts(car), w.start, w.end) && whole(ts(pos), w.start, w.end);
      w.built[source] = { whole: full, any: true, car: c.buf, pos: p, drsPartial: c.drsPartial, ...t6(car) };
    }
  };

  if (rec) {
    if (!RECORDING.test(rec.path)) throw fail('bad_path'); // the CHECK pins it already
    await fromRecording(join(args.liveDir, rec.path), deps.maxBytes ?? MAX_Z_BYTES, take('f1-live'));
    pack('f1-live');
  }
  const fromArchive = take('f1-archive');
  for (const topic of archive) {
    const text = (await readCapped(join(dir, `${topic}.jsonStream`), deps.maxBytes ?? RAW_MAX_BYTES)).toString('utf8');
    // The payloads' own Utc and Timestamp give the times, so the stream needs no t0.
    const { events } = parseJsonStream(text, topic, 0);
    for (const ev of events) fromArchive(topic, ev.payload);
  }
  if (archive.length > 0) pack('f1-archive');

  const from = { 'f1-live': 0, 'f1-archive': 0 };
  let [wholeLaps, carBytes, posBytes] = [0, 0, 0];
  const rows: Insertable<DB['telemetry_lap']>[] = [];
  for (const [driver, ws] of byDriver) {
    for (const w of ws) {
      const source = pick(w.built['f1-live'], w.built['f1-archive']);
      const b = source && w.built[source];
      if (!source || !b) continue;
      from[source]++;
      wholeLaps += Number(b.whole);
      dropped.drs_partial += Number(b.drsPartial);
      carBytes += b.car.length;
      posBytes += b.pos.length;
      rows.push({
        session_key: key,
        driver_number: driver,
        lap_number: w.lap,
        source,
        date_start: new Date(w.start),
        car: b.car,
        pos: b.pos,
        top_kph: b.top_kph,
        full_throttle: b.full_throttle,
      });
    }
  }
  // At most CHUNK rows and CHUNK_BYTES of bytea per statement: 500 laps at the bound would be about 190 MB.
  const chunks: (typeof rows)[] = [];
  let bytes = CHUNK_BYTES;
  for (const row of rows) {
    const n = row.car.length + row.pos.length;
    const last = chunks.at(-1);
    if (!last || last.length === CHUNK || bytes + n > CHUNK_BYTES) {
      chunks.push([row]);
      bytes = n;
    } else {
      last.push(row);
      bytes += n;
    }
  }
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('session').select('session_key').where('session_key', '=', key).forUpdate().execute();
    await trx.deleteFrom('telemetry_lap').where('session_key', '=', key).execute();
    for (const chunk of chunks) await trx.insertInto('telemetry_lap').values(chunk).execute();
  });
  return {
    rows: rows.length,
    from,
    whole: wholeLaps,
    too_long: tooLong,
    dropped,
    z,
    car_bytes: carBytes,
    pos_bytes: posBytes,
  };
}

/**
 * The job. True when nothing failed. An unknown session, a failing source or a database error fails that session
 * only, and changes nothing in it; `no_laps` and `no_files` change nothing and are no failure. `'all'` is fill's.
 */
export async function telemetry(deps: TelemetryDeps, args: FillArgs): Promise<boolean> {
  const { db, log } = deps;
  const keys = await sessionKeys(db, args.keys);
  let failed = 0;
  for (const key of keys) {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
      log.info({ session_key: key, ...(await telemetrySession(deps, args, key)), ms: ms() }, 'telemetry');
    } catch (err) {
      failed++;
      log.error({ session_key: key, error: codeOf(err), ms: ms() }, 'telemetry'); // the code only: a message could quote a value
    }
  }
  const done = { sessions: keys.length, failed, max_rss_kb: process.resourceUsage().maxRSS };
  log[failed === 0 ? 'info' : 'error'](done, 'telemetry_done');
  return failed === 0;
}
