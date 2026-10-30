import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { type Kysely, sql } from 'kysely';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { connect } from '../src/live/feed-client.ts';
import { LoginError } from '../src/live/login.ts';
import { type RecorderDeps, startRecorder } from '../src/live/recorder.ts';
import { writeToken } from '../src/live/token.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';
import {
  type FakeSignalR,
  numbered,
  refuseNonLoopback,
  replay,
  segments,
  seqCounts,
  startFakeSignalR,
} from './fake-signalr.ts';

// The recorder against a real PostgreSQL 18, logged in as f1_ingest, and the fake SignalR server over real sockets.
// msw would intercept those, so it is closed for this file (feed-recorder.test.ts says why it listens again in
// afterAll) and refuseNonLoopback takes its place. Time comes from `clock`; the ticks are short and real. Every stream
// is finite.
let allowNetwork: () => void;
beforeAll(() => {
  server.close();
  allowNetwork = refuseNonLoopback();
});
afterAll(() => {
  allowNetwork();
  server.listen({ onUnhandledFrame: 'error' });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-08T12:00:00Z');
const KEY = 9001;
const END = T0 + HOUR;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'none' })}.${b64(claims)}.c2ln`;
/** A synthetic token that expires at `expMs`; `name` keeps tokens with the same expiry apart. */
const tokenUntil = (expMs: number, name = 'sentinel') => jwt({ exp: Math.floor(expMs / 1000), name });
const GOOD_UNTIL = T0 + 96 * HOUR;
const STREAM_TS = '2026-11-08T12:00:00.000Z';

async function until(what: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(2);
  }
}

let testDb: TestDb;
let admin: Kysely<DB>;
let db: Kysely<DB>;
let fake: FakeSignalR;
let root: string;
let liveDir: string;
let tokenPath: string;
let secretsDir: string;
let clock: number;
let lines: string[];
let pings: string[];
/** Feed messages that reached the recorder. */
let fed: number;
let running: { stop: () => Promise<void> }[];
const tickMs = 5;

const seed = async (key: number, start = T0, end = END, cancelled = false) => {
  await admin
    .insertInto('meeting')
    .values({ meeting_key: 1, source: 'openf1', year: 2026 })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await admin
    .insertInto('session')
    .values({
      session_key: key,
      source: 'openf1',
      meeting_key: 1,
      date_start: new Date(start),
      date_end: new Date(end),
      is_cancelled: cancelled,
    })
    .execute();
};
const rows = () => db.selectFrom('recording').selectAll().orderBy('id').execute();
const status = () => db.selectFrom('recorder_status').selectAll().executeTakeFirst();
const logged = (text: string) => lines.some((l) => l.includes(text));
const secrets = () => {
  writeFileSync(join(secretsDir, 'f1tv_username'), 'sentinel-user@example.com\n');
  writeFileSync(join(secretsDir, 'f1tv_password'), 'sentinel-password\n');
};
const carried = (step: 'negotiate' | 'upgrade') => fake.seen.filter((s) => s.step === step).map((s) => s.authorization);

function start(overrides: Partial<RecorderDeps> = {}) {
  const stop = new AbortController();
  const { statfs = () => 1e12, connect: open = connect } = overrides;
  let statfsCalls = 0;
  const done = startRecorder({
    db,
    now: () => new Date(clock),
    log: pino({ base: null }, { write: (line: string) => void lines.push(line) }),
    beat: () => {},
    ping: async (slug) => void pings.push(slug),
    signal: stop.signal,
    liveDir,
    tokenPath,
    secretsDir,
    tickMs,
    feedOptions: { base: fake.base },
    backoffMs: 5,
    maxBackoffMs: 20,
    ...overrides,
    statfs: (path) => {
      statfsCalls++;
      return statfs(path);
    },
    connect: (token, onFeed, options) =>
      open(
        token,
        (...message) => {
          fed++;
          onFeed(...message);
        },
        options,
      ),
  });
  const handle = {
    done,
    /** Lets at least `n` whole ticks run. A tick calls statfs exactly once, ahead of its decision. */
    ticks: async (n = 2) => {
      const target = statfsCalls + n + 2;
      await until(() => statfsCalls >= target);
    },
    stop: async () => {
      stop.abort();
      await done;
    },
  };
  running.push(handle);
  return handle;
}
const recording = () => until(async () => (await status())?.state === 'recording');
/** Sends a SessionStatus on the open socket and returns once whole ticks have seen it. */
const sendStatus = async (h: { ticks: () => Promise<void> }, s: string) => {
  const target = fed + 1;
  fake.feed([['SessionStatus', { Status: s }, STREAM_TS]]);
  await until(() => fed >= target);
  await h.ticks();
};
const lastRow = async () => (await rows()).at(-1);
const endedRow = async () => {
  await until(async () => (await lastRow())?.ended_at != null);
  return await lastRow();
};

describe('recorder (real PostgreSQL as f1_ingest, fake SignalR)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    db = createDb(testDb.urls.f1_ingest);
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });
  beforeEach(async () => {
    await admin.deleteFrom('recorder_status').execute();
    await admin.deleteFrom('recording').execute();
    await admin.deleteFrom('session').execute();
    fake = await startFakeSignalR();
    root = mkdtempSync(join(tmpdir(), 'f1-recorder-'));
    liveDir = join(root, 'live');
    secretsDir = join(root, 'secrets');
    mkdirSync(secretsDir);
    tokenPath = join(root, 'f1tv-token');
    clock = T0 - HOUR;
    lines = [];
    pings = [];
    fed = 0;
    running = [];
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(running.map((r) => r.stop()));
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  describe('the [CI] criteria', () => {
    it('a token expiring within the session window: logs in first, writes the file, connects with the new token', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(END, 'old')); // does not reach end + 1 h
      secrets();
      const fresh = tokenUntil(GOOD_UNTIL, 'new');
      const order: string[] = [];
      const h = start({
        login: async (c) => {
          expect(c).toEqual({ username: 'sentinel-user@example.com', password: 'sentinel-password' });
          order.push('login');
          return { value: fresh, expiresAt: GOOD_UNTIL };
        },
        connect: (token, onFeed, options) => {
          order.push(`connect, file ${readFileSync(tokenPath, 'utf8') === `${fresh}\n` ? 'new' : 'old'}`);
          expect(token).toBe(fresh);
          return connect(token, onFeed, options);
        },
      });
      await recording();
      expect(order).toEqual(['login', 'connect, file new']);
      expect(carried('negotiate')).toEqual([`Bearer ${fresh}`]);
      expect(carried('upgrade')).toEqual([`Bearer ${fresh}`]);
      await h.ticks();
      expect(order).toHaveLength(2);
      const s = await status();
      expect(s).toMatchObject({ login_failures: 0, last_error: null, warning: null });
      expect(s?.token_expires_at).toEqual(new Date(GOOD_UNTIL));
      expect(s?.last_login_at).toEqual(new Date(T0 - HOUR));
    });

    it('a login failure: status error, no crash loop, the limits hold across a restart, recorded anonymously', async () => {
      await seed(KEY, T0, T0 + 8 * HOUR);
      secrets();
      let attempts = 0;
      const login = async () => {
        attempts++;
        throw new LoginError('login_signin', 401);
      };
      const first = start({ login });
      await recording();
      await until(async () => (await status())?.last_error === 'login_signin');
      expect(await status()).toMatchObject({ warning: 'login_failed', login_failures: 1, state: 'recording' });
      await first.ticks(10);
      expect(attempts).toBe(1);

      clock += 10 * MIN - 1;
      await first.ticks();
      expect(attempts).toBe(1);
      clock += 1;
      await until(() => attempts === 2);
      await first.ticks();
      expect(attempts).toBe(2);
      expect((await status())?.login_failures).toBe(2);

      // A new process on the same database: no attempt until the limit allows one.
      await first.stop();
      expect(await lastRow()).toMatchObject({ complete: false });
      const second = start({ login });
      await second.ticks(10);
      expect(attempts).toBe(2);
      expect(await status()).toMatchObject({ last_error: 'login_signin', warning: 'login_failed', login_failures: 2 });

      clock += 10 * MIN;
      await until(() => attempts === 3);
      expect(attempts).toBe(3);
      await until(async () => (await status())?.login_failures === 3);

      // Three in a row: one per 6 h, across another restart.
      await second.stop();
      const third = start({ login });
      clock += 10 * MIN;
      await third.ticks(10);
      expect(attempts).toBe(3);
      clock += 6 * HOUR - 10 * MIN;
      await until(() => attempts === 4);

      // The session was still recorded, anonymously, and that is no complete recording.
      await recording();
      await sendStatus(third, 'Started');
      clock = T0 + 11 * HOUR;
      const row = await endedRow();
      expect(row?.complete).toBe(false);
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live/fail']);
      expect(new Set(carried('upgrade'))).toEqual(new Set([undefined]));
      expect(fake.subscribes.length).toBeGreaterThanOrEqual(3);
    });

    it('no log line or recording file holds a token, password or server text: the real login() and a feed 401 and socket error', async () => {
      const USER = 'sentinel-user@example.com';
      const PASSWORD = 'sentinel-password';
      const TOKEN_1 = tokenUntil(GOOD_UNTIL, 'first');
      const TOKEN_2 = tokenUntil(GOOD_UNTIL, 'second');
      const ACCESS = 'sentinel-access-token';
      const CODE = 'sentinel-code';
      const CLOSE_TEXT = 'sentinel close text';
      let flow: { fail: boolean; token: string } = { fail: true, token: TOKEN_1 };
      let state = '';
      const passwordsSent: string[] = [];
      // The real login.ts against answers in place of F1's hosts. msw stays closed for the fake server's sockets, and
      // anything but these hosts and that server is refused: no test reaches the network.
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === '127.0.0.1') return real(input, init);
        if (url.pathname === '/scripts/main.min.js' && url.hostname === 'account.formula1.com') {
          return new Response('x={davinci:{clientId:"cid",acrValues:"acr"}}');
        }
        if (url.hostname !== 'id.formula1.com') throw new Error(`refused ${url.hostname}`);
        if (url.pathname === '/as/authorize') {
          state = url.searchParams.get('state') ?? '';
          return Response.json({
            _links: { next: { href: 'https://id.formula1.com/next' } },
            interactionId: 'iid',
            id: 'form',
            eventName: 'continue',
          });
        }
        if (url.pathname === '/next') {
          passwordsSent.push(String(init?.body));
          if (flow.fail) return Response.json({ status: 'FAILED', message: `Hello ${USER}, wrong ${PASSWORD}` });
          return Response.json({ status: 'COMPLETED', authorizeResponse: { state, code: CODE } });
        }
        if (url.pathname === '/as/token') {
          return Response.json({ access_token: jwt({ subscriptionToken: flow.token, marker: ACCESS }) });
        }
        throw new Error('refused path');
      });

      await seed(KEY);
      secrets();
      const h = start();

      // A real login failure: anonymous.
      await until(() => logged('login_signin'));
      await recording();
      expect(await status()).toMatchObject({ last_error: 'login_signin', warning: 'login_failed' });
      expect(carried('negotiate')).toEqual([undefined]);

      // A real login success: the connection moves to the token.
      flow = { fail: false, token: TOKEN_1 };
      clock += 10 * MIN;
      await until(() => carried('upgrade').includes(`Bearer ${TOKEN_1}`));
      await until(async () => (await status())?.last_error === null && (await status())?.state === 'recording');
      await until(async () => (await status())?.login_failures === 0); // a connection with the token has subscribed
      expect(readFileSync(tokenPath, 'utf8')).toBe(`${TOKEN_1}\n`);
      expect(logged('"expires_at"')).toBe(true);
      fake.behaviour.fullState = { SessionInfo: { Name: 'Practice' } };
      fake.feed([['WeatherData', { AirTemp: '20' }, STREAM_TS]]);

      // A socket error, then a feed 401 on the token: anonymous next, and the file's value counts as no token.
      fake.behaviour.negotiateStatus = 401;
      const before = fake.seen.length;
      fake.drop();
      await until(() => logged('"last_error":"feed_socket"'));
      await until(() => logged('"last_error":"feed_unauthorized"'));
      expect(fake.seen[before + 1]).toMatchObject({ step: 'negotiate', authorization: `Bearer ${TOKEN_1}` });
      delete fake.behaviour.negotiateStatus;
      await recording();
      await until(async () => (await status())?.last_error === 'feed_unauthorized');
      expect(carried('upgrade').at(-1)).toBeUndefined();
      expect(await status()).toMatchObject({ token_expires_at: null, login_failures: 1, warning: 'login_failed' });

      // The tick's own path renews it.
      flow = { fail: false, token: TOKEN_2 };
      clock += 10 * MIN;
      await until(() => carried('upgrade').includes(`Bearer ${TOKEN_2}`));
      await until(async () => (await status())?.last_error === null && (await status())?.state === 'recording');

      // A server close message with text.
      fake.record({ type: 7, error: `${CLOSE_TEXT} ${TOKEN_2}`, allowReconnect: true });
      await until(() => fake.subscribes.length >= 5);
      await h.stop();

      expect(passwordsSent.some((b) => b.includes(PASSWORD))).toBe(true); // the sentinels did travel through the code
      const forbidden = [
        USER,
        PASSWORD,
        TOKEN_1,
        TOKEN_2,
        ACCESS,
        CODE,
        CLOSE_TEXT,
        'fake-alb',
        fake.connectionToken,
        'secret.example', // the fake's negotiate error body
        'http',
        'formula1',
      ];
      expect(lines.length).toBeGreaterThan(5);
      for (const line of lines) for (const secret of forbidden) expect(line).not.toContain(secret);

      const files = readdirSync(liveDir, { recursive: true, encoding: 'utf8', withFileTypes: false })
        .map((name) => join(liveDir, name))
        .filter((path) => /\.(gz|jsonl|json|tmp)$/.test(path));
      expect(files.length).toBeGreaterThan(0);
      for (const path of files) {
        const buf = readFileSync(path);
        const text = path.endsWith('.gz') ? gunzipSync(buf).toString() : buf.toString();
        for (const secret of forbidden.filter((s) => s !== 'http' && s !== 'formula1')) {
          expect(text).not.toContain(secret);
        }
      }
    });
  });

  describe('session selection', () => {
    it('skips cancelled and completed sessions and takes the earliest', async () => {
      await seed(1, T0 - 5 * HOUR, T0 - 4 * HOUR); // over
      await seed(2, T0 - 30 * MIN, T0 + 30 * MIN, true); // cancelled
      await seed(3, T0 - 20 * MIN, T0 + 40 * MIN); // complete already
      await db
        .insertInto('recording')
        .values({
          session_key: 3,
          path: '3-1',
          started_at: new Date(clock),
          ended_at: new Date(clock),
          complete: true,
        })
        .execute();
      await seed(5, T0 - 5 * MIN, T0 + 55 * MIN);
      await seed(4, T0 - 10 * MIN, T0 + 50 * MIN); // the earliest left, though the key is smaller by accident
      start();
      await recording();
      expect((await status())?.session_key).toBe(4);
      expect(await lastRow()).toMatchObject({ session_key: 4, ended_at: null, complete: false });
      expect((await rows()).filter((r) => r.path !== '3-1')).toHaveLength(1);
    });

    it('stays idle until 60 min before the start, then connects', async () => {
      await seed(KEY);
      clock = T0 - HOUR - 1;
      const h = start();
      await h.ticks();
      expect(fake.connections()).toBe(0);
      expect(await status()).toMatchObject({ state: 'idle', session_key: null });
      expect(await rows()).toEqual([]);
      clock = T0 - HOUR;
      await recording();
      expect(fake.connections()).toBe(1);
      expect(await status()).toMatchObject({ session_key: KEY });
      expect((await lastRow())?.path).toBe(`${KEY}-${clock}`);
      expect(existsSync(join(liveDir, `${KEY}-${clock}`, 'feed.jsonl'))).toBe(true);
    });
  });

  describe('a recording', () => {
    it('a full run: complete, bytes > 0, one f1-live ping, gzipped, nothing left behind', async () => {
      // By identity: a count of active timers also holds the pools' idle timers, which come and go.
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const cleared = vi.spyOn(globalThis, 'clearInterval');
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Inactive' } };
      const h = start();
      await recording();
      expect(await status()).toMatchObject({ session_key: KEY, last_error: null, warning: null });
      clock = T0;
      await sendStatus(h, 'Started');
      expect(pings).toEqual([]);

      // Past the window end, between what could be two qualifying segments: once started, only Ends stops it.
      await sendStatus(h, 'Finished');
      clock = END + 30 * MIN;
      await h.ticks();
      expect((await status())?.state).toBe('recording');
      await sendStatus(h, 'Inactive');
      await sendStatus(h, 'Ends');
      expect((await status())?.state).toBe('recording');
      clock += 30 * MIN;
      const row = await endedRow();
      expect(row).toMatchObject({ session_key: KEY, complete: true, source: 'f1-live' });
      expect(Number(row?.bytes)).toBeGreaterThan(0);
      expect(row?.ended_at).toEqual(new Date(clock));
      expect(row?.started_at).toEqual(new Date(T0 - HOUR));
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live']);
      await until(async () => (await status())?.state === 'idle');
      expect((await status())?.session_key).toBeNull();

      const names = readdirSync(join(liveDir, row?.path ?? ''));
      expect(names.filter((n) => n.endsWith('.jsonl'))).toEqual([]);
      expect(names.filter((n) => /^feed-\d+\.jsonl\.gz$/.test(n)).length).toBeGreaterThan(0);

      await h.ticks(10);
      expect(await rows()).toHaveLength(1); // complete: not selected again
      expect(pings).toEqual(['f1-live']);
      expect(fake.connections()).toBe(1);

      await h.stop();
      const created = intervals.mock.results.map((r) => r.value as unknown);
      const stopped = new Set(cleared.mock.calls.map(([timer]) => timer as unknown));
      expect(created.length).toBeGreaterThanOrEqual(3); // the recording's, the socket's ping, the finish's beat
      expect(created.filter((timer) => !stopped.has(timer))).toEqual([]);
      intervals.mockRestore();
      cleared.mockRestore();
    });

    it('an anonymous run ends incomplete, with a fail ping', async () => {
      await seed(KEY);
      fake.behaviour.fullState = { SessionStatus: { Status: 'Started' } };
      await start().ticks();
      await recording();
      expect(await status()).toMatchObject({ last_error: 'no_credentials', warning: 'token_expiring' });
      clock = END + 3 * HOUR;
      expect(await endedRow()).toMatchObject({ complete: false });
      await until(async () => (await status())?.state === 'idle');
      expect(pings).toEqual(['f1-live/fail']);
    });

    it('a session that never starts (only a Heartbeat) ends incomplete, with a fail ping, though the token held', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Inactive' } };
      start();
      await recording();
      fake.feed([['Heartbeat', { Utc: STREAM_TS }, STREAM_TS]]);
      await until(() => fed === 1);
      clock = END + 30 * MIN;
      expect(await endedRow()).toMatchObject({ complete: false });
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live/fail']);
    });

    it('a 61 s gap inside the window ends incomplete, with a fail ping', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Started' } };
      const h = start();
      await recording();
      clock = T0 + 10 * MIN;
      fake.behaviour.negotiateStatus = 503;
      fake.drop();
      await until(() => logged('"last_error":"feed_negotiate"'));
      await until(async () => (await status())?.last_error === 'feed_negotiate');
      expect((await status())?.state).toBe('connecting');
      clock += 61_000;
      delete fake.behaviour.negotiateStatus;
      await recording();
      expect((await status())?.last_error).toBeNull();
      await h.ticks();
      clock = END + 3 * HOUR;
      expect(await endedRow()).toMatchObject({ complete: false });
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live/fail']);
    });

    it('a drop through the real loop: every number sent is on disk and the replay state is right', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      const started = { SessionStatus: { Status: 'Started' } };
      fake.behaviour.fullState = { ...started, TimingData: { Seq: 0 } };
      const h = start();
      await recording();
      const sent = new Map<number, number>();
      let total = 0;
      const send = (ns: number[]) => {
        fake.feed(ns.map((n) => numbered(n)));
        total += ns.length;
        for (const n of ns) sent.set(n, (sent.get(n) ?? 0) + 1);
      };

      send([1, 2, 3]);
      await until(() => fed === total);
      await sleep(5); // the next segment's first receivedAt, its name, differs from this one's
      clock = T0; // the segment is an hour old: the next line opens a new one
      fake.behaviour.fullState = { ...started, TimingData: { Seq: 5 }, WeatherData: { Rain: 0 } };
      send([4, 5]);
      fake.drop(); // both lines still in flight when the socket ends

      await until(() => fake.subscribes.length === 2);
      expect(fed).toBe(total);
      send([4, 5]); // the server replays its last messages with the same timestamps, then goes on
      send([6, 7, 8]);
      send([7]); // a late duplicate after a newer message: applied twice, Seq would go back to 7
      await until(() => fed === total);

      await sendStatus(h, 'Ends');
      clock += 30 * MIN;
      const row = await endedRow();
      expect(row).toMatchObject({ complete: true });
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live']);

      const dir = join(liveDir, row?.path ?? '');
      expect(readdirSync(dir).filter((n) => n.endsWith('.jsonl'))).toEqual([]);
      expect(readdirSync(dir).filter((n) => n.endsWith('.gz'))).toHaveLength(2);
      const onDisk = segments(dir);
      expect(seqCounts(onDisk)).toEqual([...sent].sort(([a], [b]) => a - b));
      expect(onDisk.filter((l) => JSON.parse(l)[1] === '_subscribe')).toHaveLength(2);
      expect(Number(row?.bytes)).toBe(Buffer.byteLength(onDisk.map((l) => `${l}\n`).join('')));
      expect(replay(onDisk)).toEqual({
        SessionStatus: { Status: 'Ends' },
        TimingData: { Seq: 8, Lines: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8 } },
        WeatherData: { Rain: 0 },
      });
    });

    it('a stale Ends in the first full state stops nothing; an Ends after a Started stops 30 min on', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Ends' } };
      const h = start();
      await recording();
      await h.ticks();
      clock += 31 * MIN;
      await h.ticks();
      expect((await status())?.state).toBe('recording');

      clock = T0;
      await sendStatus(h, 'Started');
      clock = T0 + 10 * MIN;
      await sendStatus(h, 'Ends');
      clock += 30 * MIN - 1;
      await h.ticks();
      expect((await status())?.state).toBe('recording');
      clock += 1;
      expect(await endedRow()).toMatchObject({ complete: true });
    });

    it('an early Ends does not start the same session again, even when incomplete', async () => {
      await seed(KEY);
      fake.behaviour.fullState = { SessionStatus: { Status: 'Started' } };
      const h = start(); // no token, so complete stays false and only `finished` can hold it back
      await recording();
      await h.ticks();
      clock = T0 + 10 * MIN;
      await sendStatus(h, 'Ends');
      clock += 30 * MIN;
      expect(await endedRow()).toMatchObject({ complete: false });
      expect(clock).toBeLessThan(END + 30 * MIN);
      await h.ticks(10);
      expect(await rows()).toHaveLength(1);
      expect(fake.connections()).toBe(1);
      expect((await status())?.state).toBe('idle');
    });

    it('a red flag past the planned end keeps recording, until the hard stop', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Started' } };
      const h = start();
      await recording();
      clock = END + 2 * HOUR;
      await h.ticks();
      expect((await status())?.state).toBe('recording');
      clock = END + 3 * HOUR;
      expect(await endedRow()).toMatchObject({ complete: true });
    });

    it('a cancelled session ends the recording incomplete', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      const h = start();
      await recording();
      await db.updateTable('session').set({ is_cancelled: true }).where('session_key', '=', KEY).execute();
      expect(await endedRow()).toMatchObject({ complete: false });
      await h.ticks(10);
      expect(await rows()).toHaveLength(1);
      expect(pings).toEqual([]);
    });

    it('a moved session ends the recording incomplete and is recorded at its new time', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      const h = start();
      await recording();
      await db
        .updateTable('session')
        .set({ date_start: new Date(T0 + 24 * HOUR), date_end: new Date(END + 24 * HOUR) })
        .where('session_key', '=', KEY)
        .execute();
      expect(await endedRow()).toMatchObject({ complete: false });
      await h.ticks(10);
      expect(await rows()).toHaveLength(1);
      expect(pings).toEqual([]);
      clock = T0 + 23 * HOUR;
      await until(async () => (await rows()).length === 2);
      await recording();
    });

    it('overlapping sessions run one after the other', async () => {
      await seed(1, T0, END);
      await seed(2, T0 + 30 * MIN, END + 30 * MIN);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionStatus: { Status: 'Started' } };
      const h = start();
      await recording();
      clock = T0 + 30 * MIN; // session 2 is due as well
      await h.ticks(10);
      expect((await rows()).map((r) => r.session_key)).toEqual([1]);
      await sendStatus(h, 'Ends');
      clock = END + 30 * MIN;
      await until(async () => (await rows()).length === 2);
      const [a, b] = await rows();
      expect(a).toMatchObject({ session_key: 1, complete: true });
      expect(b).toMatchObject({ session_key: 2, ended_at: null, started_at: a?.ended_at });
      clock = END + 30 * MIN + 3 * HOUR;
      // Started 60 min late: this one has a gap, so its ping is a fail.
      expect((await endedRow())?.complete).toBe(false);
      await until(() => pings.length === 2);
      expect(pings).toEqual(['f1-live', 'f1-live/fail']);
    });

    it('a mid-session restart closes the open row, gzips its leftover and starts a new row', async () => {
      await seed(KEY);
      const oldPath = `${KEY}-${T0 - 2 * MIN}`;
      mkdirSync(join(liveDir, oldPath, 'snapshots'), { recursive: true });
      writeFileSync(join(liveDir, oldPath, 'feed.jsonl'), `[${T0 - 2 * MIN},"Heartbeat",{},"x"]\n`);
      await db
        .insertInto('recording')
        .values({ session_key: KEY, path: oldPath, started_at: new Date(T0 - 2 * MIN), bytes: 10 })
        .execute();
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      clock = T0 + 5 * MIN;
      const h = start();
      await recording();
      const [old, fresh] = await rows();
      expect(old).toMatchObject({ path: oldPath, complete: false, ended_at: new Date(clock) });
      expect(Number(old?.bytes)).toBe(10);
      expect(fresh).toMatchObject({ path: `${KEY}-${clock}`, ended_at: null });
      expect(readdirSync(join(liveDir, oldPath)).sort()).toEqual([`feed-${T0 - 2 * MIN}.jsonl.gz`, 'snapshots']);
      await h.stop();
      // The first minutes were lost: not complete, even though this row reached no gap of its own.
      expect((await lastRow())?.complete).toBe(false);
    });

    it('SIGTERM closes the socket, gzips and ends the row incomplete, and resolves', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      fake.behaviour.fullState = { SessionInfo: { Name: 'Practice' } };
      const h = start();
      await recording();
      clock = T0 + 5 * MIN;
      await h.ticks();
      await h.stop();
      const row = await lastRow();
      expect(row).toMatchObject({ complete: false, ended_at: new Date(clock) });
      expect(Number(row?.bytes)).toBeGreaterThan(0);
      expect(readdirSync(join(liveDir, row?.path ?? '')).filter((n) => n.endsWith('.jsonl'))).toEqual([]);
      expect(await status()).toMatchObject({ state: 'idle' });
      expect(pings).toEqual([]);
    });
  });

  describe('the token', () => {
    it('picks a paste up on the next tick and moves the anonymous connection to it', async () => {
      await seed(KEY);
      const h = start();
      await recording();
      expect((await status())?.last_error).toBe('no_credentials');
      const pasted = tokenUntil(GOOD_UNTIL, 'pasted');
      writeToken(tokenPath, pasted);
      await until(() => carried('upgrade').includes(`Bearer ${pasted}`));
      await until(async () => (await status())?.state === 'recording' && (await status())?.last_error === null);
      expect((await status())?.warning).toBeNull();
      await h.ticks();
      expect(fake.connections()).toBe(2);
    });

    it('a refused value stays no token until the file holds another, which needs no login', async () => {
      await seed(KEY);
      const refused = tokenUntil(GOOD_UNTIL, 'refused');
      writeToken(tokenPath, refused);
      fake.behaviour.negotiateStatus = 401;
      const h = start();
      await until(() => logged('"last_error":"feed_unauthorized"'));
      delete fake.behaviour.negotiateStatus;
      await recording();
      await h.ticks();
      expect(carried('upgrade')).toEqual([undefined]);
      expect(await status()).toMatchObject({ last_error: 'feed_unauthorized', token_expires_at: null });

      const pasted = tokenUntil(GOOD_UNTIL, 'pasted');
      writeToken(tokenPath, pasted);
      await until(() => carried('upgrade').includes(`Bearer ${pasted}`));
      await until(async () => (await status())?.last_error === null);
    });

    it('a good paste ends the login failure warning, and the failures once a connection with it subscribes', async () => {
      await seed(KEY);
      secrets();
      clock = T0 - 2 * HOUR; // due within 48 h, but no recording yet
      const h = start({ login: () => Promise.reject(new LoginError('login_token', 500)) });
      await until(async () => (await status())?.warning === 'login_failed');
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      await until(async () => (await status())?.warning === null);
      await h.ticks();
      expect(await status()).toMatchObject({ last_error: null, login_failures: 1, state: 'idle' });
      clock = T0 - HOUR;
      await recording();
      await until(async () => (await status())?.login_failures === 0);
    });

    describe('a login that gives nothing usable counts against the limits', () => {
      /** 2 h in 10 min steps, then the 6 h: at most 3 sign-ins, then one per 6 h. */
      const expectLimits = async (h: { ticks: () => Promise<void> }, attempts: () => number) => {
        await until(() => attempts() === 1);
        for (let i = 0; i < 12; i++) {
          await until(async () => (await status())?.login_failures === attempts()); // its outcome is in
          clock += 10 * MIN;
          await h.ticks();
        }
        expect(attempts()).toBe(3);
        expect(await status()).toMatchObject({ login_failures: 3, warning: 'login_failed' });
        clock = T0 - HOUR + 20 * MIN + 6 * HOUR - 1; // the third sign-in was 20 min in
        await h.ticks();
        expect(attempts()).toBe(3);
        clock += 1;
        await until(() => attempts() === 4);
        await until(async () => (await status())?.login_failures === 4);
        clock += 6 * HOUR - 1;
        await h.ticks();
        expect(attempts()).toBe(4);
      };

      it.each([
        ['a new token each time', 'feed_unauthorized', (n: number) => tokenUntil(GOOD_UNTIL, `n${n}`)],
        ['the same token', 'login_claims', () => tokenUntil(GOOD_UNTIL, 'same')],
      ])('the feed answers 401 to every token: %s', async (_name, lastError, value) => {
        await seed(KEY, T0, T0 + 24 * HOUR);
        secrets();
        fake.behaviour.negotiateStatus = 401;
        let attempts = 0;
        const login = async () => {
          attempts++;
          return { value: value(attempts), expiresAt: GOOD_UNTIL };
        };
        await expectLimits(start({ login }), () => attempts);
        expect((await status())?.last_error).toBe(lastError);
        expect(fake.subscribes).toEqual([]);
      });

      it('a token that does not cover the window: used, but no success', async () => {
        await seed(KEY, T0, T0 + 24 * HOUR);
        secrets();
        const short = T0 + 24 * HOUR; // not end + 1 h
        let attempts = 0;
        const login = async () => {
          attempts++;
          return { value: tokenUntil(short, `n${attempts}`), expiresAt: short };
        };
        await expectLimits(start({ login }), () => attempts);
        expect(await status()).toMatchObject({ last_error: 'login_claims', token_expires_at: new Date(short) });
        expect(carried('upgrade')[0]).toBe(`Bearer ${tokenUntil(short, 'n1')}`);
        expect(readFileSync(tokenPath, 'utf8')).toBe(`${tokenUntil(short, 'n4')}\n`);
      });

      it('a value that fails checkToken: not saved, not used', async () => {
        await seed(KEY, T0, T0 + 24 * HOUR);
        secrets();
        let attempts = 0;
        const login = async () => {
          attempts++;
          return { value: 'not a token', expiresAt: GOOD_UNTIL };
        };
        await expectLimits(start({ login }), () => attempts);
        expect(await status()).toMatchObject({ last_error: 'login_claims', token_expires_at: null });
        expect(existsSync(tokenPath)).toBe(false);
        expect(new Set(carried('upgrade'))).toEqual(new Set([undefined]));
      });
    });

    it('a token that cannot be saved: token_file, used for this process, no failed login, saved once it can be', async () => {
      await seed(KEY);
      secrets();
      const dir = join(root, 'state');
      const path = join(dir, 'f1tv-token');
      const fresh = tokenUntil(GOOD_UNTIL, 'fresh');
      let attempts = 0;
      const login = async () => {
        attempts++;
        return { value: fresh, expiresAt: GOOD_UNTIL };
      };
      const h = start({ tokenPath: path, login });
      await until(() => carried('upgrade').includes(`Bearer ${fresh}`));
      await until(async () => (await status())?.last_error === 'token_file');
      clock += 10 * MIN;
      await h.ticks(5);
      expect(attempts).toBe(1);
      expect(fake.connections()).toBe(1);
      expect(await status()).toMatchObject({
        last_error: 'token_file',
        warning: null,
        login_failures: 0,
        token_expires_at: new Date(GOOD_UNTIL),
      });
      expect(lines.filter((l) => l.includes('"last_error":"token_file"'))).toHaveLength(1);

      mkdirSync(dir);
      await until(() => existsSync(path));
      expect(readFileSync(path, 'utf8')).toBe(`${fresh}\n`);
      await until(async () => (await status())?.last_error === null);
      expect(attempts).toBe(1);
      expect(fake.connections()).toBe(1);
    });

    it('a token file that cannot be read for another reason than ENOENT is token_file, not no token', async () => {
      await seed(KEY);
      writeFileSync(join(root, 'not-a-directory'), '');
      start({ tokenPath: join(root, 'not-a-directory', 'f1tv-token') }); // ENOTDIR, which existsSync hides
      await until(async () => (await status())?.last_error === 'token_file');
    });

    it('a non-LoginError is unknown, and a missing, unreadable or malformed file only sets a code', async () => {
      await seed(KEY);
      const h = start();
      await recording();
      expect((await status())?.last_error).toBe('no_credentials'); // a missing file: no token_* code

      writeFileSync(tokenPath, 'not a token\n', { mode: 0o600 });
      await until(async () => (await status())?.last_error === 'token_format');
      chmodSync(tokenPath, 0o644);
      await until(async () => (await status())?.last_error === 'token_file');
      await h.stop();

      rmSync(tokenPath);
      secrets();
      const again = start({ login: () => Promise.reject(new Error('sentinel message')) });
      await until(async () => (await status())?.last_error === 'unknown');
      expect(lines.join('')).not.toContain('sentinel message');
      await again.ticks();
    });

    it('an expired token is no token: no fault between weekends, but one when a session is due', async () => {
      writeToken(tokenPath, tokenUntil(T0 - HOUR - 1));
      const h = start();
      await until(async () => (await status())?.state === 'idle');
      expect(await status()).toMatchObject({ last_error: null, warning: null, token_expires_at: null });
      await seed(KEY);
      await until(async () => (await status())?.last_error === 'token_expired');
      await recording();
      expect(carried('negotiate')).toEqual([undefined]);
      await h.ticks();
    });
  });

  describe('failures', () => {
    it('a disk failure ends the recording incomplete and waits 5 min before another row', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      writeFileSync(liveDir, 'a file where the directory should be');
      const h = start();
      await until(async () => (await status())?.last_error === 'disk');
      await h.ticks(10);
      expect(await rows()).toHaveLength(1);
      expect(await lastRow()).toMatchObject({ complete: false });
      expect((await lastRow())?.ended_at).not.toBeNull();
      expect((await status())?.state).toBe('idle');
      expect(pings).toEqual(['f1-live/fail']);

      clock += 5 * MIN - 1;
      await h.ticks(10);
      expect(await rows()).toHaveLength(1);

      rmSync(liveDir);
      clock += 1;
      await recording();
      expect(await rows()).toHaveLength(2);
      expect((await status())?.last_error).toBeNull();
    });

    it('low disk sets the warning and the code, and a statfs failure is not fatal', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      let free: () => number = () => 5 * 1024 ** 3 - 1;
      const h = start({ statfs: () => free() });
      await recording();
      await until(async () => (await status())?.warning === 'disk_low');
      expect((await status())?.last_error).toBe('disk_low');
      free = () => {
        throw Object.assign(new Error('sentinel path'), { code: 'EIO' });
      };
      await until(async () => (await status())?.warning === null);
      await h.ticks();
      expect((await status())?.state).toBe('recording');
      expect(lines.join('')).not.toContain('sentinel path');
    });

    it('below the 1 GiB floor: ends like a disk failure, starts nothing, then the 5 min pause', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      let free = 1024 ** 3;
      const h = start({ statfs: () => free });
      await recording();
      await h.ticks();
      expect(await status()).toMatchObject({ state: 'recording', last_error: 'disk_low', warning: 'disk_low' });

      free -= 1;
      expect(await endedRow()).toMatchObject({ complete: false });
      await until(() => pings.length > 0);
      expect(pings).toEqual(['f1-live/fail']);
      await until(async () => (await status())?.state === 'idle');
      expect((await status())?.last_error).toBe('disk');

      // Still under it: no row, however long it stays, and the status says so.
      clock += 10 * MIN;
      await h.ticks(5);
      expect(await rows()).toHaveLength(1);
      expect(await status()).toMatchObject({ state: 'idle', last_error: 'disk' });

      free = 1e12;
      await h.ticks();
      clock += 5 * MIN - 1;
      await h.ticks();
      expect(await rows()).toHaveLength(1);
      clock += 1;
      await recording();
      expect(await rows()).toHaveLength(2);
      expect(pings).toEqual(['f1-live/fail']);
    });

    it('does not start a recording below the floor', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      const h = start({ statfs: () => 1024 ** 3 - 1 });
      await until(async () => (await status())?.last_error === 'disk');
      await h.ticks(5);
      expect(await rows()).toEqual([]);
      expect(fake.connections()).toBe(0);
    });

    it('records anyway when the row cannot be written, and retries the insert', async () => {
      await seed(KEY);
      writeToken(tokenPath, tokenUntil(GOOD_UNTIL));
      await sql`REVOKE INSERT ON recording FROM f1_ingest`.execute(admin);
      try {
        const h = start();
        await until(() => fake.subscribes.length === 1);
        await h.ticks();
        expect(await rows()).toEqual([]);
        expect(logged('"last_error":"db"')).toBe(true);
      } finally {
        await sql`GRANT INSERT ON recording TO f1_ingest`.execute(admin);
      }
      await until(async () => (await rows()).length === 1);
      expect(fake.connections()).toBe(1);
    });

    it('survives a heartbeat that throws, and keeps ticking', async () => {
      await seed(KEY);
      let beats = 0;
      const h = start({
        beat: () => {
          beats++;
          throw Object.assign(new Error('sentinel beat'), { code: 'EROFS' });
        },
      });
      await recording();
      const seen = beats;
      await until(() => beats > seen + 3);
      expect(lines.join('')).not.toContain('sentinel beat');
      await h.stop();
    });
  });

  it('the live role runs as f1_ingest and exits 0 on SIGTERM', async () => {
    const signals = process.listenerCount('SIGTERM');
    const exit = run(['live'], { DATABASE_URL: testDb.urls.f1_ingest }, () => {});
    await until(() => process.listenerCount('SIGTERM') === signals + 1);
    await until(async () => (await status())?.state === 'idle');
    process.emit('SIGTERM', 'SIGTERM'); // the listener only: no real signal reaches the worker
    await expect(exit).resolves.toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(signals);
  });
});
