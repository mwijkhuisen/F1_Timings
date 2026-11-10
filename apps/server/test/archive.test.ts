import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveEvents, readStreams } from '../src/archive/files.ts';
import { archiveRows, gmtOffset, indexPlan } from '../src/archive/rows.ts';
import { archiveT0, type FeedEvent } from '../src/live/read.ts';

// fixtures/archive/ is synthetic and hand-written: every name, time and value is invented (A§12.1 invariant 3).
const FIXTURES = join(import.meta.dirname, 'fixtures/archive');
const streams = (dir: string) => readStreams(join(FIXTURES, dir));
const INDEX = readFileSync(join(FIXTURES, 'index-2019.json'), 'utf8');

const T0 = Date.parse('2019-03-17T05:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const sd = (t: number, payload: unknown): FeedEvent => ({ t, topic: 'SessionData', payload });
const hb = (t: number, utc: string): FeedEvent => ({ t, topic: 'Heartbeat', payload: { Utc: utc } });

describe('archiveT0', () => {
  it('takes the most frequent Utc − t of SessionData entries, list and dict forms, over the first-line outlier', () => {
    const data = [
      // The first line: a list of older entries, at the line's own time.
      sd(1000, { Series: [], StatusSeries: [{ Utc: at(-60_000), TrackStatus: 'AllClear' }] }),
      sd(5000, { StatusSeries: { 1: { Utc: at(5000), SessionStatus: 'Started' } } }),
      // Without a Z, as UTC.
      sd(9000, { Series: { 0: { Utc: at(9000).slice(0, -1), QualifyingPart: 1 } } }),
    ];
    const heartbeat = [hb(500, at(2500))]; // about 2 s late
    expect(archiveT0(heartbeat, data)).toEqual({ t0: T0, from: 'sessiondata' });
  });

  it('falls back to the first Heartbeat when fewer than 2 entries agree', () => {
    const heartbeat = [hb(0, 'soon'), hb(500, at(2500))];
    expect(archiveT0(heartbeat, [sd(5000, { StatusSeries: { 1: { Utc: at(5000) } } })])).toEqual({
      t0: T0 + 2000,
      from: 'heartbeat',
    });
    expect(archiveT0(heartbeat)).toEqual({ t0: T0 + 2000, from: 'heartbeat' });
    expect(archiveT0([], [sd(1, { Series: { 0: { Utc: 'x' } } })])).toBeUndefined();
  });

  it('breaks a tie by the value seen first', () => {
    const tie = [sd(1000, { Series: { 0: { Utc: at(1000) } } }), sd(2000, { Series: { 0: { Utc: at(2000) } } })];
    const later = [sd(3000, { Series: { 0: { Utc: at(3005) } } }), sd(4000, { Series: { 0: { Utc: at(4005) } } })];
    expect(archiveT0([], [...tie, ...later])).toEqual({ t0: T0, from: 'sessiondata' });
    expect(archiveT0([], [...later, ...tie])).toEqual({ t0: T0 + 5, from: 'sessiondata' });
  });
});

describe('archiveEvents', () => {
  it('puts SessionInfo first at an equal t, else keeps topic-name order', () => {
    const files = new Map([
      ['Heartbeat', `﻿00:00:01.000{"Utc":"${at(1000)}"}\r\n`],
      ['RaceControlMessages', '﻿00:00:02.000{"Messages":[]}\r\n'],
      ['SessionData', '﻿00:00:02.000{"Series":[]}\r\n'],
      ['SessionInfo', '﻿00:00:02.000{"Key":1}\r\n'],
    ]);
    const got = archiveEvents(files);
    expect(got?.events.map((e) => [e.topic, e.t - T0])).toEqual([
      ['Heartbeat', 1000],
      ['SessionInfo', 2000],
      ['RaceControlMessages', 2000],
      ['SessionData', 2000],
    ]);
    expect(got).toMatchObject({ t0: T0, from: 'heartbeat', heartbeat: T0, skipped: 0 });
    expect(archiveEvents(new Map([['TimingData', '00:00:01.000{}']]))).toBeUndefined();
  });
});

const built = (files: ReadonlyMap<string, string>, key: number, type: string) => {
  const got = archiveRows(files, key, type);
  if (!got.ok) throw new Error(got.error);
  return got.value;
};
type LapLike = Record<string, unknown>;
const pick = (rows: readonly LapLike[], keys: readonly string[]) => rows.map((r) => keys.map((k) => r[k]));

describe('archiveRows: the race', () => {
  const race = built(streams('race'), 9102, 'Race');

  it('times the session on the SessionData t0, 2 s before the Heartbeat one', () => {
    expect(race.stats).toEqual({
      t0: 'sessiondata',
      t0_heartbeat_delta_ms: -2000,
      phases: 0,
      rules: { deleted: 0, reinstated: 0, unmatched: 0, unparsed: 0 },
      skipped_lines: 0,
    });
  });

  it('builds the laps: lap 1 from the Started Utc to lap 2 at the corrected t0, the pit stop, no lap after the flag', () => {
    const keys = [
      'driver_number',
      'lap_number',
      'date_start',
      'lap_ms',
      's1_ms',
      's2_ms',
      's3_ms',
      'is_pit_out',
      'is_pit_in',
    ];
    expect(pick(race.rows.lap, keys)).toEqual([
      [3, 1, '2019-03-17T05:10:00.000Z', 95000, 30000, 34000, 31000, false, false],
      [3, 2, '2019-03-17T05:11:35.000Z', 92000, 29800, 33900, 28300, false, false],
      [3, 3, '2019-03-17T05:13:07.000Z', 92000, 30100, 33500, 28400, false, false],
      // No S1 on lap 1: the lap is lap 2's start minus the Started Utc, S1 the rest.
      [8, 1, '2019-03-17T05:10:00.000Z', 96500, 31000, 34500, 31000, false, false],
      [8, 2, '2019-03-17T05:11:36.500Z', 100000, 30000, 34000, 36000, false, true],
      [8, 3, '2019-03-17T05:13:16.500Z', 116000, 52000, 34200, 29800, true, false],
    ]);
    expect(race.rows.lap.every((l) => l.source === 'f1-archive' && !('at' in l) && l.quali_phase === null)).toBe(true);
    expect(pick(race.rows.stint, ['driver_number', 'stint_number', 'lap_start', 'lap_end', 'compound'])).toEqual([
      [3, 1, 1, 3, 'MEDIUM'],
      [8, 1, 1, 2, 'SOFT'],
      [8, 2, 3, 3, 'HARD'],
    ]);
  });

  it('on the Heartbeat t0 instead, lap 1 would be 2 s too long (limit B)', () => {
    const files = new Map(streams('race'));
    // One SessionData entry only: no two agree, so the Heartbeat gives t0.
    files.set(
      'SessionData',
      '23:50:00.000{"StatusSeries":{"1":{"Utc":"2019-03-17T05:10:00","SessionStatus":"Started"}}}',
    );
    const fallback = built(files, 9102, 'Race');
    expect(fallback.stats.t0).toBe('heartbeat');
    expect(fallback.rows.lap.find((l) => l.driver_number === 8 && l.lap_number === 1)?.lap_ms).toBe(98500);
  });

  it('maps race control, drivers, results and one weather row per WeatherData line, the day-count line included', () => {
    expect(
      race.rows.race_control.map((m) => [m.date, m.flag, m.driver_number, m.lap_number, m.qualifying_phase]),
    ).toEqual([
      ['2019-03-17T05:05:00.000Z', 'GREEN', null, null, null],
      ['2019-03-17T05:12:30.000Z', 'BLUE', 8, 2, null],
      ['2019-03-17T05:14:37.000Z', 'CHEQUERED', null, 3, null],
    ]);
    expect(race.rows.driver).toEqual([
      {
        session_key: 9102,
        source: 'f1-archive',
        driver_number: 3,
        acronym: 'AAA',
        full_name: 'Ann ALPHA',
        team_name: 'Team One',
        team_colour: '3366CC',
      },
      {
        session_key: 9102,
        source: 'f1-archive',
        driver_number: 8,
        acronym: 'BBB',
        full_name: 'Ben BRAVO',
        team_name: 'Team Two',
        team_colour: 'CC6633',
      },
    ]);
    expect(pick(race.rows.result, ['driver_number', 'position', 'laps', 'dnf', 'durations_ms'])).toEqual([
      [3, 1, 3, null, null],
      [8, 2, 3, null, null],
    ]);
    expect(pick(race.rows.weather, ['date', 'air_temperature', 'rainfall', 'wind_speed'])).toEqual([
      ['2019-03-17T05:05:00.000Z', 24.1, 0, 2.1],
      ['2019-03-17T05:12:00.000Z', 24.3, 0, 2.1],
      ['2019-03-17T05:20:30.000Z', 24.3, 1, 3.4],
    ]);
  });

  it('refuses a session without SessionInfo or TimingData, and another session key', () => {
    for (const topic of ['SessionInfo', 'TimingData']) {
      const files = new Map(streams('race'));
      files.delete(topic);
      expect(archiveRows(files, 9102, 'Race')).toEqual({ ok: false, error: 'incomplete' });
    }
    expect(
      archiveRows(
        new Map([
          ['SessionInfo', '00:00:00.000{}'],
          ['TimingData', ''],
        ]),
        9102,
        'Race',
      ),
    ).toEqual({
      ok: false,
      error: 'incomplete', // no t0
    });
    expect(archiveRows(streams('race'), 9101, 'Race')).toEqual({ ok: false, error: 'key_mismatch' });
  });
});

describe('archiveRows: the qualifying', () => {
  const quali = built(streams('quali'), 9101, 'Qualifying');

  it('takes the phases from SessionData QualifyingPart and deletes the lap a message names', () => {
    expect(quali.stats).toMatchObject({ t0: 'sessiondata', t0_heartbeat_delta_ms: null, phases: 2 });
    expect(quali.stats.rules).toEqual({ deleted: 1, reinstated: 0, unmatched: 0, unparsed: 0 });
    const keys = ['driver_number', 'lap_number', 'lap_ms', 'deleted', 'deleted_reason', 'quali_phase'];
    expect(pick(quali.rows.lap, keys)).toEqual([
      [3, 1, null, false, null, 1],
      [3, 2, 85000, false, null, 1],
      [3, 3, null, false, null, 1],
      [3, 4, null, false, null, 2],
      [3, 5, 84700, false, null, 2],
      [3, 6, null, false, null, 2],
      [8, 1, null, false, null, 1],
      [8, 2, 86000, true, 'TRACK LIMITS AT TURN 4', 1],
      [8, 3, 85700, false, null, 1],
      [8, 4, null, false, null, 1],
    ]);
    expect(quali.rows.race_control.map((m) => m.qualifying_phase)).toEqual([null, 1, 2]);
    expect(pick(quali.rows.result, ['driver_number', 'position', 'laps'])).toEqual([
      [3, 1, 6],
      [8, 2, 4],
    ]);
  });
});

describe('indexPlan', () => {
  it('gives the meeting and session rows, in UTC from GmtOffset, the meeting spanning its sessions', () => {
    const plan = indexPlan(INDEX, 2019);
    expect(plan?.badPath).toEqual([]);
    expect(plan?.badIndex).toBe(0);
    expect(plan?.sessions.map((s) => [s.key, s.type, s.session.date_start, s.session.date_end])).toEqual([
      [9101, 'Qualifying', '2019-03-16T06:00:00.000Z', '2019-03-16T07:00:00.000Z'],
      [9102, 'Race', '2019-03-17T05:10:00.000Z', '2019-03-17T07:10:00.000Z'],
      [9111, 'Practice', '2019-03-29T15:00:00.000Z', '2019-03-29T16:00:00.000Z'],
    ]);
    expect(plan?.sessions[1]?.meeting).toEqual({
      meeting_key: 9100,
      source: 'f1-archive',
      year: 2019,
      name: 'Synthetic Grand Prix',
      official_name: 'FORMULA 1 SYNTHETIC GRAND PRIX 2019',
      location: 'Nowhere',
      country_code: 'SYN',
      circuit_short_name: 'Nowhere',
      gmt_offset: '11:00:00',
      date_start: '2019-03-16T06:00:00.000Z',
      date_end: '2019-03-17T07:10:00.000Z',
      is_cancelled: false,
    });
    expect(plan?.sessions[2]?.meeting.gmt_offset).toBe('-05:00:00');
    expect(plan?.sessions[1]?.session).toMatchObject({ ingest_state: 'final', next_fetch_at: null, fetch_count: 1 });
  });

  it('counts a path outside the year or no archive path, and a session without a key or dates', () => {
    const session = (Key: unknown, Path: string, StartDate = '2019-03-16T17:00:00') => ({
      Key,
      Type: 'Race',
      Name: 'Race',
      StartDate,
      EndDate: '2019-03-16T18:00:00',
      GmtOffset: '00:00:00',
      Path,
    });
    const text = JSON.stringify({
      Meetings: [
        {
          Key: 1,
          Sessions: [
            session(1, '2019/a/b/'),
            session(2, '2018/a/b/'),
            session(3, '2019/../b/'),
            session('x', '2019/a/c/'),
            session(5, '2019/a/d/', '2019-03-16T17:00:00Z'),
          ],
        },
      ],
    });
    const plan = indexPlan(text, 2019);
    expect(plan?.sessions.map((s) => s.key)).toEqual([1]);
    expect(plan?.badPath).toEqual([2, 3]);
    expect(plan?.badIndex).toBe(2);
    expect(indexPlan('nope', 2019)).toBeUndefined();
  });

  it('normalises a GmtOffset to [-]HH:MM:SS', () => {
    expect(gmtOffset('+01:00:00')).toEqual({ text: '01:00:00', ms: 3_600_000 });
    expect(gmtOffset('-4:30')).toEqual({ text: '-04:30:00', ms: -16_200_000 });
    expect(gmtOffset('00:00:00')).toEqual({ text: '00:00:00', ms: 0 });
    expect(gmtOffset('1 hour')).toBeUndefined();
  });
});
