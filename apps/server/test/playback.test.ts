import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type Lap,
  merge,
  type Obj,
  PlaybackPing,
  type Stints,
  view,
  type Weather,
  weatherRow,
  withWeatherRow,
} from '@f1/contracts';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { createLaps } from '../src/live/laps.ts';
import { createFeed } from '../src/live/merge.ts';
import { lapRows, type PlaybackEvent, playback } from '../src/live/playback.ts';
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
async function record(dir: string, values: Value[], rotateMs: number) {
  let clock = 0;
  const rec = openRecording({ dir, now: () => clock, rotateMs });
  for (const v of values) {
    clock = v[0];
    write(rec, v);
  }
  await rec.finish();
}

/**
 * The full replay as JSON: createFeed and createLaps over every line with receivedAt ≤ t, `.z` skipped (O1), the state
 * and the weather rows cleared before a SessionInfo with another Key than the state's, a weather row per applied
 * WeatherData delta (withWeatherRow), and A§9 from the final state when it is the session's own.
 */
function full(values: Value[], t: number, key = 9001): { state: Obj; laps: Lap[]; stints: Stints; weather: Weather } {
  const [feed, laps] = [createFeed(), createLaps(key, 'f1-live')];
  let weather: Weather = [];
  const keyOf = (v: unknown) => (isObj(v) && typeof v.Key === 'number' ? v.Key : undefined);
  for (const v of values) {
    if (v[0] > t) continue;
    for (const ev of parseFeedLine(JSON.stringify(v))) {
      if (ev.topic.endsWith('.z')) continue;
      const [next, now] = [keyOf(ev.payload), keyOf(feed.state.SessionInfo)];
      if (ev.topic === 'SessionInfo' && next !== undefined && now !== undefined && next !== now) {
        for (const topic of Object.keys(feed.state)) delete feed.state[topic];
        weather = [];
      }
      const delta = feed.apply(ev);
      if (delta === undefined) continue;
      laps.push(ev, delta);
      if (ev.topic === 'WeatherData')
        weather = withWeatherRow(weather, weatherRow(view(feed.state, 'WeatherData'), v[0]));
    }
  }
  const own = keyOf(feed.state.SessionInfo) === key ? feed.state : {};
  return plain({ state: feed.state, ...lapRows(laps.rows(), own), weather });
}

/**
 * A client's lap and stint rows: a snapshot replaces them, a `laps` event replaces the rows of the same key. `apply`
 * returns how many rows it got that equal the row it held.
 */
function clientRows() {
  const laps = new Map<string, Lap>();
  const stints = new Map<string, Stints[number]>();
  return {
    apply(data: { laps: Lap[]; stints: Stints }, snapshot: boolean) {
      if (snapshot) {
        laps.clear();
        stints.clear();
      }
      let same = 0;
      const put = <R>(map: Map<string, R>, key: string, row: R) => {
        if (JSON.stringify(map.get(key)) === JSON.stringify(row)) same++;
        map.set(key, row);
      };
      for (const l of data.laps) put(laps, `${l.driver_number}/${l.lap_number}`, l);
      for (const s of data.stints) put(stints, `${s.driver_number}/${s.stint_number}`, s);
      return same;
    },
    rows: () => ({
      laps: [...laps.values()].sort((a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number),
      stints: [...stints.values()].sort((a, b) => a.driver_number - b.driver_number || a.stint_number - b.stint_number),
    }),
  };
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
    sessionKey?: number;
    delay?: number;
    speed?: number;
    clock?: { now: number };
    ended?: () => Promise<boolean>;
    tick?: () => Promise<void>;
    onOpen?: (seek: { ms: number; lines: number }) => void;
  },
) {
  const clock = o.clock ?? { now: 0 };
  const abort = new AbortController();
  const gen = playback({
    dir,
    sessionKey: o.sessionKey ?? 9001,
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
    ...(o.onOpen && { onOpen: o.onOpen }),
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
/** A WeatherData line at `r`, with its F1 timestamp at `r` too. */
const weatherAt = (r: number, payload: Obj): Value => [r, 'WeatherData', payload, iso(r)];
const byR = (values: Value[]) => values.sort((a, b) => a[0] - b[0]); // stable: a tie keeps its order

// A§9 on the stream rows (#95): synthetic sessions, every value invented.
const s = (sec: number) => T0 + sec * 1000;
const at = (r: number, topic: string, payload: unknown): Value => [r, topic, payload, iso(r)];
const utcOf = (r: number) => iso(r).slice(0, -1); // the feed's Utc has no Z
const said = (r: number, i: number, Message: string): Value =>
  at(r, 'RaceControlMessages', { Messages: { [i]: { Utc: utcOf(r), Category: 'Other', Message } } });
const stints = { Lines: { 7: { Stints: [{ Compound: 'SOFT' }] }, 99: { Stints: [{ Compound: 'SOFT' }] } } };
/** The snapshot at `t`: each lap as driver/lap → [deleted, reason, lap colour, quali_phase]. */
async function seek(dir: string, t: number) {
  const { gen, clock } = start(dir, { at: t });
  const first = (await drain(gen, clock))[0]?.ev;
  const laps = first?.event === 'snapshot' ? first.data.laps : [];
  return Object.fromEntries(
    laps.map((l) => [
      `${l.driver_number}/${l.lap_number}`,
      [l.deleted, l.deleted_reason, l.colour.lap, l.quali_phase] as const,
    ]),
  );
}

/** A practice: car 7's lap 2 deleted for track limits at s200 and reinstated at s300. */
const RULED: Value[] = [
  [s(0), '_subscribe', { SessionInfo: { Key: 9001, Type: 'Practice' }, TimingAppData: stints }],
  at(s(1), 'TimingData', {
    Lines: { 7: { NumberOfLaps: 1, PitOut: true }, 99: { NumberOfLaps: 1, PitOut: true } },
  }),
  at(s(100), 'TimingData', { Lines: { 7: { NumberOfLaps: 2 }, 99: { NumberOfLaps: 2 } } }),
  at(s(190), 'TimingData', { Lines: { 7: { LastLapTime: { Value: '1:30.000' }, NumberOfLaps: 3 } } }),
  at(s(191), 'TimingData', { Lines: { 99: { LastLapTime: { Value: '1:31.000' }, NumberOfLaps: 3 } } }),
  // LAP 3 is lap 2 outside a race; the time names it too.
  said(s(200), 0, 'CAR 7 (ABC) TIME 1:30.000 DELETED - TRACK LIMITS AT TURN 4 LAP 3 12:03:20'),
  said(s(300), 1, 'CAR 7 (ABC) TIME 1:30.000 WILL BE REINSTATED'),
  at(s(400), 'TimingData', { Lines: { 7: { NumberOfLaps: 4 } } }),
];

/** A qualifying (or, with another Type, a session whose series is not read): parts 1 at s20 and 2 at s300. */
const quali = (Type: string): Value[] => [
  [
    s(0),
    '_subscribe',
    {
      SessionInfo: { Key: 9001, Type },
      SessionData: { Series: [] },
      TimingAppData: stints,
      // 99 joined mid-run: its lap 3 has no date_start, so no phase.
      TimingData: { Lines: { 99: { NumberOfLaps: 3, Sectors: { 0: { Value: '28.000' } } } } },
    },
  ],
  at(s(10), 'TimingData', { Lines: { 7: { NumberOfLaps: 1, PitOut: true } } }), // before Q1 starts
  at(s(20), 'SessionData', { Series: { 0: { Utc: utcOf(s(20)), QualifyingPart: 1 } } }),
  at(s(100), 'TimingData', { Lines: { 7: { NumberOfLaps: 2 } } }),
  at(s(300), 'SessionData', { Series: { 1: { Utc: utcOf(s(300)), QualifyingPart: 2 } } }),
  at(s(300), 'TimingData', { Lines: { 7: { NumberOfLaps: 3 } } }), // on the change: the new part
  at(s(310), 'TimingData', { Lines: { 99: { NumberOfLaps: 4 } } }),
];

describe('playback', () => {
  // With their sessions: all make laps and stints.
  const sources: [Value[], number][] = [
    [fixture('practice-reconnect.jsonl'), 9001],
    [fixture('race.jsonl'), 9002],
    // A§9 on the rows (#95): a deleted and reinstated lap, and qualifying parts.
    [RULED, 9001],
    [quali('Qualifying'), 9001],
  ];

  it('state at T from snapshot + deltas equals a full replay from 0', async () => {
    const reading = fc.constantFrom('27.4', '0', '', '1e400', 'abc', '-3.5', '1013.2', '191', '1', '45.5');
    const weatherData = fc.record(
      {
        AirTemp: reading,
        Humidity: reading,
        Pressure: reading,
        Rainfall: reading,
        TrackTemp: reading,
        WindDirection: reading,
        WindSpeed: reading,
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...sources),
        fc.integer({ min: 60_000, max: 400_000 }), // rotateMs
        fc.array(fc.tuple(fc.nat(), weatherData), { maxLength: 6 }), // WeatherData lines, just after these lines
        // Subscribe states with WeatherData: a weather line's payload again just after it (no change: no delta, no
        // row), or another payload just after a line (a change: one delta, one row).
        fc.array(fc.tuple(fc.nat(), fc.option(weatherData, { nil: undefined })), { maxLength: 4 }),
        // Reconnect duplicates: a line re-sent later (up to 4 min) with its topic, payload and F1 timestamp.
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 240_000 })), { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 3 }), // CarData.z lines, just after these lines
        fc.array(fc.nat(), { maxLength: 4 }), // lines received in the same ms as the line before
        fc.array(fc.constantFrom('gz', 'plain', 'both'), { minLength: 1, maxLength: 4 }), // the segments' files
        fc.nat(), // T
        fc.constantFrom(1, 2, 4, 8, 16),
        async ([source, sessionKey], rotateMs, weathers, subs, dups, zs, same, forms, pick, speed) => {
          // Before the duplicates are drawn, so a duplicate can repeat a weather line too (never a `_subscribe` one).
          const weatherLines = weathers.map(([i, w]) => weatherAt(nth(source, i)[0] + 1, w));
          const subscribes = subs.flatMap(([i, w]): Value[] => {
            if (w !== undefined) return [[nth(source, i)[0] + 2, '_subscribe', { WeatherData: w }]];
            if (weatherLines.length === 0) return [];
            const [r, , payload] = nth(weatherLines, i);
            return [[r, '_subscribe', { WeatherData: payload }]]; // after its line: byR keeps a tie's order
          });
          const base = byR([...source, ...weatherLines, ...subscribes]);
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
          for (const i of same) {
            const k = 1 + (i % (values.length - 1));
            const [, ...rest] = nth(values, k);
            values[k] = [nth(values, k - 1)[0], ...rest]; // still in order
          }

          const dir = mkdtempSync(join(tmpdir(), 'f1-playback-'));
          try {
            await record(dir, values, rotateMs);
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
            const at = nth([...candidates, last + 60_000], pick);
            const { gen, clock } = start(dir, { at, speed, sessionKey });
            const events = await drain(gen, clock);
            const truth = (t: number) => full(values, t, sessionKey);

            // (a) the seek, with every lap and stint row up to T
            expect(events[0]?.ev).toEqual({ event: 'snapshot', data: { t: at, ...truth(at) } });
            // (b) the client's state after every delta (after the last one of a line), and its rows after every
            // snapshot and `laps` event, to the end
            // and its weather rows: a snapshot's, then one per WeatherData delta from its merged view
            let client: Obj = {};
            let weather: Weather = [];
            const rows = clientRows();
            for (const [i, { ev }] of events.entries()) {
              if (ev.event === 'snapshot' || ev.event === 'laps') {
                rows.apply(ev.data, ev.event === 'snapshot');
                const { state, weather: rowsAt, ...expected } = truth(ev.data.t);
                expect(rows.rows()).toEqual(expected);
                if (ev.event === 'snapshot') {
                  client = ev.data.state;
                  weather = [...ev.data.weather];
                  expect(client).toEqual(state);
                  expect(weather).toEqual(rowsAt);
                }
              } else if (ev.event === 'delta') {
                clientApply(client, ev.data);
                if (ev.data.topic === 'WeatherData') {
                  weather = withWeatherRow(weather, weatherRow(view(client, 'WeatherData'), ev.data.t));
                }
                const after = events[i + 1]?.ev;
                if (after?.event !== 'delta' || after.data.t !== ev.data.t) {
                  const { state, weather: rowsAt } = truth(ev.data.t);
                  expect(client).toEqual(state);
                  expect(weather).toEqual(rowsAt);
                }
              }
            }
            expect(events.at(-1)?.ev.event).toBe('end');
            expect({ state: client, weather, ...rows.rows() }).toEqual(truth(Number.POSITIVE_INFINITY));
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
    const rec = openRecording({ dir, now: () => recNow, rotateMs: 150_000 });
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
    expect(events[0]?.ev).toEqual({
      event: 'snapshot',
      data: { t: T0 - 50_000, state: {}, laps: [], stints: [], weather: [] },
    });
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
        data: { t: T0 + 10_000, ...full(values, T0 + 10_000) },
      });
      expect(kinds(events)).toEqual(['snapshot', 'end']);
    }
  });

  it('never opens a recording file through a symlink', async () => {
    const values = counter(2);
    for (const name of [`feed-${T0}.jsonl`, `feed-${T0}.jsonl.gz`, 'feed.jsonl']) {
      const dir = tmp();
      const real = join(dir, 'real'); // a valid file: only the link is refused
      writeFileSync(real, name.endsWith('.gz') ? gzipSync(text(values)) : text(values));
      symlinkSync(real, join(dir, name));
      const { gen, clock } = start(dir, { at: 'live', clock: { now: T0 + 5000 } });
      await expect(drain(gen, clock), name).rejects.toMatchObject({ code: 'ELOOP' });
    }
  });

  it('refuses a partial line over 8 MiB', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'feed.jsonl'), `[${T0},"${'x'.repeat(8 * 2 ** 20)}`);
    const { gen, clock } = start(dir, { at: 'live', clock: { now: T0 + 5000 } });
    await expect(drain(gen, clock)).rejects.toMatchObject({ code: 'playback_too_large' });
  });

  it('a session switch clears the state: a fresh snapshot without the previous session, and a seek after it too', async () => {
    // practice-stale.jsonl: the full state of an earlier race (8999: drivers 7, 42 and 99, a chequered flag), then
    // F1's switch to 9001 and its reset lines; practice.jsonl follows.
    // WeatherData lines in both sessions: two before the switch, three after it.
    const lines0 = [...fixture('practice-stale.jsonl'), ...fixture('practice.jsonl')];
    const [first, switchAt] = [nth(lines0, 0)[0], nth(lines0, 1)[0]]; // the SessionInfo of 9001
    const weatherRs = [first + 60_000, first + 120_000, switchAt + 1000, switchAt + 600_000, switchAt + 1_200_000];
    const values = byR([...lines0, ...weatherRs.map((r, i) => weatherAt(r, { AirTemp: `${20 + i}`, Rainfall: '0' }))]);
    const dir = tmp();
    await record(dir, values, 3_600_000);
    const last = nth(values, values.length - 1)[0];
    const lines = (state: Obj) => Object.keys(((state.TimingData as Obj | undefined)?.Lines ?? {}) as Obj).sort();

    const { gen, clock } = start(dir, { at: first, speed: 16 });
    const events = await drain(gen, clock);
    const seek = events[0]?.ev;
    expect(seek?.event === 'snapshot' && seek.data.state).toMatchObject({ SessionInfo: { Key: 8999 } });
    expect(seek?.event === 'snapshot' && lines(seek.data.state)).toEqual(['42', '7', '99']);
    // The switch line comes as a snapshot, not as a delta.
    const at = events.filter(({ ev }) => 'data' in ev && ev.data.t === switchAt).map(({ ev }) => ev);
    expect(at).toEqual([{ event: 'snapshot', data: { t: switchAt, ...full(values, switchAt) } }]);
    expect(at[0]?.event === 'snapshot' && Object.keys(at[0].data.state)).toEqual(['SessionInfo']);
    expect(at[0]?.event === 'snapshot' && at[0].data.state.SessionInfo).toMatchObject({ Key: 9001 });
    // The earlier session's rows came as deltas before the switch, and the switch snapshot has none of them.
    expect(deltas(events).filter((d) => d.topic === 'WeatherData' && d.t < switchAt)).toHaveLength(2);
    expect(at[0]?.event === 'snapshot' && at[0].data.weather).toEqual([]);

    const later = start(dir, { at: last });
    const after = (await drain(later.gen, later.clock))[0]?.ev;
    expect(after).toEqual({ event: 'snapshot', data: { t: last, ...full(values, last) } });
    const state = after?.event === 'snapshot' ? after.data.state : {};
    expect(lines(state)).toEqual(['7', '99']);
    expect(
      after?.event === 'snapshot' && after.data.weather.map((w) => [Date.parse(w.date), w.air_temperature]),
    ).toEqual(weatherRs.slice(2).map((r, i) => [r, 22 + i]));
    expect(JSON.stringify(state)).not.toMatch(/8999|Earlier Synthetic|2026-01-03/); // 9001 has its own chequered flag
    expect(after?.event === 'snapshot' && after.data.laps.length).toBeGreaterThan(0);
    expect(after?.event === 'snapshot' && after.data.laps.filter((l) => l.driver_number === 42)).toEqual([]);
  });

  it('a consumer that stalls 30 s gets one fresh snapshot, not the backlog', async () => {
    const dir = tmp();
    // A WeatherData line every 10 s from 10.5 s on, so the re-snapshot carries the rows up to T.
    const weather = Array.from({ length: 5 }, (_, i) =>
      weatherAt(T0 + (i + 1) * 10_000 + 500, { AirTemp: `${20 + i}` }),
    );
    const values = byR([...counter(60), ...weather]);
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

    expect(rest[0]?.ev).toEqual({ event: 'snapshot', data: { t: T0 + 32_000, ...full(values, T0 + 32_000) } });
    expect(rest[0]?.ev.event === 'snapshot' && rest[0].ev.data.weather.map((w) => w.air_temperature)).toEqual([
      20, 21, 22,
    ]);
    expect(kinds(rest).filter((k) => k === 'snapshot')).toHaveLength(1);
    expect(deltas(rest).map((d) => d.t)).toEqual(values.filter((v) => v[0] > T0 + 32_000).map((v) => v[0]));
    expect(rest.at(-1)?.ev.event).toBe('end');
  });

  it('onOpen reports the seek once, before its snapshot: the lines applied and the ms on `now`; never a later snapshot', async () => {
    const dir = tmp();
    await record(dir, counter(60), 3_600_000);
    const seen: unknown[] = [];
    const clock = { now: 0 };
    const { gen } = start(dir, {
      at: T0 + 5_500,
      clock,
      onOpen: (s) => seen.push(['open', s]),
    });
    // The seek takes 7 ms on the injected clock: `now` is read at the start and once the snapshot is built.
    const first = gen.next();
    clock.now += 7;
    const ev = (await first).value as PlaybackEvent;
    seen.push(ev.event);
    expect(seen).toEqual([['open', { ms: 7, lines: 6 }], 'snapshot']); // the lines at 0 … 5 s
    clock.now += 30_000; // a stalled consumer: the next write sends a fresh snapshot
    const rest = await drain(gen, clock);
    expect(kinds(rest)).toContain('snapshot');
    expect(seen).toHaveLength(2);
  });

  it('never sends a recorded topic it does not parse yet (#96): no delta, and none in a snapshot', async () => {
    const dir = tmp();
    const pit = { PitTimes: { 7: { RacingNumber: '7', Duration: '20.0', Lap: '3' } } };
    const values: Value[] = [
      [T0, '_subscribe', { PitLaneTimeCollection: pit, PitStopSeries: { PitTimes: {} }, PitStop: { Lap: '2' } }],
      at(T0 + 1000, 'PitLaneTimeCollection', pit),
      at(T0 + 2000, 'PitStopSeries', { PitTimes: { 7: [{ Timestamp: iso(T0), PitStop: { PitStopTime: '2.5' } }] } }),
      at(T0 + 3000, 'PitStop', { RacingNumber: '7', PitStopTime: '2.5' }),
      at(T0 + 4000, 'TimingData', { Lines: { 7: { NumberOfLaps: 3 } } }),
    ];
    await record(dir, values, 3_600_000);
    for (const t of [T0, T0 + 5000]) {
      const { gen, clock } = start(dir, { at: t });
      const sent = JSON.stringify(await drain(gen, clock));
      expect(sent).toContain('NumberOfLaps'); // the stream itself goes on: a delta from T0, in the snapshot after
      expect(sent).not.toMatch(/PitLaneTimeCollection|PitStop|PitTimes|PitStopTime/);
    }
  });

  it('sends a heartbeat event with T after 15 s without a write', async () => {
    const dir = tmp();
    const values = counter(2, 40_000);
    await record(dir, values, 3_600_000);
    const { gen, clock } = start(dir, { at: T0 });
    const seen = await drain(gen, clock);
    expect(seen.map(({ at, ev }) => [ev.event, at])).toEqual([
      ['snapshot', 0],
      ['ping', 15_000],
      ['ping', 30_000],
      ['delta', 40_000],
      ['end', 40_000],
    ]);
    // An event with data, not an SSE comment: EventSource delivers only those to the page (its liveness check).
    const pings = seen.flatMap(({ ev }) => (ev.event === 'ping' ? [PlaybackPing.parse(ev.data)] : []));
    expect(pings).toEqual([{ t: T0 + 15_000 }, { t: T0 + 30_000 }]);
  });

  it('ends a finished recording once it is fully sent, and an open one only on abort', async () => {
    const values = fixture('practice.jsonl');
    const last = nth(values, values.length - 1)[0];
    const done = tmp();
    await record(done, values, 600_000);
    const finished = start(done, { at: 'live', clock: { now: last + 3_600_000 } });
    expect((await drain(finished.gen, finished.clock)).map(({ ev }) => ev)).toEqual([
      { event: 'snapshot', data: { t: last + 3_600_000, ...full(values, last) } },
      { event: 'end', data: { t: last + 3_600_050 } }, // after one 50 ms look at the missing feed.jsonl
    ]);

    // An open recording: `ended` is asked at most every 30 s, and the stream stops on abort, with its file closed.
    const dir = tmp();
    const rec = openRecording({ dir, now: () => 0 });
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

  it('laps events carry only the changed rows, at most once a second, and the last ones before end', async () => {
    const dir = tmp();
    const values = fixture('race.jsonl');
    await record(dir, values, 3_600_000);
    const { gen, clock } = start(dir, { at: nth(values, 0)[0], sessionKey: 9002 });
    const events = await drain(gen, clock);

    const laps = events.filter(({ ev }) => ev.event === 'laps');
    expect(laps.length).toBeGreaterThan(2);
    for (const [i, { at }] of laps.entries())
      if (i > 0) expect(at - (laps[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    expect(kinds(events).slice(-2)).toEqual(['laps', 'end']); // the race's last laps come with its last lines
    // Each laps event holds changed rows only: none equals the client's row of its key.
    const rows = clientRows();
    for (const { ev } of events)
      if (ev.event === 'snapshot' || ev.event === 'laps') expect(rows.apply(ev.data, ev.event === 'snapshot')).toBe(0);
    const { state: _, weather: __, ...expected } = full(values, Number.POSITIVE_INFINITY, 9002);
    expect(rows.rows()).toEqual(expected);
    expect(expected.laps.length).toBeGreaterThan(0);
  });

  it('a DELETED message strikes the stream lap from its time on, and a REINSTATED restores it', async () => {
    const dir = tmp();
    await record(dir, RULED, 3_600_000);

    const valid = [false, null, 'purple', null];
    const struck = [true, 'TRACK LIMITS AT TURN 4', 'yellow', null];
    expect(await seek(dir, s(199))).toMatchObject({ '7/2': valid, '99/2': [false, null, 'green', null] });
    expect(await seek(dir, s(250))).toMatchObject({ '7/2': struck, '99/2': [false, null, 'purple', null] });
    expect(await seek(dir, s(350))).toMatchObject({ '7/2': valid, '99/2': [false, null, 'green', null] });

    // Streamed: a race-control line alone sends the changed rows, at its own t.
    const { gen, clock } = start(dir, { at: s(0) });
    const events = await drain(gen, clock);
    const sent = events.flatMap(({ ev }) =>
      ev.event === 'laps'
        ? ev.data.laps.filter((l) => l.driver_number === 7 && l.lap_number === 2).map((l) => [ev.data.t, l.deleted])
        : [],
    );
    expect(sent).toEqual([
      [s(100), false],
      [s(190), false],
      [s(200), true],
      [s(300), false],
    ]);
  });

  it('qualifying stream rows carry quali_phase by A§9: the part at or before the lap start, else null', async () => {
    const phases = async (Type: string) => {
      const dir = tmp();
      await record(dir, quali(Type), 3_600_000);
      return Object.entries(await seek(dir, s(400))).map(([key, row]) => [key, row[3]]);
    };
    expect(await phases('Qualifying')).toEqual([
      ['7/1', null],
      ['7/2', 1],
      ['7/3', 2],
      ['99/3', null],
      ['99/4', 2],
    ]);
    // A practice (or race) series is not read: stale entries after a switch would give every lap a phase.
    expect((await phases('Practice')).every(([, phase]) => phase === null)).toBe(true);
  });
});
