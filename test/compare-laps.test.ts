import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const input = await readInput(dir);
    const t0 = Date.parse('2026-10-30T10:00:00.000Z');
    expect(input?.events.map((e) => [e.topic, e.t - t0])).toEqual([
      ['TimingData', 500],
      ['Heartbeat', 1000],
      ['TimingData', 5000],
    ]);
    expect(await readInput(join(dir, 'missing'))).toBeUndefined();
  });

  it('refuses under CI and without inputs', async () => {
    const lines: string[] = [];
    expect(await compare(['x'], { CI: 'true' }, (l) => lines.push(l))).toBe(1);
    expect(await compare([], {}, (l) => lines.push(l))).toBe(64);
    expect(lines[0]).toBe('compare-laps refuses to run under CI (A§12.1 invariant 4)');
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
    const { rows } = reconstruct(((await readInput(PRACTICE)) as Input).events, 'f1-live');
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
