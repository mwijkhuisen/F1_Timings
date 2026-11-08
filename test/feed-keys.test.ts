import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { census, feedKeys, keyPaths } from '../scripts/feed-keys.ts';

// Synthetic feeds only: every key and value below is invented, in the feed's format (A§11.2, A§6.2).

describe('keyPaths', () => {
  it('names every leaf and empty container, with numeric keys and array indices as #', () => {
    const paths = keyPaths({
      Lines: { '1': { GapToLeader: '+1.0', Stats: [{ TimeDiffToFastest: '' }, {}] }, '44': { Line: 2 } },
      NoEntries: [20, 15, 10],
      Withheld: false,
      Empty: {},
    });
    expect([...paths].sort()).toEqual([
      'Empty',
      'Lines.#.GapToLeader',
      'Lines.#.Line',
      'Lines.#.Stats.#',
      'Lines.#.Stats.#.TimeDiffToFastest',
      'NoEntries.#',
      'Withheld',
    ]);
  });

  it('has no path for a payload that is no object, and stops at 32 levels', () => {
    expect(keyPaths('a .z payload').size).toBe(0);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { k: deep };
    expect([...keyPaths(deep)]).toEqual([Array(32).fill('k').join('.')]);
  });
});

const line = (...v: unknown[]) => JSON.stringify(v);
// A recording joined before a practice session: the Subscribe state still shows the previous race, then the switch.
const RECORDING = [
  line(1_000, '_subscribe', {
    SessionInfo: { Key: 8999, Type: 'Race' },
    TimingData: { Lines: { '7': { GapToLeader: '+7.654', IntervalToPositionAhead: { Value: '+7.654' } } } },
  }),
  line(2_000, 'TimingData', { Lines: { '7': { GapToLeader: '+7.655' } } }, '2026-01-10T11:00:02.000Z'),
  line(3_000, 'SessionInfo', { Key: 9001, Type: 'Practice' }, '2026-01-10T11:00:03.000Z'),
  line(4_000, 'TimingData', { Lines: { '7': { TimeDiffToFastest: '+0.321' } } }, '2026-01-10T11:00:04.000Z'),
  line(5_000, 'TimingData', { Lines: { '7': { TimeDiffToFastest: '', TimeDiffToPositionAhead: '' } } }, null),
].join('\n');

describe('census', () => {
  it('groups a recording by the SessionInfo in force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-keys-'));
    writeFileSync(join(dir, 'feed.jsonl'), `${RECORDING}\n`);
    const lines: string[] = [];
    expect(await feedKeys([dir], (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([
      `== ${dir}`,
      'events 6, skipped lines 0',
      'session 8999 Race: TimingData 2 messages',
      '  Lines.#.GapToLeader 2',
      '  Lines.#.IntervalToPositionAhead.Value 1',
      'session 9001 Practice: TimingData 2 messages',
      '  Lines.#.TimeDiffToFastest 2',
      '  Lines.#.TimeDiffToPositionAhead 1',
    ]);
    // Key names and counts only: no value reaches the output.
    expect(lines.join('\n')).not.toMatch(/\+\d\.\d{3}/);
  });

  it('counts another topic with --topic', async () => {
    const feed = join(mkdtempSync(join(tmpdir(), 'f1-keys-')), 'feed.jsonl');
    writeFileSync(feed, RECORDING);
    const lines: string[] = [];
    expect(await feedKeys(['--topic', 'SessionInfo', feed], (l) => lines.push(l))).toBe(0);
    expect(lines.slice(2)).toEqual([
      'session 8999 Race: SessionInfo 1 messages',
      '  Key 1',
      '  Type 1',
      'session 9001 Practice: SessionInfo 1 messages',
      '  Key 1',
      '  Type 1',
    ]);
  });

  it('takes an archive as one session, the one its SessionInfo names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-keys-'));
    writeFileSync(join(dir, 'Heartbeat.jsonStream'), '﻿00:00:01.000{"Utc":"2026-01-10T12:00:01.000Z"}\r\n');
    writeFileSync(join(dir, 'SessionInfo.jsonStream'), '﻿00:00:02.000{"Key":9002,"Type":"Qualifying"}\r\n');
    writeFileSync(
      join(dir, 'TimingData.jsonStream'),
      '﻿00:00:00.500{"SessionPart":0,"NoEntries":[20,15,10],"Lines":{"7":{"Stats":[{"TimeDiffToFastest":""}]}}}\r\n' +
        '00:00:03.000{"SessionPart":1,"Lines":{"7":{"Stats":{"0":{"TimeDifftoPositionAhead":"+0.100"}}}}}\r\n',
    );
    const lines: string[] = [];
    expect(await feedKeys([dir], (l) => lines.push(l))).toBe(0);
    expect(lines.slice(2)).toEqual([
      'session 9002 Qualifying: TimingData 2 messages',
      '  Lines.#.Stats.#.TimeDiffToFastest 1',
      '  Lines.#.Stats.#.TimeDifftoPositionAhead 1',
      '  NoEntries.# 1',
      '  SessionPart 2',
    ]);
  });

  it('prints keys as printable ASCII only, and says when the topic is absent', async () => {
    const feed = join(mkdtempSync(join(tmpdir(), 'f1-keys-')), 'feed.jsonl');
    writeFileSync(feed, line(1_000, 'TimingData', { 'a\u001b[2J': 1 }, null));
    const lines: string[] = [];
    expect(await feedKeys([feed, '--topic', 'LapCount', feed], (l) => lines.push(l))).toBe(0);
    expect(lines.slice(2)).toEqual([
      'no LapCount messages',
      `== ${feed}`,
      'events 1, skipped lines 0',
      'no LapCount messages',
    ]);
    const events = [{ t: 1, topic: 'TimingData', payload: { 'a\u001b[2J': 1 } }];
    expect([...(census(events, 'TimingData', false).get('? ?')?.paths.keys() ?? [])]).toEqual(['a\u001b[2J']);
    const printed: string[] = [];
    await feedKeys([feed], (l) => printed.push(l));
    expect(printed.slice(2)).toEqual(['session ? ?: TimingData 1 messages', '  a?[2J 1']);
  });

  it('lists the codes per key path with --codes, and a message text as <text>', async () => {
    const feed = join(mkdtempSync(join(tmpdir(), 'f1-keys-')), 'feed.jsonl');
    writeFileSync(
      feed,
      [
        line(1_000, 'TrackStatus', { Status: '1', Message: 'AllClear' }, null),
        line(2_000, 'TrackStatus', { Status: '4', Message: 'SCDeployed' }, null),
        line(3_000, 'TrackStatus', { Status: '1', Message: 'AllClear' }, null),
        line(4_000, 'RaceControlMessages', {
          Messages: [{ Utc: '2026-01-10T11:00:04', Lap: 3, Category: 'Other', Message: 'CAR 7 (XYZ) TIME DELETED' }],
        }),
      ].join('\n'),
    );
    const lines: string[] = [];
    expect(await feedKeys(['--topic', 'TrackStatus', '--codes', feed], (l) => lines.push(l))).toBe(0);
    expect(lines.slice(2)).toEqual([
      'session ? ?: TrackStatus 3 messages',
      '  Message 3',
      '    = AllClear 2',
      '    = SCDeployed 1',
      '  Status 3',
      '    = 1 2',
      '    = 4 1',
    ]);
    const rc: string[] = [];
    expect(await feedKeys(['--codes', '--topic', 'RaceControlMessages', feed], (l) => rc.push(l))).toBe(0);
    // A real message (spaces) is <text>; Lap and Utc are no status-like keys, so they print no value.
    expect(rc.slice(2)).toEqual([
      'session ? ?: RaceControlMessages 1 messages',
      '  Messages.#.Category 1',
      '    = Other 1',
      '  Messages.#.Lap 1',
      '  Messages.#.Message 1',
      '    = <text> 1',
      '  Messages.#.Utc 1',
    ]);
    // Without --codes, no value prints.
    const plain: string[] = [];
    await feedKeys(['--topic', 'TrackStatus', feed], (l) => plain.push(l));
    expect(plain.slice(2)).toEqual(['session ? ?: TrackStatus 3 messages', '  Message 3', '  Status 3']);
    // No --codes, no values collected.
    const events = [{ t: 1, topic: 'TrackStatus', payload: { Status: '1' } }];
    expect(census(events, 'TrackStatus', false).get('? ?')?.codes.size).toBe(0);
  });

  it('prints no value with --codes for keys that are not status-like (DriverList, TimingData)', async () => {
    const feed = join(mkdtempSync(join(tmpdir(), 'f1-keys-')), 'feed.jsonl');
    writeFileSync(
      feed,
      [
        line(1_000, 'DriverList', { '4': { FirstName: 'Lando', Tla: 'NOR', RacingNumber: '4', TeamColour: 'FF8000' } }),
        line(2_000, 'TimingData', {
          Lines: { '4': { Position: '1', NumberOfLaps: 12, Sectors: { '0': { Value: '30.1' } } } },
        }),
      ].join('\n'),
    );
    for (const topic of ['DriverList', 'TimingData']) {
      const lines: string[] = [];
      expect(await feedKeys(['--codes', '--topic', topic, feed], (l) => lines.push(l))).toBe(0);
      expect(lines.slice(2).filter((l) => l.startsWith('    ='))).toEqual([]);
      expect(lines.join('\n')).not.toMatch(/Lando|NOR|FF8000|30\.1/);
    }
  });

  it('exits 64 without an input and 1 on an unreadable one', async () => {
    const lines: string[] = [];
    expect(await feedKeys([], (l) => lines.push(l))).toBe(64);
    expect(await feedKeys(['--nope'], (l) => lines.push(l))).toBe(64);
    expect(await feedKeys([join(tmpdir(), 'f1-keys-missing', 'feed.jsonl')], (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toMatch(
      /^usage: feed-keys\.ts \[--topic <name>\] \[--codes\] <feed\.jsonl \| recording dir \| archive dir>…\n/,
    );
    expect(lines[0]).toContain('status-like keys only (Status, Started, Message, Category, Flag, Mode, Scope)');
    expect(lines.at(-1)).toBe('feed-keys: input (unreadable, or an archive without a Heartbeat t0)');
  });
});
