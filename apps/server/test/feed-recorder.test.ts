import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { type Closed, connect, TOPICS } from '../src/live/feed-client.ts';
import { createFeed } from '../src/live/merge.ts';
import { parseFeedLine } from '../src/live/read.ts';
import { gzipLeftovers, openRecording, type Recording } from '../src/live/recording.ts';
import { type FakeSignalR, startFakeSignalR } from './fake-signalr.ts';

// The [CI] proof of the feed path: feed-client.ts and recording.ts against a real local server over real sockets.
// msw would intercept fetch and WebSocket, so it is closed for this file; `fake.seen` holds what reached the server
// over TCP, which is the proof that nothing was intercepted. Every stream is finite: the fake sends only what a test
// tells it to. msw 3 throws on a second close(), so it listens again for msw.setup.ts's own afterAll, which runs after
// this one (Vitest runs after-hooks in reverse order).
beforeAll(() => server.close());
afterAll(() => server.listen({ onUnhandledFrame: 'error' }));

const TOKEN = 'sentinel.token.value';
const T0 = Date.parse('2026-10-30T19:30:00Z');
/** A numbered TimingData message: the `Seq` leaf shows a late duplicate being applied, the `Lines` key shows a loss. */
const numbered = (n: number): [string, unknown, string] => [
  'TimingData',
  { Seq: n, Lines: { [n]: n } },
  new Date(T0 + n * 1000).toISOString(),
];
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(2);
  }
}

/** What the recorder's loop will do, scaled down: connect, record, on a close back off and connect again. */
function runLoop(fake: FakeSignalR, rec: Recording) {
  let stopped = false;
  let conn: ReturnType<typeof connect> | undefined;
  const closes: Closed[] = [];
  let fed = 0;
  const onFeed = (topic: string, payload: unknown, ts: string, at: number) => {
    fed++;
    rec.feed(at, topic, payload, ts);
  };
  const done = (async () => {
    let backoff = 5; // ms, for the recorder's 1 s
    while (!stopped) {
      conn = connect(TOKEN, onFeed, { base: fake.base, onSubscribed: (r, at) => rec.subscribed(at, r) });
      closes.push(await conn.closed);
      if (stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 150); // for the recorder's 30 s
    }
  })();
  return {
    closes,
    fed: () => fed,
    async stop() {
      stopped = true;
      conn?.close();
      await done;
    },
  };
}

/** Every line on disk, segments in name order. */
function segments(dir: string): string[] {
  const names = readdirSync(dir)
    .filter((n) => /^feed-\d+\.jsonl\.gz$/.test(n))
    .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
  return names.flatMap((n) =>
    gunzipSync(readFileSync(join(dir, n)))
      .toString()
      .split('\n')
      .slice(0, -1),
  );
}

function replay(lines: string[]) {
  const feed = createFeed();
  for (const line of lines) for (const ev of parseFeedLine(line)) feed.apply(ev);
  return plain(feed.state);
}

const seqOf = (line: string): number | undefined => {
  const v = JSON.parse(line) as [number, string, { Seq?: number }];
  return v[1] === 'TimingData' ? v[2].Seq : undefined;
};

let fake: FakeSignalR;
let root: string;
let dir: string;
const open: Recording[] = [];
/** Rotation in tests is forced through this clock, not through waiting. */
let clock: number;
const record = (opts: { rotateMs?: number; snapshotMs?: number } = {}) => {
  const rec = openRecording({ dir, now: () => clock, ...opts });
  open.push(rec);
  return rec;
};

beforeEach(async () => {
  fake = await startFakeSignalR();
  root = mkdtempSync(join(tmpdir(), 'f1-feed-'));
  dir = join(root, 'session');
  clock = T0;
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.finish()));
  await fake.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('feed client against the fake server', () => {
  it('connects, subscribes with the topic list, carries the cookie and the token, and keeps them off disk', async () => {
    const rec = record();
    fake.behaviour.fullState = { SessionInfo: { Name: 'Practice 1' }, TimingData: { Seq: 0 } };
    const loop = runLoop(fake, rec);
    await until(() => fake.subscribes.length === 1 && rec.bytes > 0);
    expect(fake.subscribes[0]).toEqual(TOPICS);

    expect(fake.seen.map((s) => s.step)).toEqual(['options', 'negotiate', 'upgrade']);
    expect(fake.seen[0]).toEqual({ step: 'options' });
    for (const s of fake.seen.slice(1)) {
      expect(s.cookie).toBe('AWSALBCORS=fake-alb');
      expect(s.authorization).toBe(`Bearer ${TOKEN}`);
    }

    fake.feed([numbered(1)]);
    await until(() => loop.fed() === 1);
    await rec.snapshot(T0);
    await loop.stop();
    await rec.finish();

    const lines = segments(dir);
    expect(JSON.parse(lines[0] ?? '')[1]).toBe('_subscribe');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((n) => n.endsWith('.gz'));
    expect(files).toHaveLength(2);
    for (const name of files) {
      const text = gunzipSync(readFileSync(join(dir, name))).toString();
      for (const secret of [TOKEN, 'fake-alb', fake.connectionToken]) expect(text).not.toContain(secret);
    }
    expect(plain(rec.state)).toEqual({
      SessionInfo: { Name: 'Practice 1' },
      TimingData: { Seq: 1, Lines: { 1: 1 } },
    });
  });

  it('sends no Authorization without a token', async () => {
    const conn = connect(undefined, () => {}, { base: fake.base });
    await conn.subscribed;
    conn.close();
    expect(fake.seen).toHaveLength(3);
    for (const s of fake.seen) expect(s.authorization).toBeUndefined();
  });

  it('writes the full state before the deltas that follow it in the same network read', async () => {
    const rec = record();
    const order: string[] = [];
    fake.behaviour.fullState = { TimingData: { Seq: 0 } };
    fake.behaviour.afterSubscribe = [numbered(1)];
    const conn = connect(
      TOKEN,
      (topic, payload, ts, at) => {
        order.push('feed');
        rec.feed(at, topic, payload, ts);
      },
      {
        base: fake.base,
        onSubscribed: (r, at) => {
          order.push('onSubscribed');
          rec.subscribed(at, r);
        },
      },
    );
    void conn.subscribed.then(() => order.push('promise'));
    await until(() => order.length === 3);
    conn.close();
    // The promise alone would have put the older full state on top of the delta.
    expect(order).toEqual(['onSubscribed', 'feed', 'promise']);
    expect(plain(rec.state)).toEqual({ TimingData: { Seq: 1, Lines: { 1: 1 } } });
  });

  it('survives a drop: reconnects with backoff, subscribes again and loses nothing, across a rotation', async () => {
    const rec = record({ rotateMs: 60_000 });
    const sent = new Map<number, number>();
    let total = 0;
    const send = (ns: number[]) => {
      fake.feed(ns.map((n) => numbered(n)));
      total += ns.length;
      for (const n of ns) sent.set(n, (sent.get(n) ?? 0) + 1);
    };
    fake.behaviour.fullState = { TimingData: { Seq: 0 }, SessionStatus: { Status: 'Started' } };
    const loop = runLoop(fake, rec);
    await until(() => fake.subscribes.length === 1 && rec.bytes > 0);

    send(range(1, 5));
    await until(() => loop.fed() === total);
    await sleep(5); // the next segment's first receivedAt, its name, differs from this one's
    clock += 60_000; // the segment is now one rotateMs old: the next line opens a new one
    send(range(6, 10));
    await sleep(50); // the scaled stand-in for the criterion's "a drop after N minutes"
    fake.behaviour.fullState = { TimingData: { Seq: 12 }, WeatherData: { Rain: 0 } };
    send(range(11, 12)); // still in flight when the socket ends
    fake.drop();

    await until(() => fake.subscribes.length === 2);
    expect(loop.fed()).toBe(total);
    expect(loop.closes[0]?.error).toBe('feed_socket');
    expect(loop.closes[0]?.closeCode).toBe(1006);
    expect(fake.subscribes[1]).toEqual(TOPICS);
    expect(fake.connections()).toBe(2);

    // The server replays its last messages with the same timestamps, then goes on.
    send([11, 12]);
    send(range(13, 15));
    await until(() => loop.fed() === total);
    await sleep(5);
    clock += 60_000;
    send([16]);
    send([14]); // a late duplicate after a newer message: applied twice, Seq would go back to 14
    await until(() => loop.fed() === total);

    await loop.stop();
    await rec.finish();

    const lines = segments(dir);
    // No plain file left; every segment decompressed; no line split.
    expect(readdirSync(dir).filter((n) => n.endsWith('.jsonl'))).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.endsWith('.gz')).length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();

    // Every numbered message is on disk exactly as often as it was sent.
    const onDisk = new Map<number, number>();
    for (const line of lines) {
      const seq = seqOf(line);
      if (seq !== undefined) onDisk.set(seq, (onDisk.get(seq) ?? 0) + 1);
    }
    expect([...onDisk].sort(([a], [b]) => a - b)).toEqual([...sent].sort(([a], [b]) => a - b));

    // Two subscribes, each one a _subscribe line holding its own full state.
    const fulls = lines.filter((l) => JSON.parse(l)[1] === '_subscribe').map((l) => JSON.parse(l)[2]);
    expect(fulls).toEqual([
      { TimingData: { Seq: 0 }, SessionStatus: { Status: 'Started' } },
      { TimingData: { Seq: 12 }, WeatherData: { Rain: 0 } },
    ]);

    // A replay of the disk gives the recording's own state, and the duplicates did not apply twice.
    const expected = {
      TimingData: { Seq: 16, Lines: Object.fromEntries(range(1, 16).map((n) => [n, n])) },
      SessionStatus: { Status: 'Started' },
      WeatherData: { Rain: 0 },
    };
    expect(replay(lines)).toEqual(expected);
    expect(plain(rec.state)).toEqual(expected);
    expect(rec.bytes).toBe(Buffer.byteLength(lines.map((l) => `${l}\n`).join('')));
  });

  it('gives feed_unauthorized for a negotiate 401 and 403, with the status and none of the body', async () => {
    for (const status of [401, 403]) {
      fake.behaviour.negotiateStatus = status;
      const closed = await connect(TOKEN, () => {}, { base: fake.base }).closed;
      expect(closed).toEqual({ error: 'feed_unauthorized', status });
    }
  });

  it('gives feed_negotiate for another status, and feed_options without the cookie', async () => {
    fake.behaviour.negotiateStatus = 503;
    await expect(connect(TOKEN, () => {}, { base: fake.base }).closed).resolves.toEqual({
      error: 'feed_negotiate',
      status: 503,
    });
    fake.behaviour.optionsCookie = false;
    await expect(connect(TOKEN, () => {}, { base: fake.base }).closed).resolves.toEqual({
      error: 'feed_options',
      status: 405,
    });
  });

  it('gives a fixed code for a refused connection, with no address in it', async () => {
    const base = fake.base;
    await fake.stop();
    const closed = await connect(TOKEN, () => {}, { base }).closed;
    expect(closed).toEqual({ error: 'feed_options' });
    fake = await startFakeSignalR(); // for afterEach
  });

  it('gives feed_timeout for a silent socket, and the timers stop with it', async () => {
    fake.behaviour.silent = true;
    // By identity: a count of the process's active timers also sees undici's, which come and go.
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const pingIndex = () => set.mock.calls.findIndex((call) => call[1] === 5);
    const conn = connect(TOKEN, () => {}, { base: fake.base, idleMs: 30, pingMs: 5 });
    await until(() => pingIndex() !== -1); // the socket is open and the ping timer runs
    await expect(conn.closed).resolves.toEqual({ error: 'feed_timeout' });
    await expect(conn.subscribed).rejects.toThrow('closed before the subscribe completed');
    expect(clear).toHaveBeenCalledWith(set.mock.results[pingIndex()]?.value);
    set.mockRestore();
    clear.mockRestore();
  });

  it('gives feed_timeout for an upgrade that is never answered', async () => {
    fake.behaviour.hangUpgrade = true;
    await expect(connect(TOKEN, () => {}, { base: fake.base, idleMs: 30 }).closed).resolves.toEqual({
      error: 'feed_timeout',
    });
  });

  it('gives feed_subscribe when the Subscribe fails and ends the connection, without the server text', async () => {
    fake.behaviour.subscribeError = 'sentinel subscribe text';
    const conn = connect(TOKEN, () => {}, { base: fake.base });
    await expect(conn.closed).resolves.toEqual({ error: 'feed_subscribe' });
    await expect(conn.subscribed).rejects.toThrow('closed before the subscribe completed');
  });

  it('gives feed_handshake for a refused handshake', async () => {
    fake.behaviour.handshakeError = 'sentinel handshake text';
    await expect(connect(TOKEN, () => {}, { base: fake.base }).closed).resolves.toEqual({ error: 'feed_handshake' });
  });

  it('gives feed_parse for a record that is no JSON', async () => {
    const conn = connect(TOKEN, () => {}, { base: fake.base });
    await conn.subscribed;
    fake.raw('{"sentinel\x1e');
    await expect(conn.closed).resolves.toEqual({ error: 'feed_parse' });
  });

  it('keeps a server close message with an error as feed_socket, without its text', async () => {
    const conn = connect(TOKEN, () => {}, { base: fake.base });
    await conn.subscribed;
    fake.record({ type: 7, error: 'sentinel close text', allowReconnect: true });
    const closed = await conn.closed;
    expect(closed.error).toBe('feed_socket');
    expect(JSON.stringify(closed)).not.toContain('sentinel');
  });

  it('gives no error for a clean close frame or for close()', async () => {
    const conn = connect(TOKEN, () => {}, { base: fake.base });
    await conn.subscribed;
    fake.closeFrame(1000);
    await expect(conn.closed).resolves.toEqual({ closeCode: 1000 });

    const other = connect(TOKEN, () => {}, { base: fake.base });
    await other.subscribed;
    other.close();
    await expect(other.closed).resolves.toEqual({});
  });

  it('writes "undefined" for a feed message with no timestamp, which replays at receivedAt', async () => {
    const seen: string[] = [];
    const conn = connect(TOKEN, (_t, _p, ts) => seen.push(ts), { base: fake.base });
    await conn.subscribed;
    fake.feed([['Heartbeat', { Utc: 'x' }]]);
    await until(() => seen.length === 1);
    conn.close();
    expect(seen).toEqual(['undefined']);
  });
});

describe('recording', () => {
  it('makes the directories 0700 and the files 0600', async () => {
    const rec = record();
    rec.feed(T0, 'A', { x: 1 }, 'undefined');
    await rec.snapshot(T0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'snapshots')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'feed.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'snapshots', `${T0}.json.gz`)).mode & 0o777).toBe(0o600);
    await rec.finish();
    expect(statSync(join(dir, `feed-${T0}.jsonl.gz`)).mode & 0o777).toBe(0o600);
  });

  it('writes a snapshot of the state at that moment, and skips one while another runs', async () => {
    const rec = record();
    rec.subscribed(T0, { TimingData: { Seq: 0 } });
    rec.feed(T0 + 1, ...numbered(1));
    const at = plain(rec.state);
    const first = rec.snapshot(T0 + 2);
    const skipped = rec.snapshot(T0 + 3);
    rec.feed(T0 + 4, ...numbered(2)); // after the moment
    await Promise.all([first, skipped]);
    const name = join(dir, 'snapshots', `${T0 + 2}.json.gz`);
    expect(JSON.parse(gunzipSync(readFileSync(name)).toString())).toEqual(at);
    expect(readdirSync(join(dir, 'snapshots'))).toEqual([`${T0 + 2}.json.gz`]);
    expect(at).not.toEqual(plain(rec.state));
  });

  it('takes snapshots on its own every snapshotMs and stops at finish', async () => {
    const rec = record({ snapshotMs: 5 });
    rec.feed(T0, 'A', { x: 1 }, 'undefined');
    await until(() => readdirSync(join(dir, 'snapshots')).filter((n) => n.endsWith('.gz')).length > 0);
    await rec.finish();
    const count = readdirSync(join(dir, 'snapshots')).length;
    await sleep(30);
    expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(count);
  });

  it('rotates on the snapshot tick too, without a new line', async () => {
    const rec = record({ rotateMs: 60_000, snapshotMs: 5 });
    rec.feed(T0, 'A', { x: 1 }, 'undefined');
    clock += 60_000;
    await until(() => existsSync(join(dir, `feed-${T0}.jsonl.gz`)));
    await rec.finish();
    expect(segments(dir)).toHaveLength(1);
  });

  it('finish is idempotent, ignores later lines and removes an empty segment', async () => {
    const rec = record();
    await Promise.all([rec.finish(), rec.finish()]);
    await rec.finish();
    rec.feed(T0, 'A', { x: 1 }, 'undefined');
    await rec.snapshot(T0);
    expect(readdirSync(dir)).toEqual(['snapshots']);
    expect(readdirSync(join(dir, 'snapshots'))).toEqual([]);
    expect(rec.bytes).toBe(0);
  });

  it('sets the sticky failed flag on a full disk, without throwing, and stops writing', async () => {
    mkdirSync(dir, { recursive: true });
    symlinkSync('/dev/full', join(dir, 'feed.jsonl')); // writing here gives a real ENOSPC
    const rec = record();
    expect(rec.failed).toBeUndefined();
    expect(() => rec.feed(T0, 'A', { x: 1 }, 'undefined')).not.toThrow();
    expect(rec.failed).toBe('disk');
    expect(() => rec.subscribed(T0, { B: {} })).not.toThrow();
    expect(rec.bytes).toBe(0);
    expect(plain(rec.state)).toEqual({});
    await expect(rec.finish()).resolves.toBeUndefined();
  });

  it('sets failed instead of throwing when the directory cannot be made', () => {
    writeFileSync(join(root, 'file'), '');
    const rec = openRecording({ dir: join(root, 'file', 'sub') });
    open.push(rec);
    expect(rec.failed).toBe('disk');
    expect(() => rec.feed(T0, 'A', {}, 'undefined')).not.toThrow();
  });

  it('keeps the plain file when the gzip fails, and goes on writing', async () => {
    const rec = record({ rotateMs: 60_000 });
    mkdirSync(join(dir, `feed-${T0}.jsonl.gz.tmp`)); // the job cannot open its tmp name
    rec.feed(T0, 'A', { x: 1 }, 'undefined');
    clock += 60_000;
    rec.feed(T0 + 60_000, 'A', { x: 2 }, 'undefined');
    await rec.finish();
    expect(rec.backgroundFailures).toBe(1);
    expect(rec.failed).toBeUndefined();
    expect(readFileSync(join(dir, `feed-${T0}.jsonl`), 'utf8')).toContain('"x":1');
    expect(segments(dir)).toHaveLength(1);
    // A later gzipLeftovers picks it up, once the cause is gone.
    rmSync(join(dir, `feed-${T0}.jsonl.gz.tmp`), { recursive: true });
    await expect(gzipLeftovers(dir)).resolves.toBe(0);
    expect(segments(dir)).toHaveLength(2);
  });
});

describe('gzipLeftovers', () => {
  const line = (ms: number, n: number) => JSON.stringify([ms, 'TimingData', { Seq: n }, 'undefined']);

  it('gzips what a crash left, removes stale tmp files, and the segments give every line once', async () => {
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
    writeFileSync(join(dir, 'feed-100.jsonl'), `${line(100, 1)}\n${line(101, 2)}\n`);
    writeFileSync(join(dir, 'feed-100.jsonl.gz.tmp'), 'half a gzip');
    writeFileSync(join(dir, 'feed.jsonl'), `${line(200, 3)}\n${line(201, 4)}\n[202,"Timing`);
    writeFileSync(join(dir, 'snapshots', '.150.tmp'), 'half');
    writeFileSync(join(dir, 'other.txt'), 'stays');

    await expect(gzipLeftovers(dir)).resolves.toBe(0);

    expect(readdirSync(dir).sort()).toEqual(['feed-100.jsonl.gz', 'feed-200.jsonl.gz', 'other.txt', 'snapshots']);
    expect(readdirSync(join(dir, 'snapshots'))).toEqual([]);
    const lines = segments(dir);
    expect(lines.slice(0, 4).map(seqOf)).toEqual([1, 2, 3, 4]);
    expect(parseFeedLine('[202,"Timing')).toEqual([]);
    expect(
      gunzipSync(readFileSync(join(dir, 'feed-200.jsonl.gz')))
        .toString()
        .endsWith('[202,"Timing'),
    ).toBe(true);
  });

  it('removes an empty segment and names a head too short to read by its mtime', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'feed.jsonl'), '');
    await expect(gzipLeftovers(dir)).resolves.toBe(0);
    expect(readdirSync(dir)).toEqual([]);

    writeFileSync(join(dir, 'feed.jsonl'), '[17');
    await expect(gzipLeftovers(dir)).resolves.toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^feed-\d+\.jsonl\.gz$/);
  });

  it('does not throw on a directory that is gone', async () => {
    await expect(gzipLeftovers(join(root, 'nothing'))).resolves.toBe(0);
  });

  it('a recording that ends without finish leaves the lines for gzipLeftovers', async () => {
    const rec = record();
    rec.subscribed(T0, { TimingData: { Seq: 0 } });
    rec.feed(T0 + 1, ...numbered(1));
    const state = plain(rec.state);
    await gzipLeftovers(dir);
    expect(replay(segments(dir))).toEqual(state);
  });
});
