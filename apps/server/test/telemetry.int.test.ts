import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { type Kysely, sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { openRecording } from '../src/live/recording.ts';
import { run } from '../src/main.ts';
import { telemetry } from '../src/telemetry/job.ts';
import { unpackCar, unpackPos } from '../src/telemetry/pack.ts';
import { createTestDb, type TestDb } from './db.ts';

// The telemetry job (P7b, T1) against a real PostgreSQL 18 (f1_ingest login). Every `.z` payload is made here with
// deflateRawSync from synthetic JSON (A§12.1 invariant 3); the recording (through openRecording) and the archive
// streams are written under a temp dir with a `fixtures-private` segment, so the role's directory rule accepts it.

const M = 9800;
const [S, NOFILES, NOLAPS, JOLPICA] = [9801, 9802, 9803, 9809];
const T0 = Date.parse('2026-01-10T12:00:00Z');
const [STEP, SEC] = [250, 1000];
const DAY = 86_400_000;

/** A driver's samples every STEP over [from, to), in ms from T0. */
type Span = { driver: number; from: number; to: number };
// Driver 1: laps 1 and 2 of 10 s, lap 3 ends at lap 4's start (no lap_ms), lap 4. Driver 44: lap 1.
const LIVE: Span[] = [
  { driver: 1, from: -2 * SEC, to: 10 * SEC }, // lap 1 whole, after 2 s outside every lap (dropped)
  { driver: 1, from: 20 * SEC, to: 40 * SEC }, // laps 3 and 4 whole; lap 2 missing
  { driver: 44, from: 0, to: 5 * SEC }, // lap 1 in part
];
const ARCHIVE: Span[] = [
  { driver: 1, from: 0, to: 25 * SEC }, // cut off: laps 1 and 2 whole, lap 3 in part, lap 4 none
  { driver: 44, from: 0, to: 10 * SEC },
];
const SPEED = { live: 300, archive: 200 }; // + k % 10, so the top speed tells the source

const z = (value: unknown) => deflateRawSync(JSON.stringify(value)).toString('base64');
const iso = (t: number) => new Date(t).toISOString();
/** Channels of tick k (k × STEP from T0): throttle 100 on even ticks, 50 on odd ones. */
const channels = (k: number, base: number) => ({
  '0': 10_000 + k,
  '2': base + (k % 10),
  '3': 7,
  '4': k % 2 ? 50 : 100,
  '5': 0,
});
const place = (k: number) => ({ Status: 'OnTrack', X: 1000 + k, Y: -1000 - k, Z: 50 });

/** CarData.z and Position.z payloads, four ticks each, with every driver whose span holds the tick. */
function messages(spans: Span[], base: number) {
  const ticks = new Map<number, number[]>();
  for (const s of spans)
    for (let o = s.from; o < s.to; o += STEP) ticks.set(T0 + o, [...(ticks.get(T0 + o) ?? []), s.driver]);
  const times = [...ticks.keys()].sort((a, b) => a - b);
  const out: { t: number; car: string; pos: string }[] = [];
  for (let i = 0; i < times.length; i += 4) {
    const group = times.slice(i, i + 4);
    const cars = (t: number, value: (k: number) => unknown) =>
      Object.fromEntries((ticks.get(t) ?? []).map((d) => [String(d), value((t - T0) / STEP)]));
    const Entries = group.map((t) => ({ Utc: iso(t), Cars: cars(t, (k) => ({ Channels: channels(k, base) })) }));
    const Position = group.map((t) => ({ Timestamp: iso(t), Entries: cars(t, place) }));
    out.push({ t: group[0] as number, car: z({ Entries }), pos: z({ Position }) });
  }
  return out;
}

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;
let root: string;
let archiveDir: string;
let liveDir: string;
const lines: Record<string, unknown>[] = [];
const seen: Record<string, unknown>[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(JSON.parse(line)) });
const take = () => {
  const out = lines.splice(0);
  seen.push(...out);
  return out;
};
const runs = () => take().filter((l) => l.msg === 'telemetry');
const one = () => runs()[0] ?? expect.fail('no telemetry line');
const args = (keys: number[] | 'all' = [S]) => ({ keys, archiveDir, liveDir });

const stored = (key: number) =>
  db
    .selectFrom('telemetry_lap')
    .selectAll()
    .where('session_key', '=', key)
    .orderBy('driver_number')
    .orderBy('lap_number')
    .execute();
const md5 = async (key: number) =>
  (
    await sql<{ md5: string | null }>`SELECT md5(string_agg(t::text, ',' ORDER BY driver_number, lap_number)) AS md5
      FROM telemetry_lap t WHERE session_key = ${key}`.execute(db)
  ).rows[0]?.md5;

/** The synthetic recording of S, sealed through the real recorder, and its complete `recording` row. */
async function record() {
  const rec = openRecording({ dir: join(liveDir, `${S}-1`), now: () => T0 });
  const odd = T0 + 5125; // off the tick grid, in driver 1's lap 1
  // A Subscribe state (skipped: it can be an hour old) whose 999 km/h would be lap 1's top speed.
  rec.subscribed(T0 - 3 * SEC, {
    'CarData.z': z({ Entries: [{ Utc: iso(odd), Cars: { '1': { Channels: { ...channels(0, 0), '2': 999 } } } }] }),
  });
  rec.feed(T0, 'TimingData', { Lines: {} }, iso(T0)); // not read
  rec.feed(T0, 'Position.z', 'not base64!', iso(T0)); // bad_base64
  const bad = { Utc: iso(odd), Cars: { '1': { Channels: { ...channels(0, 0), '2': -1 } } } }; // bad_sample
  rec.feed(T0, 'CarData.z', z({ Entries: [bad] }), iso(T0));
  const status = { Timestamp: iso(odd), Entries: { '1': { ...place(0), Status: 254 } } }; // bad_status
  rec.feed(T0, 'Position.z', z({ Position: [status] }), iso(T0));
  const msgs = messages(LIVE, SPEED.live);
  for (const m of [...msgs, ...msgs.slice(0, 3)]) {
    // the first three again, as after a reconnect: equal t keep the first
    rec.feed(m.t + 2 * SEC, 'CarData.z', m.car, iso(m.t));
    rec.feed(m.t + 2 * SEC, 'Position.z', m.pos, iso(m.t));
  }
  await rec.finish();
  await admin
    .insertInto('recording')
    .values({ session_key: S, path: `${S}-1`, started_at: new Date(T0), ended_at: new Date(T0 + 1), complete: true })
    .execute();
}

/** `<archiveDir>/<S>/`: the two streams, a BOM and CRLF lines of `HH:MM:SS.mmm"<base64>"` from a minute before T0. */
function archive() {
  const dir = join(archiveDir, String(S));
  mkdirSync(dir, { recursive: true });
  const msgs = messages(ARCHIVE, SPEED.archive);
  const stream = (body: (m: (typeof msgs)[number]) => string) =>
    `﻿${msgs.map((m) => `${iso(m.t - T0 + 60_000).slice(11, 23)}"${body(m)}"`).join('\r\n')}\r\n`;
  writeFileSync(
    join(dir, 'CarData.z.jsonStream'),
    stream((m) => m.car),
  );
  writeFileSync(
    join(dir, 'Position.z.jsonStream'),
    stream((m) => m.pos),
  );
  return dir;
}

describe('the telemetry job (f1_ingest login, synthetic files)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'f1-telemetry-'));
    [archiveDir, liveDir] = [join(root, 'fixtures-private/archive'), join(root, 'fixtures-private/live')];
    mkdirSync(archiveDir, { recursive: true });
    mkdirSync(liveDir, { recursive: true });
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
    await admin
      .insertInto('meeting')
      .values({ meeting_key: M, source: 'openf1', year: 2026, name: 'Synthetic' })
      .execute();
    const session = (session_key: number, day: number, source = 'openf1') => ({
      session_key,
      source,
      meeting_key: M,
      name: 'Race',
      type: 'Race',
      date_start: new Date(T0 + day * DAY),
      date_end: new Date(T0 + day * DAY + 3_600_000),
    });
    await admin
      .insertInto('session')
      .values([session(S, 1), session(NOFILES, 2), session(NOLAPS, 3), session(JOLPICA, 4, 'jolpica')])
      .execute();
    const lap = (
      session_key: number,
      driver_number: number,
      lap_number: number,
      at: number,
      lap_ms: number | null,
    ) => ({
      session_key,
      source: 'openf1',
      driver_number,
      lap_number,
      date_start: new Date(T0 + at),
      lap_ms,
    });
    await admin
      .insertInto('lap')
      .values([
        lap(S, 1, 1, 0, 10 * SEC),
        lap(S, 1, 2, 10 * SEC, 10 * SEC),
        lap(S, 1, 3, 20 * SEC, null),
        lap(S, 1, 4, 30 * SEC, 10 * SEC),
        lap(S, 44, 1, 0, 10 * SEC),
        lap(NOFILES, 1, 1, 0, 10 * SEC),
      ])
      .execute();
    // A row from an earlier run: no_files must leave it.
    await admin
      .insertInto('telemetry_lap')
      .values({
        session_key: NOFILES,
        driver_number: 1,
        lap_number: 1,
        source: 'f1-archive',
        date_start: new Date(T0),
        car: Buffer.from([0]),
        pos: Buffer.alloc(0),
      })
      .execute();
    await record();
    archive();
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('T1: a whole recording lap wins, the archive fills a lap the recording lacks or holds in part', async () => {
    expect(await telemetry({ db, log }, args())).toBe(true);
    const zero = { bad_base64: 0, bad_deflate: 0, too_large: 0, zlib: 0, bad_json: 0 };
    expect(one()).toEqual({
      level: 30,
      time: expect.any(Number),
      msg: 'telemetry',
      session_key: S,
      rows: 5,
      from: { 'f1-live': 3, 'f1-archive': 2 },
      whole: 5,
      too_long: 0,
      dropped: { bad_sample: 1, bad_status: 1, drs_partial: 0 },
      z: { 'f1-live': { ...zero, bad_base64: 1 }, 'f1-archive': zero },
      car_bytes: 5 * (1 + 9 * 40), // the flags byte and 40 samples without DRS per lap
      pos_bytes: 5 * 9 * 40,
      ms: expect.any(Number),
    });
    const rows = await stored(S);
    // Lap 2 the recording lacks, driver 44's lap 1 it holds in part: both from the archive. The archive's cut-off
    // lap 3 and missing lap 4 leave the recording's.
    expect(rows.map((r) => [r.driver_number, r.lap_number, r.source, r.top_kph])).toEqual([
      [1, 1, 'f1-live', SPEED.live + 9],
      [1, 2, 'f1-archive', SPEED.archive + 9],
      [1, 3, 'f1-live', SPEED.live + 9],
      [1, 4, 'f1-live', SPEED.live + 9],
      [44, 1, 'f1-archive', SPEED.archive + 9],
    ]);
    // T6: 20 of the 39 pairs start at throttle 100 (every pair 250 ms).
    for (const r of rows) expect(r.full_throttle).toBeCloseTo(20 / 39, 6);
    const [first] = rows;
    expect(first?.date_start).toEqual(new Date(T0));
    // The garage samples, the Subscribe state, the bad samples and the replayed lines are not in it.
    const car = unpackCar(first?.car ?? Buffer.alloc(0));
    expect(car.t).toEqual(Array.from({ length: 40 }, (_, k) => k * STEP));
    expect(car.speed.slice(0, 3)).toEqual([300, 301, 302]);
    expect(car.drs).toBeNull();
    const pos = unpackPos(first?.pos ?? Buffer.alloc(0));
    expect(pos.t).toEqual(car.t);
    expect(pos.x.slice(0, 2)).toEqual([1000, 1001]);
    expect(new Set(pos.status)).toEqual(new Set(['OnTrack']));
  });

  it('a rerun gives the same rows', async () => {
    const before = await md5(S);
    expect(before).toMatch(/^[0-9a-f]{32}$/);
    expect(await telemetry({ db, log }, args())).toBe(true);
    expect(one()).toMatchObject({ rows: 5 });
    expect(await md5(S)).toBe(before);
  });

  it('a symlinked or FIFO archive file is not_file: the session fails and its rows stay', async () => {
    const before = await md5(S);
    const file = join(archiveDir, String(S), 'CarData.z.jsonStream');
    renameSync(file, join(root, 'CarData.z.jsonStream'));
    try {
      symlinkSync(join(root, 'CarData.z.jsonStream'), file);
      expect(await telemetry({ db, log }, args())).toBe(false);
      expect(one()).toMatchObject({ session_key: S, level: 50, error: 'not_file' });
      rmSync(file);
      execFileSync('mkfifo', [file]); // opened O_NONBLOCK: no writer, and no wait for one
      expect(await telemetry({ db, log }, args())).toBe(false);
      expect(one()).toMatchObject({ session_key: S, level: 50, error: 'not_file' });
    } finally {
      rmSync(file, { force: true });
      renameSync(join(root, 'CarData.z.jsonStream'), file);
    }
    expect(await md5(S)).toBe(before);
  });

  it('a source with too many samples in its windows changes nothing: too_many_samples', async () => {
    const before = await md5(S);
    // Each source places under 300 samples, the two together over 500: the cap is per source.
    expect(await telemetry({ db, log, maxSamples: 300 }, args())).toBe(true);
    expect(one()).toMatchObject({ level: 30, rows: 5 });
    expect(await telemetry({ db, log, maxSamples: 100 }, args())).toBe(false);
    expect(one()).toMatchObject({ session_key: S, level: 50, error: 'too_many_samples' });
    expect(await md5(S)).toBe(before);
  });

  it('a failing recording or a source past its cap changes nothing: recording_missing, too_large', async () => {
    const before = await md5(S);
    const { id } = await admin
      .insertInto('recording')
      .values({ session_key: S, path: `${S}-0`, started_at: new Date(T0 - SEC), complete: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      // The earliest complete recording is read; the archive never stands in for it.
      expect(await telemetry({ db, log }, args())).toBe(false);
      expect(one()).toMatchObject({ level: 50, error: 'recording_missing' });
    } finally {
      await admin.deleteFrom('recording').where('id', '=', id).execute();
    }
    expect(await telemetry({ db, log, maxBytes: 1_000 }, args())).toBe(false);
    expect(one()).toMatchObject({ level: 50, error: 'too_large' });
    expect(await md5(S)).toBe(before);
  });

  it('no_files and no_laps change nothing and are no failure; an unknown session fails, the others go on', async () => {
    const before = await md5(NOFILES);
    expect(before).not.toBeNull();
    expect(await telemetry({ db, log }, args([1, NOFILES, NOLAPS]))).toBe(false);
    const all = take();
    expect(all.filter((l) => l.msg === 'telemetry').map((l) => [l.session_key, l.level, l.error ?? l.skip])).toEqual([
      [1, 50, 'unknown_session'],
      [NOFILES, 30, 'no_files'],
      [NOLAPS, 30, 'no_laps'],
    ]);
    expect(all.at(-1)).toMatchObject({ msg: 'telemetry_done', level: 50, sessions: 3, failed: 1 });
    expect(await md5(NOFILES)).toBe(before);
  });

  it('--all goes through every session but the jolpica ones, newest first', async () => {
    expect(await telemetry({ db, log }, args('all'))).toBe(true);
    const all = take();
    expect(all.filter((l) => l.msg === 'telemetry').map((l) => l.session_key)).toEqual([NOLAPS, NOFILES, S]);
    expect(all.at(-1)).toEqual({
      level: 30,
      time: expect.any(Number),
      msg: 'telemetry_done',
      sessions: 3,
      failed: 0,
      max_rss_kb: expect.any(Number),
    });
  });

  it('the telemetry role: exit 0, and 1 for an unknown session', async () => {
    const env = { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_ingest };
    const dirs = ['--archive-dir', archiveDir, '--live-dir', liveDir];
    expect(await run(['telemetry', String(S), ...dirs], env, () => {})).toBe(0);
    expect(await run(['telemetry', '1', ...dirs], env, () => {})).toBe(1);
    expect(await stored(S)).toHaveLength(5);
  });

  it('every log line holds only the fixed keys: counts and codes, never a value, a path or a payload', () => {
    take();
    const keys: Record<string, string[]> = {
      done: ['failed', 'max_rss_kb', 'sessions'],
      error: ['error', 'ms', 'session_key'],
      skip: ['ms', 'session_key', 'skip'],
      ok: ['car_bytes', 'dropped', 'from', 'ms', 'pos_bytes', 'rows', 'session_key', 'too_long', 'whole', 'z'],
    };
    const codes = /^(unknown_session|not_file|too_large|too_many_samples|recording_missing|no_files|no_laps)$/;
    const leaves = (v: unknown): unknown[] =>
      typeof v === 'object' && v !== null ? Object.values(v).flatMap(leaves) : [v];
    expect(seen.length).toBeGreaterThan(10);
    for (const { level: _, time: __, msg, ...rest } of seen) {
      const kind = msg === 'telemetry_done' ? 'done' : 'error' in rest ? 'error' : 'skip' in rest ? 'skip' : 'ok';
      expect(msg).toMatch(/^telemetry(_done)?$/);
      expect(Object.keys(rest).sort()).toEqual(keys[kind]);
      const { error, skip, ...counts } = rest;
      for (const code of [error, skip].filter((c) => c !== undefined)) expect(code).toMatch(codes);
      for (const leaf of leaves(counts)) expect(typeof leaf).toBe('number');
    }
  });
});
