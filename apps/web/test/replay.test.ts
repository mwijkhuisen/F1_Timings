import type { Obj } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import {
  feedClock,
  feedRaceControl,
  lapPeriods,
  lastStop,
  markersUpTo,
  skipped,
  skippedEvents,
  skippedText,
  skippedWindow,
  statusSeries,
  tally,
} from '../src/lib/replay.ts';
import { type Feed, openStream } from '../src/lib/stream.ts';
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

// #112: the bands as the leader's laps for the player's Laps, Stints and Compare tabs, and the feed's race control.
describe('lapPeriods', () => {
  const T0 = at('2026-10-25T20:00:00Z');
  const hm = (s: string) => at(`2026-10-25T${s}Z`);
  /** The leader's laps 1…n, each 90 s, from 20:00:00: lap 3 starts 20:03:00, lap 6 20:07:30. */
  const leader = (n: number) =>
    Array.from({ length: n }, (_, i) => lap(1, i + 1, { date_start: new Date(T0 + i * 90_000).toISOString() }));
  const laps = leader(8);

  it('a closed SC runs from the leader’s lap at its start to the one at its end', () => {
    const s = series([
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:04:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:07:00', TrackStatus: 'AllClear' },
    ]);
    expect(lapPeriods(s, laps, hm('20:12:00'), T0, 'Race')).toEqual([{ kind: 'sc', from: 3, to: 5 }]);
  });

  it('an open SC ends at the leader’s lap at T, growing with it', () => {
    const s = series([{ Utc: '2026-10-25T20:04:00', TrackStatus: 'SCDeployed' }]);
    expect(lapPeriods(s, leader(4), hm('20:05:00'), T0, 'Race')).toEqual([{ kind: 'sc', from: 3, to: 4 }]);
    expect(lapPeriods(s, leader(6), hm('20:08:00'), T0, 'Race')).toEqual([{ kind: 'sc', from: 3, to: 6 }]);
    // Nothing after T: the series' later entry is not seen yet.
    const later = series([
      { Utc: '2026-10-25T20:04:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:20:00', TrackStatus: 'VSCDeployed' },
    ]);
    expect(lapPeriods(later, laps, hm('20:05:00'), T0, 'Race')).toEqual([{ kind: 'sc', from: 3, to: 4 }]);
  });

  it('drops a band that ended before lap 1 started, and starts one from before it at lap 1', () => {
    const s = series([
      { Utc: '2026-10-25T19:50:00', TrackStatus: 'VSCDeployed' },
      { Utc: '2026-10-25T19:55:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T19:58:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:02:00', TrackStatus: 'AllClear' },
    ]);
    expect(lapPeriods(s, laps, hm('20:12:00'), T0 - 3_600_000, 'Race')).toEqual([{ kind: 'sc', from: 1, to: 2 }]);
    // A band that starts before the recording (lo) is not drawn, as on the seek bar.
    expect(lapPeriods(s, laps, hm('20:12:00'), hm('19:59:00'), 'Race')).toEqual([]);
  });

  it('a red flag runs from Aborted to the lap before the restart’s; open, to the leader’s lap at T', () => {
    const s = series([
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:04:00', SessionStatus: 'Aborted' },
      { Utc: '2026-10-25T20:04:05', TrackStatus: 'Red' },
      { Utc: '2026-10-25T20:05:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:08:00', SessionStatus: 'Started' },
    ]);
    // The restart comes in the leader's lap 6, which is green (as trackPeriods closes red at n − 1).
    expect(lapPeriods(s, laps, hm('20:12:00'), T0, 'Race')).toEqual([{ kind: 'red', from: 3, to: 5 }]);
    // Still open at T, in the leader's lap 6: it runs to that lap.
    expect(lapPeriods(s, laps, hm('20:07:40'), T0, 'Race')).toEqual([{ kind: 'red', from: 3, to: 6 }]);
    // A restart in the red flag's own lap keeps that lap.
    const short = series([
      { Utc: '2026-10-25T20:03:10', SessionStatus: 'Aborted' },
      { Utc: '2026-10-25T20:04:00', SessionStatus: 'Started' },
    ]);
    expect(lapPeriods(short, laps, hm('20:12:00'), T0, 'Race')).toEqual([{ kind: 'red', from: 3, to: 3 }]);
  });

  it('merges a band into the previous one of its kind when it starts by that one’s end, so no two share a start', () => {
    const s = series([
      { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
      { Utc: '2026-10-25T20:03:10', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:03:30', TrackStatus: 'VSCDeployed' },
      { Utc: '2026-10-25T20:04:00', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:07:00', TrackStatus: 'AllClear' },
      { Utc: '2026-10-25T20:09:10', TrackStatus: 'SCDeployed' },
      { Utc: '2026-10-25T20:10:00', TrackStatus: 'AllClear' },
    ]);
    // SC 3–3, VSC 3–3, SC 3–5 and SC 7–7: the second SC starts within the first, the third after it.
    expect(lapPeriods(s, laps, hm('20:12:00'), T0, 'Race')).toEqual([
      { kind: 'sc', from: 3, to: 5 },
      { kind: 'vsc', from: 3, to: 3 },
      { kind: 'sc', from: 7, to: 7 },
    ]);
  });

  it('gives no band outside a race', () => {
    const s = series([{ Utc: '2026-10-25T20:04:00', TrackStatus: 'SCDeployed' }]);
    expect(lapPeriods(s, laps, hm('20:12:00'), T0, 'Practice')).toEqual([]);
    expect(lapPeriods(s, laps, hm('20:12:00'), T0, null)).toEqual([]);
  });
});

describe('feedClock (#114)', () => {
  const hm = (s: string) => at(`2026-10-25T${s}Z`);
  const s = series([
    { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
    { Utc: '2026-10-25T20:10:00', SessionStatus: 'Aborted' },
    { Utc: '2026-10-25T20:15:00', SessionStatus: 'Started' },
    { Utc: '2026-10-25T20:30:00', TrackStatus: 'VSCDeployed' },
  ]);

  it('maps the bands at or before T to clock periods: a closed one ends at its end, an open one at T', () => {
    expect(feedClock(s, hm('20:40:00'), hm('20:00:00'))).toEqual([
      { kind: 'red', from: hm('20:10:00'), to: hm('20:15:00') },
      { kind: 'vsc', from: hm('20:30:00'), to: hm('20:40:00') },
    ]);
  });

  it('shows nothing after T, and no start or chequered mark', () => {
    expect(feedClock(s, hm('20:05:00'), hm('20:00:00'))).toEqual([]);
    expect(feedClock(s, hm('20:12:00'), hm('20:00:00'))).toEqual([
      { kind: 'red', from: hm('20:10:00'), to: hm('20:12:00') },
    ]);
  });

  it('drops a band that started before lo, as lapPeriods and the seek bar do', () => {
    expect(feedClock(s, hm('20:40:00'), hm('20:12:00'))).toEqual([
      { kind: 'vsc', from: hm('20:30:00'), to: hm('20:40:00') },
    ]);
  });
});

describe('feedRaceControl', () => {
  it('keeps the messages with a text, each with its Utc as an ISO date, null when unusable', () => {
    const state: Obj = {
      RaceControlMessages: {
        Messages: {
          '0': { Utc: '2026-10-25T20:05:00', Category: 'Other', Message: 'CAR 1 (VER) TIME PENALTY' },
          '1': { Utc: 'soon', Category: 'Other', Message: 'GREEN LIGHT - PIT EXIT OPEN' },
          '2': { Utc: '2026-10-25T20:06:00', Category: 'Flag' },
        },
      },
    };
    expect(feedRaceControl(state)).toEqual([
      { date: '2026-10-25T20:05:00.000Z', message: 'CAR 1 (VER) TIME PENALTY' },
      { date: null, message: 'GREEN LIGHT - PIT EXIT OPEN' },
    ]);
    expect(feedRaceControl({})).toEqual([]);
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
    pits: new Map(),
    weather: [],
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
      fastest: 0, // no lap time in these rows
    });
  });

  it('counts a lap the stream deleted, from its rows (#95)', () => {
    // openStream itself: each event parsed with its contract, the rows kept by key. Node has EventTarget and MessageEvent.
    const opened: EventTarget[] = [];
    class ES extends EventTarget {
      constructor() {
        super();
        opened.push(this);
      }
      close() {}
    }
    const stream = (events: (readonly [string, unknown])[]) => {
      let feed: Feed | undefined;
      const { close } = openStream(
        { recording: 1, at: 0, delay: 0 },
        { onData: (f) => (feed = f), onError: () => {}, onStale: () => {}, onEnd: () => {} },
        ES as unknown as typeof EventSource,
      );
      for (const [name, data] of events)
        opened.at(-1)?.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
      close();
      if (!feed) throw new Error('no snapshot');
      return feed;
    };
    const valid = lap(7, 2, { lap_ms: 90_000, colour: { lap: 'purple', s1: null, s2: null, s3: null } });
    const struck = {
      ...valid,
      deleted: true,
      deleted_reason: 'TRACK LIMITS AT TURN 4',
      colour: { ...valid.colour, lap: 'yellow' as const },
    };
    const snapshot = (t: number) =>
      ['snapshot', { t, state: {}, laps: [valid], stints: [], pits: [], weather: [] }] as const;
    const old = stream([snapshot(OLD)]);
    // The new seek's stream: its snapshot, then the laps event the ruling sent.
    const next = stream([snapshot(NEW - 1000), ['laps', { t: NEW, laps: [struck], stints: [], pits: [] }]]);
    expect(next.laps.get('7:2')).toEqual(struck);
    expect(skipped(old, next)?.deleted).toBe(1);
  });

  it('is null unless the new T is later', () => {
    expect(skipped(feed(NEW, state, after), feed(OLD, {}, before))).toBeNull();
    expect(skipped(feed(NEW, state, after), feed(NEW, state, after))).toBeNull();
  });

  it('skippedText lists the non-zero counts, singular or plural', () => {
    const none = { sc: 0, vsc: 0, red: 0, stops: 0, deleted: 0, incidents: 0, fastest: 0 };
    expect(skippedText({ sc: 1, vsc: 1, red: 0, stops: 21, deleted: 1, incidents: 1, fastest: 4 })).toBe(
      '1 SC · 1 VSC · 21 pit stops · 1 lap deleted · 1 incident noted · 4 fastest laps',
    );
    expect(skippedText({ ...none, red: 2, stops: 1, deleted: 3, incidents: 2 })).toBe(
      '2 red flags · 1 pit stop · 3 laps deleted · 2 incidents noted',
    );
    expect(skippedText({ ...none, red: 1 })).toBe('1 red flag');
    expect(skippedText({ ...none, fastest: 1 })).toBe('1 fastest lap'); // a window of fastest laps only gets a line
    expect(skippedText(none)).toBe('');
  });
});

describe('skippedEvents (#234)', () => {
  const OLD = at('2026-10-25T20:00:00Z');
  const NEW = at('2026-10-25T20:30:00Z');
  const iso = (min: number) => new Date(OLD + min * 60_000).toISOString();
  const feedUtc = (min: number) => iso(min).replace('Z', ''); // the feed's Utc has no Z
  const feed = (t: number, state: Obj, laps: ReturnType<typeof lap>[]): Feed => ({
    t,
    state,
    laps: new Map(laps.map((l) => [`${l.driver_number}:${l.lap_number}`, l])),
    stints: new Map(),
    pits: new Map(),
    weather: [],
  });
  const msg = (min: number, Message: string, Lap?: number) => ({ Utc: feedUtc(min), Category: 'Other', Message, Lap });
  const base = (Type: string, Name: string): Obj => ({
    SessionInfo: { Type, Name },
    DriverList: { '1': { Tla: 'AAA', TeamColour: '3671C6' }, '2': { Tla: 'BBB' }, '3': { Tla: 'CCC' } },
  });
  const state: Obj = {
    ...base('Race', 'Race'),
    ...seriesState([
      { Utc: feedUtc(-10), TrackStatus: 'SCDeployed' }, // started before the window
      { Utc: feedUtc(-5), TrackStatus: 'AllClear' },
      { Utc: feedUtc(0), TrackStatus: 'VSCDeployed' }, // at the old T: outside (old T, new T]
      { Utc: feedUtc(1), TrackStatus: 'AllClear' },
      { Utc: feedUtc(10), TrackStatus: 'SCDeployed' },
      { Utc: feedUtc(14), TrackStatus: 'AllClear' },
      { Utc: feedUtc(30), TrackStatus: 'Red' }, // at the new T: inside
      { Utc: feedUtc(40), TrackStatus: 'VSCDeployed' }, // after the new T (a synthetic future)
    ]),
    RaceControlMessages: {
      Messages: {
        '0': msg(0, 'TURN 1 INCIDENT INVOLVING CARS 1 (AAA) AND 2 (BBB) NOTED'),
        '1': msg(5, 'TURN 4 INCIDENT INVOLVING CAR 3 (CCC) NOTED - CAUSING A COLLISION', 12),
        '2': msg(
          7,
          'FIA STEWARDS: TURN 4 INCIDENT INVOLVING CAR 3 (CCC) UNDER INVESTIGATION - CAUSING A COLLISION',
          13,
        ),
        '3': msg(8, 'CAR 2 (BBB) TIME 1:31.000 DELETED - TRACK LIMITS AT TURN 6 LAP 10 20:07:55'),
        '4': msg(20, 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 3 (CCC) - CAUSING A COLLISION'),
        '5': msg(30, 'TURN 9 INCIDENT INVOLVING CAR 1 (AAA) NOTED', 17),
        '6': msg(31, 'TURN 2 INCIDENT INVOLVING CAR 2 (BBB) NOTED'),
      },
    },
  };
  const before = [
    lap(1, 11, { date_start: iso(-1) }), // the leader on lap 11 at the old T
    lap(2, 5, { deleted: true }), // deleted before the window: never listed
    lap(2, 10, { date_start: iso(-2), lap_ms: 91_000 }),
    lap(3, 9, { is_pit_out: true, date_start: iso(0) }), // a stop at the old T: outside
  ];
  const after = [
    ...before.slice(0, 2),
    lap(2, 10, { date_start: iso(-2), lap_ms: 91_000, deleted: true }), // struck by the ruling at +8 min
    before[3] as ReturnType<typeof lap>,
    lap(1, 12, { date_start: iso(4) }),
    lap(1, 13, { is_pit_out: true, date_start: iso(9), compound: 'HARD' }),
    lap(1, 14, { date_start: iso(15), lap_ms: 88_000 }),
    lap(1, 17, { date_start: iso(29) }), // the leader on lap 17 at the new T
    lap(3, 1, { is_pit_out: true, date_start: iso(2) }), // lap 1 is no stop
    lap(3, 15, { is_pit_out: true, date_start: iso(30), compound: 'MEDIUM' }), // at the new T: inside
    lap(2, 16, { is_pit_out: true, date_start: iso(31) }), // after the new T
  ];
  const s = (e: { t: number }) => (e.t - OLD) / 1000;

  it('lists each kind in (old T, new T], oldest first, and nothing at the old T or after the new one', () => {
    const events = skippedEvents(feed(OLD, {}, before), feed(NEW, state, after)) ?? [];
    expect(events.map((e) => [e.kind, s(e)])).toEqual([
      ['incident', 300],
      ['incident', 420],
      ['deleted', 480],
      ['stop', 540],
      ['flag', 600],
      ['fastest', 988],
      ['incident', 1200],
      ['flag', 1800],
      ['incident', 1800],
      ['stop', 1800],
    ]);
    const [noted, investigation, deleted, stop, sc, fastest, penalty, red] = events;
    expect(noted).toEqual({
      kind: 'incident',
      t: OLD + 300_000,
      text: 'TURN 4 INCIDENT INVOLVING CAR 3 (CCC) NOTED - CAUSING A COLLISION',
      lap: 12,
      noted: true,
    });
    expect(investigation).toMatchObject({ lap: 13, noted: false });
    expect(penalty).toMatchObject({ lap: null, noted: false });
    expect(deleted).toMatchObject({ driver: { number: 2, acronym: 'BBB' }, lap: 10 });
    expect(stop).toMatchObject({ driver: { number: 1, acronym: 'AAA', team: '#3671C6' }, lap: 12, compound: 'HARD' });
    expect(sc).toEqual({ kind: 'flag', t: OLD + 600_000, flag: 'sc', lap: 13 }); // the leader's lap then
    expect(fastest).toMatchObject({ driver: { number: 1 }, lap: 14, ms: 88_000, part: null });
    expect(red).toMatchObject({ flag: 'red', lap: 17 });
  });

  it('agrees with skipped: the flags, stops, deletions, incidents noted and fastest laps', () => {
    const [old, next] = [feed(OLD, {}, before), feed(NEW, state, after)];
    const counts = { sc: 1, vsc: 0, red: 1, stops: 2, deleted: 1, incidents: 2, fastest: 1 };
    expect(tally(skippedEvents(old, next) ?? [])).toEqual(counts);
    expect(skipped(old, next)).toEqual(counts);
  });

  it('is null unless the new T is later', () => {
    expect(skippedEvents(feed(NEW, state, after), feed(OLD, {}, before))).toBeNull();
    expect(skippedEvents(feed(NEW, state, after), feed(NEW, state, after))).toBeNull();
  });

  it('the window: the leader’s laps at both ends in a race, and whole minutes, at least one', () => {
    expect(skippedWindow(feed(OLD, {}, before), feed(NEW, state, after))).toEqual({ laps: [11, 17], minutes: 30 });
    const practice = { ...state, ...base('Practice', 'Practice 1') };
    expect(skippedWindow(feed(OLD, {}, before), feed(OLD + 20_000, practice, after))).toEqual({
      laps: null,
      minutes: 1,
    });
    // Before lap 1 started, the window starts at lap 1.
    const early = [lap(1, 1, { date_start: iso(2) })];
    expect(skippedWindow(feed(OLD, {}, []), feed(NEW, state, early)).laps).toEqual([1, 1]);
  });

  it('a fastest lap was the best when it ended: never a deleted lap, an in- or out-lap, a tie or one still running', () => {
    const timed = (n: number, l: number, start: number, lap_ms: number, extra = {}) =>
      lap(n, l, { date_start: iso(start), lap_ms, ...extra });
    const laps = [
      timed(1, 2, -3, 90_000), // the best before the window: the baseline only
      timed(2, 3, 1, 89_000), // beats it
      timed(3, 3, 2, 89_500),
      timed(1, 4, 3, 88_000, { deleted: true }),
      timed(2, 5, 4, 87_000, { is_pit_in: true }),
      timed(3, 6, 5, 87_500, { is_pit_out: true }),
      timed(1, 7, 6, 89_000), // a tie: the earlier lap keeps it (A§9)
      timed(2, 8, 7, 88_500), // beats 89.000
      timed(3, 9, 29, 80_000), // ends after the new T
    ];
    const events = skippedEvents(feed(OLD, {}, []), feed(NEW, base('Race', 'Race'), laps)) ?? [];
    expect(events.flatMap((e) => (e.kind === 'fastest' ? [[e.driver.acronym, e.lap, e.ms, s(e)]] : []))).toEqual([
      ['BBB', 3, 89_000, 149],
      ['BBB', 8, 88_500, 508.5],
    ]);
  });

  it('in qualifying the best starts again in each part, and the row names it (D4)', () => {
    const laps = [
      lap(1, 3, { date_start: iso(-20), lap_ms: 80_000, quali_phase: 1 }),
      lap(2, 8, { date_start: iso(2), lap_ms: 81_000, quali_phase: 2 }), // slower than Q1's best, the best of Q2
      lap(1, 9, { date_start: iso(4), lap_ms: 80_500, quali_phase: 2 }),
      lap(3, 10, { date_start: iso(6), lap_ms: 80_800, quali_phase: 2 }),
    ];
    const parts = (name: string) =>
      (skippedEvents(feed(OLD, {}, []), feed(NEW, base('Qualifying', name), laps)) ?? []).flatMap((e) =>
        e.kind === 'fastest' ? [[e.lap, e.part]] : [],
      );
    expect(parts('Qualifying')).toEqual([
      [8, 'Q2'],
      [9, 'Q2'],
    ]);
    expect(parts('Sprint Qualifying')).toEqual([
      [8, 'SQ2'],
      [9, 'SQ2'],
    ]);
  });

  it('a deleted lap sits at its ruling, paired per driver in order; without one at its end inside the window (D5)', () => {
    const rulings: Obj = {
      RaceControlMessages: {
        Messages: {
          '0': msg(-1, 'CAR 4 (DDD) TIME 1:30.100 DELETED - TRACK LIMITS AT TURN 4 LAP 3 19:59:00'), // before
          '1': msg(3, 'CAR 4 (DDD) TIME 1:30.500 DELETED - TRACK LIMITS AT TURN 4 LAP 5 20:02:40'),
          '2': msg(6, 'CORRECTION - CAR 4 (DDD) LAP DELETED - TRACK LIMITS AT TURN 9 LAP 7 20:05:10'),
        },
      },
    };
    const struck = (n: number, l: number, extra = {}) => lap(n, l, { deleted: true, ...extra });
    const laps = [
      struck(4, 7, { date_start: iso(4), lap_ms: 90_000 }),
      struck(4, 5, { date_start: iso(1), lap_ms: 90_500 }),
      struck(5, 2, { date_start: iso(-5), lap_ms: 90_000 }), // ended before the window: at its first ms
      struck(6, 3), // no start: at the new T
      struck(7, 4, { date_start: iso(10), lap_ms: 90_000 }), // ended inside: at its end
    ];
    const events = skippedEvents(feed(OLD, {}, []), feed(NEW, rulings, laps)) ?? [];
    expect(events.flatMap((e) => (e.kind === 'deleted' ? [[e.driver.number, e.lap, s(e)]] : []))).toEqual([
      [5, 2, 0.001],
      [4, 5, 180],
      [4, 7, 360],
      [7, 4, 690],
      [6, 3, 1800],
    ]);
  });

  it('a deleted lap takes the ruling that names its lap first, so a correction never moves a later lap (D5)', () => {
    const rulings: Obj = {
      RaceControlMessages: {
        Messages: {
          '0': msg(2, 'CAR 8 (EEE) TIME 1:30.500 DELETED - TRACK LIMITS AT TURN 4 LAP 5 20:01:40'),
          '1': msg(4, 'CORRECTION - CAR 8 (EEE) TIME 1:30.500 DELETED - TRACK LIMITS AT TURN 4 LAP 5 20:01:40'),
          '2': msg(8, 'CAR 8 (EEE) TIME 1:31.200 DELETED - TRACK LIMITS AT TURN 9 LAP 9 20:07:10'),
          '3': msg(9, 'CAR 8 (EEE) LAP DELETED - TRACK LIMITS AT TURN 1'), // names no lap: taken in time order
        },
      },
    };
    const laps = [
      lap(8, 12, { deleted: true, date_start: iso(7), lap_ms: 90_000 }),
      lap(8, 9, { deleted: true, date_start: iso(5), lap_ms: 91_200 }),
      lap(8, 5, { deleted: true, date_start: iso(0), lap_ms: 90_500 }),
    ];
    const events = skippedEvents(feed(OLD, {}, []), feed(NEW, rulings, laps)) ?? [];
    // Lap 12 has no named ruling: the first one left in time order, the correction at 4 min (not lap 9's at 8).
    expect(events.flatMap((e) => (e.kind === 'deleted' ? [[e.lap, s(e)]] : []))).toEqual([
      [5, 120],
      [12, 240],
      [9, 480],
    ]);
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
