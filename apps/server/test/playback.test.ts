import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { merge, type Obj } from '@f1/contracts';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeed } from '../src/live/merge.ts';
import { type PlaybackEvent, playback } from '../src/live/playback.ts';
import { parseFeedLine } from '../src/live/read.ts';
import { openRecording, type Recording } from '../src/live/recording.ts';

// playback.ts over real recordings: openRecording writes the files on an injected clock, and the playback runs on a
// fake clock that only its sleep advances, so no test waits on a timer. Every stream is finite: it reaches `end` or
// the test aborts it, and `drain` fails a stream that runs past its event budget.

/** A feed.jsonl line: [receivedAt, topic, payload, F1 timestamp], or [receivedAt, '_subscribe', result]. */
type Value = [number, string, unknown, string?];
type Seen = { at: number; ev: PlaybackEvent };

const T0 = Date.parse('2027-01-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const fixture = (file: string): Value[] =>
  readFileSync(join(import.meta.dirname, 'fixtures/live', file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Value);
const nth = <T>(list: readonly T[], i: number) => list[i % list.length] as T;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
/**
 * A line every `step` ms from T0, each setting a counter, so every line changes the state. With F1 times 6 min apart
 * (`f1Step`), the duplicate filter forgets each line before the next: a line read twice comes out as a second delta.
 */
const counter = (n: number, step = 1000, f1Step = step): Value[] =>
  Array.from({ length: n }, (_, i) => [
    T0 + i * step,
    'TimingData',
    { Lines: { '1': { N: i } } },
    iso(T0 + i * f1Step),
  ]);

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'f1-playback-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (rec: Recording, [r, topic, payload, ts]: Value) =>
  topic === '_subscribe' ? rec.subscribed(r, payload) : rec.feed(r, topic, payload, ts ?? 'undefined');

/** Writes `values` through the recorder, its clock at each line's receivedAt, and finishes it. */
async function record(
  dir: string,
  values: Value[],
  rotateMs: number,
  after?: (i: number, rec: Recording) => Promise<void>,
) {
  let clock = 0;
  const rec = openRecording({ dir, now: () => clock, rotateMs, snapshotMs: 3_600_000 });
  for (const [i, v] of values.entries()) {
    clock = v[0];
    write(rec, v);
    await after?.(i, rec);
  }
  await rec.finish();
}

/** The full replay: createFeed over every line with receivedAt ≤ t, `.z` skipped (O1), as JSON. */
function replay(values: Value[], t: number): unknown {
  const feed = createFeed();
  for (const v of values) {
    if (v[0] > t) continue;
    for (const ev of parseFeedLine(JSON.stringify(v))) if (!ev.topic.endsWith('.z')) feed.apply(ev);
  }
  return plain(feed.state);
}

/** What a client does with a delta: an object merges into state[topic] (from {} when that is no object), else replaces. */
function clientApply(state: Obj, { topic, data }: { topic: string; data: unknown }) {
  if (!isObj(data)) state[topic] = data;
  else {
    if (!isObj(state[topic])) state[topic] = {};
    merge(state[topic] as Obj, data);
  }
}

/** A playback on a fake clock: `sleep` advances it, then runs `tick`. */
function start(
  dir: string,
  o: {
    at: number | 'live';
    delay?: number;
    speed?: number;
    clock?: { now: number };
    ended?: () => Promise<boolean>;
    tick?: () => Promise<void>;
  },
) {
  const clock = o.clock ?? { now: 0 };
  const abort = new AbortController();
  const gen = playback({
    dir,
    at: o.at,
    delay: o.delay ?? 0,
    speed: o.speed ?? 1,
    now: () => clock.now,
    sleep: async (ms) => {
      if (!(ms > 0 && ms <= 15_000)) throw new Error(`bad sleep ${ms}`);
      clock.now += ms;
      await o.tick?.();
    },
    ended: o.ended ?? (async () => true),
    signal: abort.signal,
  });
  return { gen, clock, abort };
}

/** Every event to the end, each with the clock when it was yielded (and as JSON, as it would be sent). */
async function drain(gen: AsyncGenerator<PlaybackEvent>, clock: { now: number }, max = 5000): Promise<Seen[]> {
  const out: Seen[] = [];
  for await (const ev of gen) {
    out.push({ at: clock.now, ev: plain(ev) });
    if (out.length > max) throw new Error('runaway stream');
  }
  return out;
}

const deltas = (events: Seen[]) =>
  events.flatMap(({ at, ev }) => (ev.event === 'delta' ? [{ at, t: ev.data.t, topic: ev.data.topic }] : []));
const kinds = (events: Seen[]) => events.map(({ ev }) => ev.event);
const text = (values: Value[]) => values.map((v) => `${JSON.stringify(v)}\n`).join('');

describe('playback', () => {
  const sources = [fixture('practice-reconnect.jsonl'), fixture('race.jsonl')];

  it('state at T from snapshot + deltas equals a full replay from 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...sources),
        fc.integer({ min: 60_000, max: 400_000 }), // rotateMs
        // Reconnect duplicates: a line re-sent later (up to 4 min) with its topic, payload and F1 timestamp.
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 240_000 })), { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 3 }), // CarData.z lines, just after these lines
        // Snapshots after a line: at its receivedAt, halfway to the next line, or at the next line's.
        fc.array(fc.tuple(fc.nat(), fc.constantFrom(0, 0.5, 1)), { maxLength: 6 }),
        fc.array(fc.constantFrom('gz', 'plain', 'both'), { minLength: 1, maxLength: 4 }), // the segments' files
        fc.nat(), // T
        fc.constantFrom(1, 2, 4, 8, 16),
        async (base, rotateMs, dups, zs, snaps, forms, pick, speed) => {
          const values = [...base];
          for (const [i, delay] of dups) {
            const [r, ...rest] = nth(base, i);
            if (rest[0] !== '_subscribe') values.push([r + delay, ...rest]);
          }
          for (const i of zs) {
            const r = nth(base, i)[0] + 1;
            values.push([r, 'CarData.z', 'eJyLjgUAARUAuQ==', iso(r)]);
          }
          values.sort((a, b) => a[0] - b[0]);
          const snapAt = new Map<number, number[]>();
          for (const [i, f] of snaps) {
            const k = i % values.length;
            const r = nth(values, k)[0];
            const ms = Math.floor(r + f * ((values[k + 1]?.[0] ?? r + 1000) - r));
            snapAt.set(k, [...(snapAt.get(k) ?? []), ms]);
          }

          const dir = mkdtempSync(join(tmpdir(), 'f1-playback-'));
          try {
            await record(dir, values, rotateMs, async (k, rec) => {
              for (const ms of snapAt.get(k) ?? []) await rec.snapshot(ms);
            });
            const gz = readdirSync(dir)
              .filter((n) => n.endsWith('.jsonl.gz'))
              .sort();
            for (const [j, name] of gz.entries()) {
              const form = nth(forms, j);
              if (form !== 'gz') writeFileSync(join(dir, name.slice(0, -3)), gunzipSync(readFileSync(join(dir, name))));
              if (form === 'plain') rmSync(join(dir, name));
            }
            writeFileSync(join(dir, 'feed-1.jsonl.gz.tmp'), 'not a segment');

            const rs = values.map((v) => v[0]);
            const first = nth(rs, 0);
            const last = nth(rs, rs.length - 1);
            const candidates = [first - 60_000, ...rs, ...rs.map((r, i) => Math.floor((r + (rs[i + 1] ?? r)) / 2))];
            const at = nth([...candidates, ...[...snapAt.values()].flat(), last + 60_000], pick);
            const { gen, clock } = start(dir, { at, speed });
            const events = await drain(gen, clock);

            // (a) the seek
            expect(events[0]?.ev).toEqual({ event: 'snapshot', data: { t: at, state: replay(values, at) } });
            // (b) the client's state after every delta (after the last one of a line), to the end
            let client: Obj = {};
            for (const [i, { ev }] of events.entries()) {
              if (ev.event === 'snapshot') {
                client = ev.data.state;
                expect(client).toEqual(replay(values, ev.data.t));
              } else if (ev.event === 'delta') {
                clientApply(client, ev.data);
                const after = events[i + 1]?.ev;
                if (after?.event !== 'delta' || after.data.t !== ev.data.t)
                  expect(client).toEqual(replay(values, ev.data.t));
              }
            }
            expect(events.at(-1)?.ev.event).toBe('end');
            expect(client).toEqual(replay(values, Number.POSITIVE_INFINITY));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000); // a failure's shrinking reruns the recording many times

  it('live with delay 45 never emits an event newer than now − 45 s', async () => {
    const dir = tmp();
    const values = counter(40, 7000, 360_000); // a line every 7 s for 4.5 min, none of them repeatable
    const last = nth(values, values.length - 1)[0];
    let recNow = T0;
    const rec = openRecording({ dir, now: () => recNow, rotateMs: 150_000, snapshotMs: 3_600_000 });
    let written = 0;
    let finished = false;
    const clock = { now: T0 - 5000 };
    const { gen } = start(dir, {
      at: 'live',
      delay: 45,
      clock,
      ended: async () => finished,
      // The recorder appends each line once the clock passes its receivedAt, and finishes a minute after the last.
      tick: async () => {
        for (; written < values.length && nth(values, written)[0] <= clock.now; written++) {
          recNow = nth(values, written)[0];
          write(rec, nth(values, written));
        }
        recNow = clock.now;
        if (written === values.length && !finished && clock.now > last + 60_000) {
          await rec.finish();
          finished = true;
        }
      },
    });
    const events = await drain(gen, clock);

    for (const { at, ev } of events) if ('data' in ev) expect(ev.data.t).toBeLessThanOrEqual(at - 45_000);
    expect(events[0]?.ev).toEqual({ event: 'snapshot', data: { t: T0 - 50_000, state: {} } });
    expect(deltas(events).map((d) => d.t)).toEqual(values.map((v) => v[0])); // each line once, in order
    expect(events.at(-1)?.ev.event).toBe('end');
    expect(readdirSync(dir).filter((n) => n.startsWith('feed-'))).toHaveLength(2); // one rotation
  });

  it('reads each segment once: the plain file over its gzip, the gzip once the plain is gone', async () => {
    const dir = tmp();
    const values = counter(8, 1000, 360_000);
    const name = (n: number) => join(dir, `feed-${nth(values, 2 * n)[0]}.jsonl`);
    const pair = (n: number) => text(values.slice(2 * n, 2 * n + 2));
    writeFileSync(`${name(0)}.gz`, gzipSync(pair(0)));
    writeFileSync(name(1), pair(1));
    writeFileSync(`${name(1)}.gz`, gzipSync(pair(1)));
    writeFileSync(name(2), pair(2)); // listed, but gone by the open: its gzip job finished in between
    writeFileSync(`${name(2)}.gz`, gzipSync(pair(2)));
    writeFileSync(name(3), pair(3));
    linkSync(name(3), join(dir, 'feed.jsonl')); // the open found feed.jsonl, the listing its new name
    writeFileSync(`${name(3)}.gz.tmp`, 'not a segment');
    // The seek lists every segment and stops at the first line; the first sleep comes after the listing.
    const { gen, clock } = start(dir, { at: T0 - 1000, speed: 16, tick: async () => rmSync(name(2), { force: true }) });
    const events = await drain(gen, clock);

    expect(deltas(events).map((d) => d.t)).toEqual(values.map((v) => v[0]));
    expect(events.at(-1)?.ev.event).toBe('end');
  });

  it('a live join in a rotation waits for the new feed.jsonl: its snapshot holds every line', async () => {
    const values = counter(4, 1000, 360_000);
    // The open found feed.jsonl before its rename (a hard link to the segment), or none before the writer's reopen.
    for (const renamed of [true, false]) {
      const dir = tmp();
      const seg = join(dir, `feed-${T0}.jsonl`);
      writeFileSync(seg, text(values.slice(0, 2)));
      if (renamed) linkSync(seg, join(dir, 'feed.jsonl'));
      let reopened = false;
      const { gen, clock } = start(dir, {
        at: 'live',
        clock: { now: T0 + 10_000 },
        ended: async () => reopened,
        tick: async () => {
          if (reopened) return;
          rmSync(join(dir, 'feed.jsonl'), { force: true });
          writeFileSync(join(dir, 'feed.jsonl'), text(values.slice(2)));
          reopened = true;
        },
      });
      const events = await drain(gen, clock);

      expect(events[0]?.ev).toEqual({
        event: 'snapshot',
        data: { t: T0 + 10_000, state: replay(values, T0 + 10_000) },
      });
      expect(kinds(events)).toEqual(['snapshot', 'end']);
    }
  });

  it('never opens a recording file through a symlink', async () => {
    const values = counter(2);
    for (const name of [`feed-${T0}.jsonl`, `feed-${T0}.jsonl.gz`, 'feed.jsonl', `snapshots/${T0}.json.gz`]) {
      const dir = tmp();
      mkdirSync(join(dir, 'snapshots'));
      const real = join(dir, 'real'); // a valid file: only the link is refused
      writeFileSync(
        real,
        name.startsWith('snapshots') ? gzipSync('{}') : name.endsWith('.gz') ? gzipSync(text(values)) : text(values),
      );
      symlinkSync(real, join(dir, name));
      const { gen, clock } = start(dir, { at: 'live', clock: { now: T0 + 5000 } });
      await expect(drain(gen, clock), name).rejects.toMatchObject({ code: 'ELOOP' });
    }
  });

  it('refuses a snapshot over 16 MiB unzipped and a partial line over 8 MiB', async () => {
    const snapshot = tmp();
    mkdirSync(join(snapshot, 'snapshots'));
    writeFileSync(join(snapshot, 'snapshots', `${T0}.json.gz`), gzipSync(`{"X":"${'x'.repeat(16 * 2 ** 20)}"}`));
    const line = tmp();
    writeFileSync(join(line, 'feed.jsonl'), `[${T0},"${'x'.repeat(8 * 2 ** 20)}`);
    for (const dir of [snapshot, line]) {
      const { gen, clock } = start(dir, { at: 'live', clock: { now: T0 + 5000 } });
      await expect(drain(gen, clock), dir).rejects.toMatchObject({ code: 'playback_too_large' });
    }
  });

  it('a consumer that stalls 30 s gets one fresh snapshot, not the backlog', async () => {
    const dir = tmp();
    const values = counter(60);
    await record(dir, values, 3_600_000);
    const { gen, clock } = start(dir, { at: T0 });
    const head: Seen[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = plain((await gen.next()).value as PlaybackEvent);
      head.push({ at: clock.now, ev });
    }
    expect(head.map(({ at, ev }) => [ev.event, at])).toEqual([
      ['snapshot', 0],
      ['delta', 1000],
      ['delta', 2000],
    ]);
    clock.now += 30_000; // the consumer's write of that delta took 30 s
    const rest = await drain(gen, clock);

    expect(rest[0]?.ev).toEqual({ event: 'snapshot', data: { t: T0 + 32_000, state: replay(values, T0 + 32_000) } });
    expect(kinds(rest).filter((k) => k === 'snapshot')).toHaveLength(1);
    expect(deltas(rest).map((d) => d.t)).toEqual(values.slice(33).map((v) => v[0]));
    expect(rest.at(-1)?.ev.event).toBe('end');
  });

  it('sends a heartbeat after 15 s without a write', async () => {
    const dir = tmp();
    const values = counter(2, 40_000);
    await record(dir, values, 3_600_000);
    const { gen, clock } = start(dir, { at: T0 });
    expect((await drain(gen, clock)).map(({ at, ev }) => [ev.event, at])).toEqual([
      ['snapshot', 0],
      ['ping', 15_000],
      ['ping', 30_000],
      ['delta', 40_000],
      ['end', 40_000],
    ]);
  });

  it('ends a finished recording once it is fully sent, and an open one only on abort', async () => {
    const values = fixture('practice.jsonl');
    const last = nth(values, values.length - 1)[0];
    const done = tmp();
    await record(done, values, 600_000);
    const finished = start(done, { at: 'live', clock: { now: last + 3_600_000 } });
    expect((await drain(finished.gen, finished.clock)).map(({ ev }) => ev)).toEqual([
      { event: 'snapshot', data: { t: last + 3_600_000, state: replay(values, last) } },
      { event: 'end', data: { t: last + 3_600_050 } }, // after one 50 ms look at the missing feed.jsonl
    ]);

    // An open recording: `ended` is asked at most every 30 s, and the stream stops on abort, with its file closed.
    const dir = tmp();
    const rec = openRecording({ dir, now: () => 0, snapshotMs: 3_600_000 });
    for (const v of values) write(rec, v);
    const fds = () => readdirSync('/proc/self/fd').length;
    const before = fds();
    let polls = 0;
    const open = start(dir, {
      at: 'live',
      clock: { now: last + 1000 },
      ended: async () => {
        polls++;
        return false;
      },
    });
    const seen: string[] = [];
    for await (const ev of open.gen) {
      seen.push(ev.event);
      if (open.clock.now >= last + 61_000) open.abort.abort();
      if (seen.length > 100) throw new Error('runaway stream');
    }
    expect(seen).toEqual(['snapshot', 'ping', 'ping', 'ping', 'ping']);
    expect(polls).toBe(3);
    expect(fds()).toBe(before);
    await rec.finish();
  });

  it('replays at speed 4: each delta comes at a quarter of its feed time', async () => {
    const dir = tmp();
    const values = fixture('race.jsonl');
    await record(dir, values, 300_000);
    const at = nth(values, 0)[0];
    const { gen, clock } = start(dir, { at, speed: 4 });
    const events = await drain(gen, clock);

    expect(deltas(events).length).toBeGreaterThan(20);
    for (const d of deltas(events)) expect(d.at).toBe(Math.ceil((d.t - at) / 4));
    expect(kinds(events).filter((k) => k === 'snapshot')).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      at: Math.ceil((nth(values, values.length - 1)[0] - at) / 4),
      ev: { event: 'end', data: { t: expect.any(Number) } },
    });
  });
});
