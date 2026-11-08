import type { Obj } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import { lastStop, markersUpTo, skipped, skippedText, statusSeries } from '../src/lib/replay.ts';
import type { Feed } from '../src/lib/stream.ts';
import { fmtClock, parseT } from '../src/lib/time.ts';
import { lap } from './laps.ts';

// The player's pure helpers (A§13, P4e): markers and chips at or before T, the last stop, the skipped events and ?t.

const at = (iso: string) => Date.parse(iso);
const ALL = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const;
/** A state whose SessionData.StatusSeries holds these entries, keyed 0, 1, … */
const seriesState = (entries: Obj[]): Obj => ({
  SessionData: { StatusSeries: Object.fromEntries(entries.map((e, i) => [String(i), e])) },
});
const series = (entries: Obj[]) => statusSeries(seriesState(entries));

describe('statusSeries', () => {
  it('parses each entry once, sorted, and drops one without a usable Utc', () => {
    expect(
      series([
        { Utc: '2026-10-25T20:05:00.000Z', SessionStatus: 'Started' },
        { Utc: '2026-10-25T20:00:00', TrackStatus: 'AllClear' },
        { Utc: 'yesterday', TrackStatus: 'Red' },
        { TrackStatus: 'Red' },
      ]),
    ).toEqual([
      { t: at('2026-10-25T20:00:00Z'), track: 'AllClear', session: undefined },
      { t: at('2026-10-25T20:05:00Z'), track: undefined, session: 'Started' },
    ]);
    expect(statusSeries({})).toEqual([]);
  });
});

describe('markersUpTo', () => {
  it('a start is not the 2 s blip; a TrackStatus-only entry does not end it; Finished is the chequered flag', () => {
    const s = series([
      { Utc: '2026-10-25T20:00:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:00:02', SessionStatus: 'Inactive' }, // A§11.1: a `Started` that lasted 2 s
      { Utc: '2026-10-25T20:05:00.000Z', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:05:50', TrackStatus: 'Yellow' },
      { Utc: '2026-10-25T21:30:00', SessionStatus: 'Finished' },
    ]);
    expect(markersUpTo(s, at('2026-10-25T22:00:00Z'), ALL)).toEqual([
      { kind: 'start', t: at('2026-10-25T20:05:00Z') },
      { kind: 'chequered', t: at('2026-10-25T21:30:00Z') },
    ]);
  });

  // The 2026 race's shape (A§11.3): its TrackStatus clears 2 min after the red flag, the restart comes 39 min later.
  const race = series([
    { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
    { Utc: '2026-10-25T20:10:00', TrackStatus: 'SCDeployed' },
    { Utc: '2026-10-25T20:12:00', SessionStatus: 'Aborted' },
    { Utc: '2026-10-25T20:12:05', TrackStatus: 'Red' },
    { Utc: '2026-10-25T20:14:05', TrackStatus: 'AllClear' },
    { Utc: '2026-10-25T20:20:00', TrackStatus: 'Yellow' },
    { Utc: '2026-10-25T20:21:00', TrackStatus: 'AllClear' },
    { Utc: '2026-10-25T20:53:05', SessionStatus: 'Started' },
    { Utc: '2026-10-25T20:53:10', TrackStatus: 'SCDeployed' },
    { Utc: '2026-10-25T21:00:00', TrackStatus: 'AllClear' },
  ]);

  it('the race: SC closes at Aborted, the red flag runs from Aborted to the restart, then the SC after it', () => {
    expect(markersUpTo(race, at('2026-10-25T22:00:00Z'), ALL)).toEqual([
      { kind: 'start', t: at('2026-10-25T20:00:00Z') },
      { kind: 'sc', t: at('2026-10-25T20:10:00Z'), end: at('2026-10-25T20:12:00Z') },
      { kind: 'red', t: at('2026-10-25T20:12:00Z'), end: at('2026-10-25T20:53:05Z') },
      { kind: 'start', t: at('2026-10-25T20:53:05Z') },
      { kind: 'sc', t: at('2026-10-25T20:53:10Z'), end: at('2026-10-25T21:00:00Z') },
    ]);
  });

  it('a red flag still in force at T is open, also after its TrackStatus cleared', () => {
    const T = at('2026-10-25T20:30:00Z');
    expect(markersUpTo(race, T, ALL)).toEqual([
      { kind: 'start', t: at('2026-10-25T20:00:00Z') },
      { kind: 'sc', t: at('2026-10-25T20:10:00Z'), end: at('2026-10-25T20:12:00Z') },
      { kind: 'red', t: at('2026-10-25T20:12:00Z'), end: T, open: true },
    ]);
  });

  it('a red flag without Aborted (practice) ends at the next TrackStatus outside Red', () => {
    const s = series([
      { Utc: '2026-10-25T20:10:00', TrackStatus: 'Red' },
      { Utc: '2026-10-25T20:25:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:30:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:32:00', TrackStatus: 'Red' },
      { Utc: '2026-10-25T20:40:00', TrackStatus: 'AllClear' },
    ]);
    expect(markersUpTo(s, at('2026-10-25T21:00:00Z'), ALL)).toEqual([
      { kind: 'red', t: at('2026-10-25T20:10:00Z'), end: at('2026-10-25T20:25:00Z') },
      { kind: 'sc', t: at('2026-10-25T20:30:00Z'), end: at('2026-10-25T20:32:00Z') },
      { kind: 'red', t: at('2026-10-25T20:32:00Z'), end: at('2026-10-25T20:40:00Z') },
    ]);
  });

  it('VSCEnding belongs to the VSC band, which closes at the next status outside it', () => {
    const s = series([
      { Utc: '2026-10-25T20:20:00', TrackStatus: 'VSCDeployed' },
      { Utc: '2026-10-25T20:22:00', TrackStatus: 'VSCEnding' },
      { Utc: '2026-10-25T20:22:30', TrackStatus: 'AllClear' },
    ]);
    expect(markersUpTo(s, at('2026-10-25T21:00:00Z'), ALL)).toEqual([
      { kind: 'vsc', t: at('2026-10-25T20:20:00Z'), end: at('2026-10-25T20:22:30Z') },
    ]);
  });

  it('a band still running at T is open and ends at T', () => {
    const s = series([
      { Utc: '2026-10-25T20:20:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:30:00', TrackStatus: 'AllClear' },
    ]);
    const T = at('2026-10-25T20:25:00Z');
    expect(markersUpTo(s, T, ALL)).toEqual([{ kind: 'sc', t: at('2026-10-25T20:20:00Z'), end: T, open: true }]);
  });

  it('draws nothing after T: a later entry neither shows nor closes a band early', () => {
    const s = series([
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:20:00', TrackStatus: 'VSCDeployed' },
      { Utc: '2026-10-25T20:40:00', TrackStatus: 'Red' },
      { Utc: '2026-10-25T21:30:00', SessionStatus: 'Finished' },
    ]);
    expect(markersUpTo(s, at('2026-10-25T19:59:59Z'), ALL)).toEqual([]);
    const T = at('2026-10-25T20:30:00Z');
    expect(markersUpTo(s, T, ALL)).toEqual([
      { kind: 'start', t: at('2026-10-25T20:00:00Z') },
      { kind: 'vsc', t: at('2026-10-25T20:20:00Z'), end: T, open: true },
    ]);
  });

  it('drops a mark that starts outside [lo, hi] and clips a band to hi', () => {
    const s = series([
      { Utc: '2026-10-24T17:32:52Z', SessionStatus: 'Started' }, // the day before
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:50:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T21:10:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T21:20:00', TrackStatus: 'Red' },
    ]);
    const span = [at('2026-10-25T19:00:00Z'), at('2026-10-25T21:00:00Z')] as const;
    expect(markersUpTo(s, at('2026-10-25T22:00:00Z'), span)).toEqual([
      { kind: 'start', t: at('2026-10-25T20:00:00Z') },
      { kind: 'sc', t: at('2026-10-25T20:50:00Z'), end: at('2026-10-25T21:00:00Z') },
    ]);
  });
});

describe('lastStop', () => {
  const laps = [
    lap(1, 1, { is_pit_out: true, date_start: '2026-10-25T20:00:00.000Z' }), // the start from the pit lane
    lap(1, 21, { is_pit_out: true, date_start: '2026-10-25T20:30:00.000Z' }),
    lap(1, 40, { is_pit_out: true, date_start: '2026-10-25T21:00:00.000Z' }),
    lap(1, 41, { date_start: '2026-10-25T21:01:30.000Z' }),
    lap(44, 30, { is_pit_out: true, date_start: '2026-10-25T20:45:00.000Z' }),
    lap(44, 31, { is_pit_out: true, date_start: null }),
  ];

  it("is the driver's latest pit-out lap at or before T, as the in-lap", () => {
    expect(lastStop(laps, 1, at('2026-10-25T20:59:59Z'))).toEqual({ t: at('2026-10-25T20:30:00Z'), lap: 20 });
    expect(lastStop(laps, 1, at('2026-10-25T21:00:00Z'))).toEqual({ t: at('2026-10-25T21:00:00Z'), lap: 39 });
    expect(lastStop(laps, 44, at('2026-10-25T22:00:00Z'))).toEqual({ t: at('2026-10-25T20:45:00Z'), lap: 29 });
  });

  it('is null before the first stop, for lap 1 and for another driver', () => {
    expect(lastStop(laps, 1, at('2026-10-25T20:29:59Z'))).toBeNull();
    expect(lastStop(laps, 44, at('2026-10-25T20:44:59Z'))).toBeNull();
    expect(lastStop(laps, 16, at('2026-10-25T22:00:00Z'))).toBeNull();
  });
});

describe('skipped', () => {
  const feed = (t: number, state: Obj, laps: ReturnType<typeof lap>[]): Feed => ({
    t,
    state,
    laps: new Map(laps.map((l) => [`${l.driver_number}:${l.lap_number}`, l])),
    stints: new Map(),
  });
  const OLD = at('2026-10-25T20:15:00Z');
  const NEW = at('2026-10-25T20:45:00Z');
  const msg = (Utc: string, Message: string) => ({ Utc, Category: 'Other', Message });
  const state: Obj = {
    ...seriesState([
      { Utc: '2026-10-25T20:10:00', TrackStatus: 'SCDeployed' }, // before the old T: not counted
      { Utc: '2026-10-25T20:14:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:20:00', TrackStatus: 'VSCDeployed' },
      { Utc: '2026-10-25T20:21:00', TrackStatus: 'VSCEnding' },
      { Utc: '2026-10-25T20:22:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:30:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:33:00', TrackStatus: 'Red' },
      { Utc: '2026-10-25T20:40:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:44:00', TrackStatus: 'SCDeployed' }, // still running at the new T: counted
      { Utc: '2026-10-25T20:50:00', TrackStatus: 'VSCDeployed' }, // after the new T: never counted
    ]),
    RaceControlMessages: {
      Messages: {
        '0': msg('2026-10-25T20:14:00', 'TURN 1 INCIDENT INVOLVING CARS 1 (VER) AND 44 (HAM) NOTED'),
        '1': msg('2026-10-25T20:25:00', 'TURN 4 INCIDENT INVOLVING CAR 16 (LEC) NOTED - CAUSING A COLLISION'),
        '2': msg('2026-10-25T20:26:00', 'TURN 4 INCIDENT INVOLVING CAR 16 (LEC) UNDER INVESTIGATION'),
        '3': msg('2026-10-25T20:45:00', 'TURN 9 INCIDENT INVOLVING CARS 4 (NOR) AND 81 (PIA) NOTED'),
        '4': msg('2026-10-25T20:50:00', 'TURN 2 INCIDENT INVOLVING CAR 55 (SAI) NOTED'),
      },
    },
  };
  const before = [
    lap(1, 10, { is_pit_out: true, date_start: '2026-10-25T20:10:00.000Z' }),
    lap(1, 12, { deleted: true }),
    lap(44, 14, {}),
  ];
  const after = [
    ...before.slice(0, 2),
    lap(44, 14, { deleted: true }), // deleted since: counted
    lap(16, 15, { deleted: true }), // new and deleted: counted
    lap(1, 20, { is_pit_out: true, date_start: '2026-10-25T20:31:00.000Z' }),
    lap(44, 21, { is_pit_out: true, date_start: '2026-10-25T20:45:00.000Z' }),
    lap(16, 1, { is_pit_out: true, date_start: '2026-10-25T20:20:00.000Z' }), // lap 1 is no stop
    lap(16, 30, { is_pit_out: true, date_start: '2026-10-25T20:46:00.000Z' }), // after the new T
  ];

  it('counts what happened in (old T, new T] only', () => {
    expect(skipped(feed(OLD, {}, before), feed(NEW, state, after))).toEqual({
      sc: 2,
      vsc: 1,
      red: 1,
      stops: 2,
      deleted: 2,
      incidents: 2,
    });
  });

  it('is null unless the new T is later', () => {
    expect(skipped(feed(NEW, state, after), feed(OLD, {}, before))).toBeNull();
    expect(skipped(feed(NEW, state, after), feed(NEW, state, after))).toBeNull();
  });

  it('skippedText lists the non-zero counts, singular or plural', () => {
    const none = { sc: 0, vsc: 0, red: 0, stops: 0, deleted: 0, incidents: 0 };
    expect(skippedText({ sc: 1, vsc: 1, red: 0, stops: 21, deleted: 1, incidents: 1 })).toBe(
      '1 SC · 1 VSC · 21 pit stops · 1 lap deleted · 1 incident noted',
    );
    expect(skippedText({ ...none, red: 2, stops: 1, deleted: 3, incidents: 2 })).toBe(
      '2 red flags · 1 pit stop · 3 laps deleted · 2 incidents noted',
    );
    expect(skippedText({ ...none, red: 1 })).toBe('1 red flag');
    expect(skippedText(none)).toBe('');
  });
});

describe('parseT', () => {
  const rec = (started_at: string, ended_at: string | null) => ({ started_at, ended_at });

  it('reads Amsterdam HH:mm:ss inside a recording across midnight (23:30–01:30)', () => {
    const r = rec('2026-11-07T22:30:00.000Z', '2026-11-08T00:30:00.000Z');
    expect(parseT('23:45:00', r)).toBe(at('2026-11-07T22:45:00Z'));
    expect(parseT('00:15:07', r)).toBe(at('2026-11-07T23:15:07Z'));
    expect(parseT('23:30:00', r)).toBe(at('2026-11-07T22:30:00Z'));
    expect(parseT('01:30:00', r)).toBe(at('2026-11-08T00:30:00Z'));
  });

  it('refuses anything but HH:mm:ss', () => {
    const r = rec('2026-11-07T00:00:00.000Z', '2026-11-07T23:59:59.000Z');
    for (const bad of ['abc', '25:00:00', '24:00:00', '21:44', '1:2:3', '21:60:00', '21:44:05 ', '', null])
      expect(parseT(bad, r)).toBeNull();
  });

  it('refuses a time outside the recording; an open one ends at now', () => {
    const r = rec('2026-11-07T22:30:00.000Z', '2026-11-08T00:30:00.000Z');
    expect(parseT('23:29:59', r)).toBeNull();
    expect(parseT('01:30:01', r)).toBeNull();
    expect(parseT('12:00:00', r)).toBeNull();
    const open = rec('2026-11-08T10:00:00.000Z', null);
    const now = at('2026-11-08T11:00:00Z');
    expect(parseT('11:30:00', open, now)).toBe(at('2026-11-08T10:30:00Z'));
    expect(parseT('12:00:00', open, now)).toBe(now);
    expect(parseT('12:00:01', open, now)).toBeNull();
  });

  it('the fall-back hour: null when both 02:30s fall inside, the one inside otherwise', () => {
    // 25 Oct 2026: 03:00 CEST becomes 02:00 CET at 01:00Z, so 02:30 is 00:30Z and 01:30Z.
    expect(parseT('02:30:00', rec('2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z'))).toBeNull();
    expect(parseT('02:30:00', rec('2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z'))).toBe(
      at('2026-10-25T01:30:00Z'),
    );
    expect(parseT('02:30:00', rec('2026-10-24T23:00:00.000Z', '2026-10-25T01:00:00.000Z'))).toBe(
      at('2026-10-25T00:30:00Z'),
    );
  });

  it('round-trips fmtClock for every whole second of a recording across midnight and a DST change', () => {
    // Spring forward (29 Mar): every second has one Amsterdam time. Fall back (25 Oct): 02:00–02:59:59 happens twice
    // inside this span (00:00Z–01:59:59Z), so those are null; every other second comes back as itself.
    for (const [from, to, twice] of [
      ['2026-03-28T22:00:00Z', '2026-03-29T03:00:00Z', []],
      ['2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', ['2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z']],
    ] as const) {
      const r = rec(from, to);
      const [a, b] = twice.map(at);
      for (let t = at(from); t <= at(to); t += 1000)
        expect(parseT(fmtClock(t), r)).toBe(a !== undefined && b !== undefined && t >= a && t < b ? null : t);
    }
  });

  it('the spring-forward gap: a time that never was is null', () => {
    // 29 Mar 2026: 02:00 CET becomes 03:00 CEST at 01:00Z.
    const r = rec('2026-03-29T00:00:00.000Z', '2026-03-29T03:00:00.000Z');
    expect(parseT('02:30:00', r)).toBeNull();
    expect(parseT('01:30:00', r)).toBe(at('2026-03-29T00:30:00Z'));
    expect(parseT('03:30:00', r)).toBe(at('2026-03-29T01:30:00Z'));
  });
});
