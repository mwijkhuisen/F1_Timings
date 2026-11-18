import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TOPICS } from '../apps/server/src/archive/job.ts';
import { type FeedEvent, parseJsonStream } from '../apps/server/src/live/read.ts';
import {
  BAR,
  compare,
  compareLaps,
  compareStints,
  firstDiff,
  type Input,
  mergeCheck,
  type Oracle,
  type Row,
  readInput,
  reconnectCheck,
  reconnectLines,
  reconstruct,
} from '../scripts/compare-laps.ts';

const lap = (driver_number: number, lap_number: number, extra: Record<string, unknown> = {}): Row => ({
  driver_number,
  lap_number,
  lap_ms: 90_000,
  s1_ms: 30_000,
  s2_ms: 30_000,
  s3_ms: 30_000,
  ...extra,
});

describe('compareLaps', () => {
  it('matches within 1 ms, or both null, over the union of keys', () => {
    const ours = [
      lap(1, 1),
      lap(1, 2, { lap_ms: 90_001 }),
      lap(1, 3, { lap_ms: null, s3_ms: null }),
      lap(1, 4, { s1_ms: 30_002 }),
    ];
    const theirs = [lap(1, 1), lap(1, 2), lap(1, 3, { lap_ms: null, s3_ms: null }), lap(1, 4), lap(1, 5)];
    const r = compareLaps(ours, theirs);
    expect(r).toMatchObject({ ours: 4, theirs: 5, matched: 3, union: 5, rate: 3 / 5 });
    expect(r.mismatches).toEqual([
      { driver: 1, n: 4, field: 's1_ms', theirs: 30_000, ours: 30_002 },
      { driver: 1, n: 5, field: 'lap', theirs: 'present', ours: 'missing' },
    ]);
  });

  it('one null against a number is a mismatch', () => {
    const r = compareLaps([lap(2, 1, { lap_ms: null })], [lap(2, 1)]);
    expect(r.mismatches).toEqual([{ driver: 2, n: 1, field: 'lap_ms', theirs: 90_000, ours: null }]);
    expect(r.rate).toBeLessThan(BAR);
  });

  it('counts the other fields with at most 10 examples; date_start only past 1 s', () => {
    const ours = Array.from({ length: 12 }, (_, i) =>
      lap(1, i + 1, { is_pit_out: true, date_start: '2026-10-30T10:00:01.500Z' }),
    );
    const theirs = ours.map((l) => ({ ...l, is_pit_out: false, date_start: '2026-10-30T10:00:00.600Z', seg1: [2048] }));
    const { extras } = compareLaps(ours, theirs);
    expect(extras.is_pit_out?.count).toBe(12);
    expect(extras.is_pit_out?.examples).toHaveLength(10);
    expect(extras.date_start?.count).toBe(0);
    expect(extras.seg1?.count).toBe(12);
    const far = compareLaps(
      [lap(1, 1, { date_start: '2026-10-30T10:00:03Z' })],
      [lap(1, 1, { date_start: '2026-10-30T10:00:01Z' })],
    );
    expect(far.extras.date_start?.count).toBe(1);
  });
});

describe('compareStints', () => {
  it('lists missing stints and differing fields', () => {
    const s = (n: number, compound: string): Row => ({
      driver_number: 1,
      stint_number: n,
      lap_start: 1,
      lap_end: 9,
      compound,
    });
    expect(compareStints([s(1, 'SOFT'), s(3, 'HARD')], [s(1, 'MEDIUM'), s(2, 'HARD')])).toEqual([
      { driver: 1, n: 1, field: 'compound', theirs: 'MEDIUM', ours: 'SOFT' },
      { driver: 1, n: 2, field: 'stint', theirs: 'present', ours: 'missing' },
      { driver: 1, n: 3, field: 'stint', theirs: 'missing', ours: 'present' },
    ]);
  });
});

describe('merge check', () => {
  it('finds the first differing path and never returns a value', () => {
    expect(firstDiff({ a: { b: 1 } }, { a: { b: 1 } })).toBeUndefined();
    expect(firstDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toBe('.a.c');
    expect(firstDiff({ a: 1 }, { a: 1, z: {} })).toBe('.z');
    expect(firstDiff('x', 'y')).toBe('');
  });

  it('compares the merged state with merge({}, <Topic>.json)', () => {
    const state = { TimingData: { Lines: { '1': { Position: '1' } } } };
    expect(mergeCheck('TimingData', state, { Lines: { '1': { Position: '1' } } })).toBe('merge TimingData: equal');
    expect(mergeCheck('TimingData', state, { Lines: { '1': { Position: '2' } } })).toBe(
      'merge TimingData: differs at .Lines.1.Position',
    );
    expect(mergeCheck('Other', state, { A: 1 })).toBe('merge Other: differs at (root)');
  });

  it('prints a feed key as printable ASCII only', () => {
    expect(mergeCheck('TimingData', { TimingData: {} }, { '\u001b[2J': 1 })).toBe('merge TimingData: differs at .?[2J');
  });
});

describe('readInput and compare', () => {
  it('reads an archive: t0 from Heartbeat, every topic, merged by t', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-compare-'));
    writeFileSync(join(dir, 'Heartbeat.jsonStream'), '﻿00:00:01.000{"Utc":"2026-10-30T10:00:01.000Z"}\r\n');
    writeFileSync(join(dir, 'TimingData.jsonStream'), '﻿00:00:05.000{"Lines":{}}\r\n00:00:00.500{"Lines":{}}\r\n');
    const input = await readInput(dir, new Set(TOPICS));
    const t0 = Date.parse('2026-10-30T10:00:00.000Z');
    expect(input?.events.map((e) => [e.topic, e.t - t0])).toEqual([
      ['TimingData', 500],
      ['Heartbeat', 1000],
      ['TimingData', 5000],
    ]);
    expect(await readInput(join(dir, 'missing'), new Set(TOPICS))).toBeUndefined();
  });

  it("reads only the archive job's topics (P3e): a .z or other raw-only file is never parsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-compare-'));
    writeFileSync(join(dir, 'Heartbeat.jsonStream'), '\uFEFF00:00:01.000{"Utc":"2026-10-30T10:00:01.000Z"}\r\n');
    writeFileSync(join(dir, 'TimingData.jsonStream'), '\uFEFF00:00:05.000{"Lines":{}}\r\n');
    writeFileSync(join(dir, 'CarData.z.jsonStream'), '00:00:02.000"bm90IGRlZmxhdGU="\r\nnot a line\r\n');
    writeFileSync(join(dir, 'TeamRadio.jsonStream'), '00:00:03.000{"Captures":[]}\r\nnot a line\r\n');
    const input = await readInput(dir, new Set(TOPICS));
    expect(input?.events.map((e) => e.topic)).toEqual(['Heartbeat', 'TimingData']);
    expect(input?.skipped).toBe(0);
  });

  it("leaves the session's Index.json out of an archive directory's merge check", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-compare-'));
    const race = join(import.meta.dirname, '../apps/server/test/fixtures/archive/race'); // synthetic
    for (const f of readdirSync(race)) copyFileSync(join(race, f), join(dir, f));
    writeFileSync(join(dir, 'Index.json'), '{"Feeds":{"DriverList":{}}}');
    writeFileSync(join(dir, 'DriverList.json'), '{}');
    const lines: string[] = [];
    await compare(
      [dir],
      {},
      (l) => lines.push(l),
      async () => ({ laps: [], stints: [] }),
    );
    expect(lines).toContain('session 9102 type Race');
    expect(lines.filter((l) => l.startsWith('merge '))).toEqual(['merge DriverList: differs at .3']);
  });

  it('reads a recorder directory: its segments in numeric order, gzipped or plain, then feed.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-compare-'));
    const line = (t: number, topic: string) => JSON.stringify([t, topic, { n: t }, 'undefined']);
    writeFileSync(
      join(dir, 'feed-1000.jsonl.gz'),
      gzipSync(`${line(1000, 'TimingData')}\n${line(1001, 'LapCount')}\n`),
    );
    writeFileSync(join(dir, 'feed-999.jsonl.gz'), gzipSync(`${line(999, 'Heartbeat')}\n`)); // after 1000 by name
    writeFileSync(join(dir, 'feed.jsonl'), `${line(2000, 'TrackStatus')}\n`);
    const input = await readInput(dir, new Set(TOPICS));
    expect(input?.events.map((e) => [e.t, e.topic])).toEqual([
      [999, 'Heartbeat'],
      [1000, 'TimingData'],
      [1001, 'LapCount'],
      [2000, 'TrackStatus'],
    ]);
    expect(input?.archiveDir).toBeUndefined();
  });

  it('refuses under CI and without inputs', async () => {
    const lines: string[] = [];
    expect(await compare(['x'], { CI: 'true' }, (l) => lines.push(l))).toBe(1);
    expect(await compare([], {}, (l) => lines.push(l))).toBe(64);
    expect(lines[0]).toBe('compare-laps refuses to run under CI (A§12.1 invariant 4)');
  });
});

describe('reconnectCheck (#223): the typed state at each reconnect against the archive', () => {
  // Synthetic: the archive holds every message; the recording lost one in the gap and got the state after it.
  const td = (t: number, line: Record<string, unknown>, r?: number): FeedEvent => ({
    t,
    topic: 'TimingData',
    payload: { Lines: { '7': line } },
    ...(r === undefined ? {} : { r }),
  });
  const state = (r: number, line: Record<string, unknown>): FeedEvent => ({
    ...td(r, { ...line, _kf: true }, r),
    full: true,
  });
  const archive = [
    td(1_000, { GapToLeader: '+1.0', NumberOfLaps: 3 }),
    td(4_000, { GapToLeader: '+1.5' }),
    td(5_000, { GapToLeader: '+2.0' }),
    td(6_000, { NumberOfLaps: 4 }),
    td(9_000, { GapToLeader: '+2.5' }),
  ];

  it('a state older than the delta just before it: wrong without the fold, right with it', () => {
    const live = [
      td(1_000, { GapToLeader: '+1.0', NumberOfLaps: 3 }, 2_000),
      td(6_000, { NumberOfLaps: 4 }, 7_999), // the new connection's, 1 ms before its state
      state(8_000, { GapToLeader: '+2.0', NumberOfLaps: 3 }), // taken between 5 000 and 6 000
      td(9_000, { GapToLeader: '+2.5' }, 10_000),
    ];
    const found = reconnectCheck(live, archive);
    expect(found).toEqual([{ window: 1, folded: 0, raw: 1, foldedWindow: 0, rawWindow: 1, paths: {} }]);
    expect(reconnectLines(found).lines).toEqual([
      '  reconnect 1: window 1 leaves; differ from the archive: folded 0 (window 0), without the fold 1 (window 1)',
      'reconnects 1: window leaves wrong after the state 0: PASS',
    ]);
  });

  it('a delta older than the state put on top by the fold fails the check', () => {
    const live = [
      td(1_000, { GapToLeader: '+1.0', NumberOfLaps: 3 }, 2_000),
      td(4_000, { GapToLeader: '+1.5' }, 7_999), // older than the state, which already holds 5 000's value
      state(8_000, { GapToLeader: '+2.0', NumberOfLaps: 4 }),
      td(9_000, { GapToLeader: '+2.5' }, 10_000),
    ];
    const found = reconnectCheck(live, archive);
    expect(found).toEqual([
      { window: 1, folded: 1, raw: 0, foldedWindow: 1, rawWindow: 0, paths: { '.Lines.#.GapToLeader': 1 } },
    ]);
    expect(reconnectLines(found)).toEqual({
      lines: [
        '  reconnect 1: window 1 leaves; differ from the archive: folded 1 (window 1), without the fold 0 (window 0); .Lines.#.GapToLeader 1',
        'reconnects 1: window leaves wrong after the state 1: FAIL',
      ],
      pass: false,
    });
  });

  it('checks no first connect (no delta before it)', () => {
    expect(reconnectCheck([state(500, { GapToLeader: '+1.0', NumberOfLaps: 3 })], archive)).toEqual([]);
  });

  it('compare prints it when a recording and the archive of its session are both given', async () => {
    // The archive form of the synthetic practice feed, as live-laps.test.ts writes it, against practice-reconnect.
    const live = join(import.meta.dirname, '../apps/server/test/fixtures/live');
    const events = ((await readInput(join(live, 'practice.jsonl'), new Set(TOPICS))) as Input).events;
    const t0 = (events[0] as FeedEvent).t;
    const files = new Map<string, string>();
    for (const ev of events) {
      const at = `${new Date(ev.t - t0).toISOString().slice(11, 23)}${JSON.stringify(ev.payload)}\r\n`;
      files.set(ev.topic, (files.get(ev.topic) ?? '\uFEFF') + at);
    }
    expect(parseJsonStream(files.get('Heartbeat') ?? '', 'Heartbeat', 0).events.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'f1-compare-archive-'));
    for (const [topic, text] of files) writeFileSync(join(dir, `${topic}.jsonStream`), text);
    const recording = join(live, 'practice-reconnect.jsonl');
    const { rows } = reconstruct(events, 'f1-live');
    const lines: string[] = [];
    const exit = await compare(
      [recording, dir],
      {},
      (l) => lines.push(l),
      async () => rows as NonNullable<typeof rows>,
    );
    expect(lines).toContain(`== reconnects of ${recording} against ${dir}`);
    expect(lines.at(-1)).toBe('reconnects 1: window leaves wrong after the state 0: PASS');
    expect(exit).toBe(0);
  });
});

describe('compare: the [box] verdict on the synthetic practice feed', () => {
  // apps/server/test/fixtures/live/ is synthetic: every value is invented.
  const PRACTICE = join(import.meta.dirname, '../apps/server/test/fixtures/live/practice.jsonl');
  const run = async (oracle: Oracle, feed = PRACTICE) => {
    const lines: string[] = [];
    return { exit: await compare([feed], {}, (l) => lines.push(l), oracle), lines };
  };
  const ours = async () => {
    const { rows } = reconstruct(((await readInput(PRACTICE, new Set(TOPICS))) as Input).events, 'f1-live');
    return rows as NonNullable<typeof rows>;
  };

  it('passes at 99% or more with exit 0', async () => {
    const { laps, stints } = await ours();
    const asked: unknown[] = [];
    const { exit, lines } = await run(async (key, type) => {
      asked.push(key, type);
      return { laps, stints };
    });
    expect(asked).toEqual([9001, 'Practice']);
    expect(lines).toContain('matched 10 of 10 (100.00%): PASS');
    expect(exit).toBe(0);
  });

  it('fails below 99% with exit 1', async () => {
    const { laps, stints } = await ours();
    const off = laps.map((l, i) => (i === 0 ? { ...l, lap_ms: 1 } : l));
    const { exit, lines } = await run(async () => ({ laps: off, stints }));
    expect(lines).toContain('matched 9 of 10 (90.00%): FAIL');
    expect(exit).toBe(1);
  });

  it('exits 1 on an oracle failure and prints its code', async () => {
    const { exit, lines } = await run(async () => JSON.stringify({ code: 'http', status: 401 }));
    expect(lines.at(-1)).toBe('compare-laps: openf1 {"code":"http","status":401}');
    expect(exit).toBe(1);
  });

  it('prints the feed session type as printable ASCII only', async () => {
    const feed = join(mkdtempSync(join(tmpdir(), 'f1-compare-')), 'feed.jsonl');
    const type = JSON.stringify([1768046400000, 'SessionInfo', { Type: '\u001b[2J' }, null]);
    writeFileSync(feed, `${readFileSync(PRACTICE, 'utf8')}\n${type}\n`);
    const { lines } = await run(async () => 'shape', feed);
    expect(lines).toContain('session 9001 type ?[2J');
  });
});
