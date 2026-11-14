import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Lap,
  Live,
  PlaybackDelta,
  PlaybackEnd,
  PlaybackLaps,
  PlaybackPing,
  PlaybackSnapshot,
  Recordings,
  type Stints,
} from '@f1/contracts';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { http, passthrough } from 'msw';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { access } from '../src/api/access.ts';
import { createApp } from '../src/api/app.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { openRecording, type Recording } from '../src/live/recording.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';
import { AUD, jwt, rsaKey, serveCerts, TEAM } from './jwt.ts';

// The playback routes against a real PostgreSQL 18 (f1_api login), behind the real Access middleware, served by
// @hono/node-server on a real socket so a client disconnect is a real one. The recordings are synthetic, written
// through openRecording. Every stream ends: it reaches `end`, or the test aborts it (afterEach aborts the rest).

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.now();
const DONE_AT = NOW - 3 * 24 * 60 * MIN; // the finished recording's first line
const OPEN_AT = NOW - 5 * MIN;
const LINES = 4; // one every 100 ms
const M = 9100;
const [S_DONE, S_LIVE, S_NEXT, S_MISSING] = [9101, 9102, 9103, 9104];
const S_LAPS = 9001; // the session of fixtures/live/practice.jsonl
const LAPS_AT = NOW - 2 * 24 * 60 * MIN;

const lines: string[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });
/** The lines but the request lines (#108; api.int.test.ts covers those). */
const own = () => lines.filter((l) => JSON.parse(l).msg !== 'request');

let testDb: TestDb;
let admin: Kysely<DB>;
let apiDb: Kysely<DB>;
let app: Hono;
let srv: Server;
let base: string;
let token: string;
let key: Awaited<ReturnType<typeof rsaKey>>;
let liveDir: string;
const recs: Recording[] = [];
const ids = { done: '', open: '', missing: '', laps: '' };
let donePath: string;
let openPath: string;

/** `n` lines 100 ms apart from `at`, each changing the state, through the real recorder on an injected clock. */
function record(path: string, at: number, n: number): Recording {
  let clock = at;
  const rec = openRecording({ dir: join(liveDir, path), now: () => clock, snapshotMs: 3_600_000 });
  recs.push(rec);
  for (let i = 0; i < n; i++) {
    clock = at + i * 100;
    rec.feed(clock, 'TimingData', { Lines: { '1': { N: i } } }, iso(clock));
  }
  return rec;
}

/**
 * The synthetic practice.jsonl (its laps and stints), a line every 50 ms from `at`: the receive times are compressed,
 * the F1 times (the laps' clock) kept. Its full state at the start becomes its SessionInfo alone (the session's Key).
 */
async function recordPractice(path: string, at: number) {
  const rec = openRecording({ dir: join(liveDir, path), now: () => at, snapshotMs: 3_600_000 });
  const values = readFileSync(join(import.meta.dirname, 'fixtures/live/practice.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as [number, string, unknown, string?]);
  for (const [i, [, topic, payload, ts]] of values.entries()) {
    if (topic === '_subscribe')
      rec.feed(at + i * 50, 'SessionInfo', (payload as { SessionInfo: unknown }).SessionInfo, 'undefined');
    else rec.feed(at + i * 50, topic, payload, ts ?? 'undefined');
  }
  await rec.finish();
}

const headers = { 'cf-access-jwt-assertion': '', connection: 'close' };
const aborts: AbortController[] = [];
/** A request to the real server; the controller is aborted after the test at the latest. */
async function call(path: string) {
  const abort = new AbortController();
  aborts.push(abort);
  return {
    abort,
    res: await fetch(`${base}${path}`, {
      headers: { ...headers, 'cf-access-jwt-assertion': token },
      signal: abort.signal,
    }),
  };
}
const stream = (id: string, query: string) => `/api/v1/playback/${id}/stream?${query}`;
const get = (path: string) => app.request(path, { headers: { 'cf-access-jwt-assertion': token } });

/** Reads the body until `re` matches the text so far. */
async function readUntil(res: Response, re: RegExp): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!re.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

/** SSE text → events (the heartbeat is one too, `ping`). */
const events = (text: string) =>
  text
    .split('\n\n')
    .filter((block) => block)
    .map((block) => {
      const m = /^event: (\w+)\ndata: (.*)$/s.exec(block);
      expect(m, block).not.toBeNull();
      return { event: m?.[1], data: JSON.parse(m?.[2] ?? '') as unknown };
    });

const sample = async () => ({
  conns: await new Promise<number>((resolve) => srv.getConnections((_, n) => resolve(n))),
  fds: readdirSync('/proc/self/fd').length,
  timeouts: process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Until no connection is left and two samples 100 ms apart agree. */
async function quiet() {
  let last = await sample();
  for (let i = 0; i < 100; i++) {
    await pause(100);
    const next = await sample();
    if (next.conns === 0 && next.fds === last.fds && next.timeouts === last.timeouts) return next;
    last = next;
  }
  return last;
}
/** Until the sample is back at the baseline; on failure the diff shows what is still open. */
async function backTo(baseline: Awaited<ReturnType<typeof sample>>) {
  let now = await sample();
  for (let i = 0; i < 100 && !(now.conns === 0 && now.fds <= baseline.fds && now.timeouts <= baseline.timeouts); i++) {
    await pause(50);
    now = await sample();
  }
  expect(now).toEqual({ conns: 0, fds: baseline.fds, timeouts: baseline.timeouts });
}

describe('playback routes (f1_api login, Access JWT, real socket)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    liveDir = mkdtempSync(join(tmpdir(), 'f1-playback-int-'));
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    await admin
      .insertInto('meeting')
      .values({ meeting_key: M, source: 'f1-live', year: 2027, name: 'Synthetic Grand Prix' })
      .execute();
    const session = (session_key: number, name: string, from: number, to: number) => ({
      session_key,
      source: 'f1-live',
      meeting_key: M,
      name,
      date_start: new Date(from),
      date_end: new Date(to),
    });
    await admin
      .insertInto('session')
      .values([
        session(S_DONE, 'Practice 1', DONE_AT, DONE_AT + 60 * MIN),
        session(S_LIVE, 'Practice 2', OPEN_AT, NOW + 55 * MIN),
        session(S_NEXT, 'Practice 3', NOW + 24 * 60 * MIN, NOW + 25 * 60 * MIN),
        session(S_MISSING, 'Qualifying', DONE_AT, DONE_AT + 60 * MIN),
        { ...session(S_LAPS, 'Practice 1', LAPS_AT, LAPS_AT + 60 * MIN), type: 'Practice' },
      ])
      .execute();
    const row = async (session_key: number, started: number, ended: number | null) => {
      const path = `${session_key}-${started}`;
      const { id } = await admin
        .insertInto('recording')
        .values({
          session_key,
          path,
          started_at: new Date(started),
          ended_at: ended === null ? null : new Date(ended),
          complete: ended !== null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id, path };
    };
    const done = await row(S_DONE, DONE_AT, DONE_AT + MIN);
    const open = await row(S_LIVE, OPEN_AT, null);
    const missing = await row(S_MISSING, DONE_AT, DONE_AT + MIN); // no directory
    const laps = await row(S_LAPS, LAPS_AT, LAPS_AT + MIN);
    [ids.done, ids.open, ids.missing, ids.laps] = [done.id, open.id, missing.id, laps.id];
    [donePath, openPath] = [done.path, open.path];
    await recordPractice(laps.path, LAPS_AT);
    await record(donePath, DONE_AT, LINES).finish();
    record(openPath, OPEN_AT, LINES); // stays open: feed.jsonl is being tailed

    apiDb = createDb(testDb.urls.f1_api);
    app = createApp({ db: apiDb, access: access({ team: TEAM, aud: AUD }, log), log, liveDir });
    srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
    await new Promise((resolve) => srv.once('listening', resolve));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    key = await rsaKey('test-kid');
    token = await jwt(key.priv);
  });
  beforeEach(() => {
    serveCerts([key.pub]);
    server.use(http.all(`${base}/*`, () => passthrough())); // the real server, not msw
  });
  afterEach(() => {
    for (const abort of aborts.splice(0)) abort.abort();
  });
  afterAll(async () => {
    for (const abort of aborts.splice(0)) abort.abort();
    for (const rec of recs) await rec.finish();
    srv?.closeAllConnections();
    await new Promise((resolve) => srv?.close(resolve));
    await apiDb?.destroy();
    await admin?.destroy();
    await testDb?.drop();
    rmSync(liveDir, { recursive: true, force: true });
  });

  it('SSE is closed after a client disconnect (no leak)', async () => {
    const open = stream(ids.open, 'at=live');
    // One full cycle first, so the database pool and the client are at their steady state.
    const warm = await call(open);
    expect(warm.res.status).toBe(200);
    await readUntil(warm.res, /event: snapshot/);
    warm.abort.abort();
    const baseline = await quiet();
    expect(baseline.conns).toBe(0);

    const one = await call(open);
    const text = await readUntil(one.res, /event: snapshot\ndata: .*\n\n/);
    expect(events(text)[0]?.event).toBe('snapshot');
    const during = await sample();
    expect(during.conns).toBe(1); // the measurement sees an open stream: a file handle and a timer
    expect(during.fds).toBeGreaterThan(baseline.fds);
    one.abort.abort();
    await backTo(baseline);

    // The cap counter was freed: 8 streams open, then all close again.
    const eight = await Promise.all(Array.from({ length: 8 }, () => call(open)));
    for (const { res } of eight) {
      expect(res.status).toBe(200);
      await readUntil(res, /event: snapshot\ndata: .*\n\n/);
    }
    expect((await sample()).conns).toBe(8);
    for (const { abort } of eight) abort.abort();
    await backTo(baseline);
  });

  it('HEAD on the stream answers 200 with the SSE headers and no body, and takes no slot, handle or generator', async () => {
    const open = stream(ids.open, 'at=live');
    const warm = await call(open);
    await readUntil(warm.res, /event: snapshot/);
    warm.abort.abort();
    const baseline = await quiet();
    for (let i = 0; i < 10; i++) {
      // 10 > the cap of 8: a leaked slot would turn the later ones into 503s
      const res = await fetch(`${base}${open}`, {
        method: 'HEAD',
        headers: { ...headers, 'cf-access-jwt-assertion': token },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
      expect(res.headers.get('f1-revision')).toBe('dev');
      expect(await res.text()).toBe('');
    }
    await backTo(baseline);
    const eight = await Promise.all(Array.from({ length: 8 }, () => call(open)));
    for (const { res } of eight) {
      expect(res.status).toBe(200);
      await readUntil(res, /event: snapshot\ndata: .*\n\n/);
    }
    for (const { abort } of eight) abort.abort();
    await backTo(baseline);
  });

  it('a 9th concurrent stream is a 503 with the fixed body, and frees up when one closes', async () => {
    const open = stream(ids.open, 'at=live');
    const eight = await Promise.all(Array.from({ length: 8 }, () => call(open)));
    for (const { res } of eight) await readUntil(res, /event: snapshot\ndata: .*\n\n/);
    const ninth = await call(open);
    expect(ninth.res.status).toBe(503);
    expect(ninth.res.headers.get('cache-control')).toBe('no-store');
    expect(await ninth.res.text()).toBe('{"error":"unavailable"}');
    eight[0]?.abort.abort();
    let again = 503;
    for (let i = 0; i < 100 && again === 503; i++) {
      const next = await call(open);
      again = next.res.status;
      if (again === 503) await next.res.body?.cancel();
      else next.abort.abort();
      if (again === 503) await pause(50);
    }
    expect(again).toBe(200);
  });

  it('a finished recording streams snapshot, deltas in order, then end; each event parses against its contract', async () => {
    const { res } = await call(stream(ids.done, `at=${DONE_AT}&speed=4`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    const seen = events(await res.text());
    expect(seen.map((e) => e.event)).toEqual(['snapshot', ...Array(LINES - 1).fill('delta'), 'end']);
    const snapshot = PlaybackSnapshot.parse(seen[0]?.data);
    expect(snapshot).toEqual({
      t: DONE_AT,
      state: { TimingData: { Lines: { '1': { N: 0 } } } },
      laps: [],
      stints: [],
      weather: [],
    });
    const deltas = seen.slice(1, -1).map((e) => PlaybackDelta.parse(e.data));
    expect(deltas.map((d) => d.t)).toEqual([1, 2, 3].map((i) => DONE_AT + i * 100));
    expect(deltas.map((d) => d.topic)).toEqual(Array(LINES - 1).fill('TimingData'));
    expect(deltas[2]?.data).toEqual({ Lines: { '1': { N: 3 } } });
    expect(PlaybackEnd.parse(seen.at(-1)?.data).t).toBeGreaterThanOrEqual(DONE_AT + (LINES - 1) * 100);

    // Live on a finished recording: the whole state, then end.
    const later = events(await (await call(stream(ids.done, 'at=live&delay=5'))).res.text());
    expect(later.map((e) => e.event)).toEqual(['snapshot', 'end']);
    expect(PlaybackSnapshot.parse(later[0]?.data).state).toEqual({ TimingData: { Lines: { '1': { N: LINES - 1 } } } });
  });

  it('lap rows: the snapshot carries all of them, `event: laps` the changes; every event parses against its contract', async () => {
    const seen = events(await (await call(stream(ids.laps, `at=${LAPS_AT}&speed=16`))).res.text());
    expect(new Set(seen.map((e) => e.event))).toEqual(new Set(['snapshot', 'delta', 'laps', 'end']));
    expect(seen[0]?.event).toBe('snapshot');
    expect(seen.at(-1)?.event).toBe('end');
    const laps = new Map<string, Lap>();
    const stints = new Map<string, Stints[number]>();
    for (const { event, data } of seen) {
      if (event === 'delta') PlaybackDelta.parse(data);
      else if (event === 'end') PlaybackEnd.parse(data);
      else if (event === 'ping') PlaybackPing.parse(data);
      else {
        const rows = event === 'snapshot' ? PlaybackSnapshot.parse(data) : PlaybackLaps.parse(data);
        for (const l of rows.laps) laps.set(`${l.driver_number}/${l.lap_number}`, l);
        for (const s of rows.stints) stints.set(`${s.driver_number}/${s.stint_number}`, s);
      }
    }

    // The same rows as a seek to the end.
    const later = events(await (await call(stream(ids.laps, 'at=live'))).res.text());
    expect(later.map((e) => e.event)).toEqual(['snapshot', 'end']);
    const all = PlaybackSnapshot.parse(later[0]?.data);
    expect(all.laps.length).toBeGreaterThan(0);
    expect(all.stints.length).toBeGreaterThan(0);
    const byLap = (a: Lap, b: Lap) => a.driver_number - b.driver_number || a.lap_number - b.lap_number;
    const byStint = (a: Stints[number], b: Stints[number]) =>
      a.driver_number - b.driver_number || a.stint_number - b.stint_number;
    expect([...laps.values()].sort(byLap)).toEqual(all.laps);
    expect([...stints.values()].sort(byStint)).toEqual(all.stints);
  });

  it('one open log line per stream: the mode, scan ms, lines and snapshot bytes, and nothing else (#101)', async () => {
    const cases = [
      { query: 'at=live&delay=5', mode: 'live', applied: LINES }, // a finished recording: every line
      { query: `at=${DONE_AT + 100}&speed=4`, mode: 'replay', applied: 2 },
      { query: `at=${DONE_AT + 200}&still=1`, mode: 'still', applied: 3 },
    ];
    for (const { query, mode, applied } of cases) {
      lines.length = 0;
      const { res } = await call(stream(ids.done, query));
      expect(res.status, query).toBe(200);
      // To the `end`: a line per event (or a second one for any later event) would show in the count.
      const text = await res.text();
      const seen = events(text);
      expect(seen.length, query).toBeGreaterThan(1);
      expect(seen.at(-1)?.event, query).toBe('end');
      const data = /^event: snapshot\ndata: (.*)$/m.exec(text)?.[1] ?? '';
      // The stream's request line (#108) times its headers only, and comes once.
      expect(
        lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request'),
        query,
      ).toEqual([expect.objectContaining({ method: 'GET', route: '/api/v1/playback/:recording/stream', status: 200 })]);
      expect(own(), query).toHaveLength(1);
      const raw = own()[0] ?? '';
      const line = JSON.parse(raw) as Record<string, unknown>;
      // pino's own three, then the four fixed fields: no URL, id, path, time on the feed's axis or feed text.
      expect(Object.keys(line).sort(), query).toEqual(
        ['level', 'lines', 'mode', 'msg', 'scan_ms', 'snapshot_bytes', 'time'].sort(),
      );
      expect(line, query).toMatchObject({ level: 30, msg: 'playback open', mode, lines: applied });
      expect(Number.isSafeInteger(line.scan_ms) && (line.scan_ms as number) >= 0, query).toBe(true);
      expect(line.snapshot_bytes, query).toBe(Buffer.byteLength(data));
      for (const secret of [donePath, String(DONE_AT), 'TimingData', 'Lines', query]) expect(raw).not.toContain(secret);
    }
    // A HEAD opens nothing, so it logs nothing.
    lines.length = 0;
    const head = await fetch(`${base}${stream(ids.done, 'at=live')}`, {
      method: 'HEAD',
      headers: { ...headers, 'cf-access-jwt-assertion': token },
    });
    expect(head.status).toBe(200);
    await pause(200); // a seek would have logged by now: it takes a few ms on this recording
    expect(own()).toEqual([]);
  });

  it('/recordings: every recording with its session and meeting, newest first, no-store', async () => {
    const res = await get('/api/v1/recordings');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = Recordings.parse(await res.json());
    // started_at descending, then id descending (done and missing started together).
    expect(body.map((r) => r.id)).toEqual([ids.open, ids.laps, ids.missing, ids.done].map(Number));
    expect(body[0]).toEqual({
      id: Number(ids.open),
      session_key: S_LIVE,
      year: 2027,
      meeting_name: 'Synthetic Grand Prix',
      session_name: 'Practice 2',
      session_type: null,
      date_start: iso(OPEN_AT),
      started_at: iso(OPEN_AT),
      ended_at: null,
      complete: false,
    });
    expect(body[1]).toMatchObject({ session_key: S_LAPS, session_type: 'Practice', ended_at: iso(LAPS_AT + MIN) });
  });

  it('400 for every bound, 404 for an unknown recording or a missing directory; bodies never echo input', async () => {
    const bad = [
      `abc/stream?at=live`,
      `1234567890/stream?at=live`,
      `${ids.done}/stream`,
      `${ids.done}/stream?at=`,
      `${ids.done}/stream?at=abc`,
      `${ids.done}/stream?at=-1`,
      `${ids.done}/stream?at=1.5`,
      `${ids.done}/stream?at=${'1'.repeat(16)}`,
      `${ids.done}/stream?at=live&at=live`,
      `${ids.done}/stream?at=${DONE_AT}&delay=5`, // delay is live only
      `${ids.done}/stream?at=live&delay=121`,
      `${ids.done}/stream?at=live&delay=-1`,
      `${ids.done}/stream?at=live&delay=1.5`,
      `${ids.done}/stream?at=live&delay=abc`,
      `${ids.done}/stream?at=live&delay=`,
      `${ids.done}/stream?at=live&delay=1&delay=2`,
      `${ids.done}/stream?at=${DONE_AT}&speed=3`,
      `${ids.done}/stream?at=${DONE_AT}&speed=0`,
      `${ids.done}/stream?at=${DONE_AT}&speed=32`,
      `${ids.done}/stream?at=${DONE_AT}&speed=abc`,
      `${ids.done}/stream?at=live&speed=2`, // live is speed 1
      `${ids.done}/stream?at=${DONE_AT - 1}`, // before started_at
      `${ids.done}/stream?at=${DONE_AT + MIN + 1}`, // after ended_at
      `${ids.open}/stream?at=${NOW + 10 * MIN}`, // after now
      `${ids.done}/stream?at=${DONE_AT}&still=0`, // a still frame is still=1 or nothing (#101)
      `${ids.done}/stream?at=${DONE_AT}&still=true`,
      `${ids.done}/stream?at=${DONE_AT}&still=`,
      `${ids.done}/stream?at=${DONE_AT}&still=1&still=1`,
      `${ids.done}/stream?at=live&still=1`, // a still frame is a replay at T
    ];
    lines.length = 0;
    for (const path of bad) {
      const res = await get(`/api/v1/playback/${path}`);
      expect(res.status, path).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text(), path).toBe('{"error":"bad request"}');
    }
    expect(own()).toEqual([]); // a 400 logs nothing but its request line, and opens nothing to log
    for (const path of [`999999/stream?at=live`, `${ids.missing}/stream?at=live`]) {
      const res = await get(`/api/v1/playback/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('{"error":"not found"}');
    }
    expect(own().map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ cause: 'ENOENT', msg: 'playback' })]);
  });

  it('every route here is a 401 without a token', async () => {
    for (const path of ['/api/v1/live', '/api/v1/recordings', stream(ids.open, 'at=live')]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(await res.text()).toBe('{"error":"unauthorized"}');
    }
  });

  it('/live: the open recording and its session; else the next session with its latest recording, or null', async () => {
    const live = async () => {
      const res = await get('/api/v1/live');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      return Live.parse(await res.json());
    };
    const sessionOf = (key: number, name: string, from: number, to: number) => ({
      session_key: key,
      meeting_name: 'Synthetic Grand Prix',
      session_name: name,
      date_start: iso(from),
      date_end: iso(to),
    });
    const cancel = (keys: number[], is_cancelled: boolean) =>
      admin.updateTable('session').set({ is_cancelled }).where('session_key', 'in', keys).execute();
    const live2 = sessionOf(S_LIVE, 'Practice 2', OPEN_AT, NOW + 55 * MIN);

    expect(await live()).toEqual({
      session: live2,
      recording: { id: Number(ids.open), started_at: iso(OPEN_AT), ended_at: null, complete: false },
    });

    // Nothing open: the next session (the live one, not yet 30 min past its end), with its latest recording.
    await admin
      .updateTable('recording')
      .set({ ended_at: new Date(NOW), complete: true })
      .where('id', '=', ids.open)
      .execute();
    try {
      expect(await live()).toEqual({
        session: live2,
        recording: { id: Number(ids.open), started_at: iso(OPEN_AT), ended_at: iso(NOW), complete: true },
      });
      // Cancelled: the one after it, which has no recording.
      await cancel([S_LIVE], true);
      expect(await live()).toEqual({
        session: sessionOf(S_NEXT, 'Practice 3', NOW + 24 * 60 * MIN, NOW + 25 * 60 * MIN),
        recording: null,
      });
      await cancel([S_NEXT], true);
      expect(await live()).toEqual({ session: null, recording: null });
    } finally {
      await cancel([S_LIVE, S_NEXT], false);
      await admin
        .updateTable('recording')
        .set({ ended_at: null, complete: false })
        .where('id', '=', ids.open)
        .execute();
    }
  });
});
