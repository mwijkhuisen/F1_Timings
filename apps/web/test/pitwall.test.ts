import { merge, type Obj } from '@f1/contracts';
import { describe, expect, it } from 'vitest';
import {
  fastestSoFar,
  fmtLeft,
  LIGHT,
  leftAt,
  lightOf,
  raceControl,
  running,
  stripOf,
  withinASecond,
} from '../src/lib/pitwall.ts';
import { messages, practiceState, qualifyingState, raceState } from './feed-state.ts';

// The pit wall's state functions (A§13, P4d) on synthetic feed states.

const word = (session: string | undefined, track: string | undefined) => LIGHT[lightOf(session, track)].word;

describe('lightOf: the light per code', () => {
  it.each([
    ['1', 'Track clear', 'g'],
    ['2', 'Yellow flag', 'y'],
    ['4', 'Safety car', 'y'],
    ['5', 'Red flag', 'r'],
    ['6', 'VSC', 'y'],
    ['7', 'VSC ending', 'y'],
  ])('TrackStatus %s while Started is %s, lamp %s', (code, w, lamp) => {
    expect(word('Started', code)).toBe(w);
    expect(LIGHT[lightOf('Started', code)].lamp).toBe(lamp);
  });

  it('never guesses clear: TrackStatus 3, "9", none or an inherited key is unknown', () => {
    for (const code of ['3', '9', undefined, '', 'toString', '__proto__'])
      expect(word('Started', code)).toBe('Track status unknown');
    expect(LIGHT.unknown.lamp).toBeNull();
  });

  it('names the session states whatever the track does', () => {
    expect(word('Inactive', '1')).toBe('Not started');
    expect(word(undefined, '4')).toBe('Not started');
    expect(LIGHT.off.lamp).toBeNull();
    expect(word('Aborted', '5')).toBe('Stopped');
    for (const s of ['Finished', 'Finalised', 'Ends']) expect(word(s, '1')).toBe('Chequered flag');
    expect(LIGHT.finished.lamp).toBe('chq');
  });

  it('runs while Started or Aborted only', () => {
    expect(['Started', 'Aborted'].map(running)).toEqual([true, true]);
    expect(['Inactive', 'Finished', 'Finalised', 'Ends', undefined].map(running)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('stripOf', () => {
  it('track clear: the light, the lap, the clock, the weather and the latest message', () => {
    const strip = stripOf(
      raceState({
        msgs: [
          [1, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN'],
          [3, 'Other', 'DRS ENABLED'],
        ],
      }),
    );
    expect(strip).toEqual({
      light: 'clear',
      lap: { current: 12, total: 57 },
      clock: { remainingS: 5405, utcMs: Date.parse('2026-01-11T14:20:00Z'), extrapolating: true },
      weather: '22.4° air · 43.1° track · dry',
      latest: { lap: 3, text: 'DRS ENABLED' },
    });
  });

  it('safety car, VSC and red flag, with rain', () => {
    const rain = { WeatherData: { AirTemp: '18.0', TrackTemp: '21.5', Rainfall: '1' } };
    expect(stripOf(raceState({ track: '4', msgs: [[20, 'SafetyCar', 'SAFETY CAR DEPLOYED']] }))).toMatchObject({
      light: 'sc',
      latest: { lap: 20, text: 'SAFETY CAR DEPLOYED' },
    });
    expect(stripOf(raceState({ track: '6' })).light).toBe('vsc');
    expect(stripOf(raceState({ track: '5', extra: rain }))).toMatchObject({
      light: 'red',
      weather: '18.0° air · 21.5° track · rain',
    });
    expect(stripOf(raceState({ session: 'Aborted', track: '5' })).light).toBe('stopped');
  });

  it('leaves a cell out without its data: no lap outside races, no message, odd weather', () => {
    const strip = stripOf(
      practiceState({ extra: { WeatherData: { AirTemp: 'warm', TrackTemp: '30', Rainfall: 'maybe' } } }),
    );
    expect(strip.lap).toBeUndefined();
    expect(strip.latest).toBeUndefined();
    expect(strip.weather).toBe('30° track');
    expect(stripOf({}).weather).toBeUndefined();
    expect(stripOf({})).toEqual({ light: 'off' });
  });

  it('takes the message with the highest numeric key as the latest', () => {
    const rc = {
      Messages: { '9': { Lap: 9, Message: 'NINE' }, '10': { Lap: 10, Message: 'TEN' }, x: { Message: 'X' } },
    };
    expect(stripOf({ RaceControlMessages: rc }).latest).toEqual({ lap: 10, text: 'TEN' });
  });
});

describe('leftAt and fmtLeft', () => {
  const clock = { remainingS: 600, utcMs: 1_000_000, extrapolating: true };

  it('counts down from the Utc while extrapolating', () => {
    expect(leftAt(clock, 1_000_000)).toBe(600);
    expect(leftAt(clock, 1_090_500)).toBe(509.5);
    expect(fmtLeft(leftAt(clock, 1_090_500))).toBe('08:29');
  });

  it('holds while frozen', () => {
    expect(leftAt({ ...clock, extrapolating: false }, 9_999_999)).toBe(600);
  });

  it('clamps at 0, and never above the remaining time', () => {
    expect(leftAt(clock, 1_000_000 + 700_000)).toBe(0);
    expect(leftAt(clock, 0)).toBe(600);
  });

  it('has no clock for a bad Remaining or Utc', () => {
    for (const ExtrapolatedClock of [
      { Utc: '2026-01-11T14:20:00Z', Remaining: '10:00' },
      { Utc: '2026-01-11T14:20:00Z', Remaining: 'soon' },
      { Utc: 'yesterday', Remaining: '00:10:00' },
      { Remaining: '00:10:00' },
    ])
      expect(stripOf({ ExtrapolatedClock }).clock).toBeUndefined();
  });

  it('formats MM:SS, and H:MM:SS from one hour', () => {
    expect([0, 59.9, 61, 3599, 3600, 5405].map(fmtLeft)).toEqual([
      '00:00',
      '00:59',
      '01:01',
      '59:59',
      '1:00:00',
      '1:30:05',
    ]);
  });
});

describe('raceControl', () => {
  it('grows with T, newest first: the state merged up to T1, then to T2', () => {
    const state: Obj = Object.create(null);
    merge(state, { RaceControlMessages: messages([[1, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN']]) });
    expect(raceControl(state).items.map((i) => i.text)).toEqual(['GREEN LIGHT - PIT EXIT OPEN']);
    merge(state, { RaceControlMessages: messages([[3, 'Other', 'DRS ENABLED']], 1) });
    expect(raceControl(state).items.map((i) => [i.key, i.lap, i.text])).toEqual([
      [1, 3, 'DRS ENABLED'],
      [0, 1, 'GREEN LIGHT - PIT EXIT OPEN'],
    ]);
  });

  it('sorts keys as numbers, not text', () => {
    const rc = { Messages: { '9': { Message: 'NINE' }, '10': { Message: 'TEN' }, '2': { Message: 'TWO' } } };
    expect(raceControl({ RaceControlMessages: rc }).items.map((i) => i.text)).toEqual(['TEN', 'NINE', 'TWO']);
  });

  it('gives each message its kind and tag, the first match winning, and counts them', () => {
    const { items, counts } = raceControl(
      raceState({
        msgs: [
          [1, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN'],
          [5, 'SafetyCar', 'VIRTUAL SAFETY CAR DEPLOYED'],
          [7, 'SafetyCar', 'SAFETY CAR IN THIS LAP'],
          [8, 'Other', 'RED FLAG'], // 2026: the red flag's text comes as Other
          [9, 'Other', 'CAR 4 (DDD) TIME 1:22.214 DELETED - TRACK LIMITS AT TURN 7 LAP 9 14:24:37'],
          [10, 'Other', 'TURN 4 INCIDENT INVOLVING CARS 3 (CCC) AND 4 (DDD) NOTED'],
          [11, 'Other', 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 3 (CCC)'],
          [12, 'Other', 'DRS ENABLED'],
          [13, 'Flag', 'CAR 4 (DDD) TIME DELETED, FLAG'], // a Flag category wins over its text
        ],
      }),
    );
    expect(items.map((i) => [i.lap, i.kind, i.tag])).toEqual([
      [13, 'flags', 'FLAG'],
      [12, 'other', undefined],
      [11, 'incidents', 'INCIDENT'],
      [10, 'incidents', 'INCIDENT'],
      [9, 'limits', 'LIMITS'],
      [8, 'flags', 'FLAG'],
      [7, 'sc', 'SC'],
      [5, 'sc', 'VSC'],
      [1, 'flags', 'FLAG'],
    ]);
    expect(counts).toEqual({ all: 9, flags: 3, sc: 2, incidents: 2, limits: 1, other: 1 });
  });

  it('is empty without messages, and skips one without a text', () => {
    expect(raceControl({})).toEqual({
      items: [],
      counts: { all: 0, flags: 0, sc: 0, incidents: 0, limits: 0, other: 0 },
    });
    expect(raceControl({ RaceControlMessages: { Messages: { '0': { Lap: 1 } } } }).items).toEqual([]);
  });
});

describe('withinASecond', () => {
  it('pairs a car under a second with the one ahead: not at 1.000 s, not lapped, not the leader, not retired', () => {
    expect(withinASecond(raceState())).toEqual([
      {
        place: '1',
        ahead: { number: 1, acronym: 'AAA', name: 'Ann A', team: '#FF0000' },
        behind: { number: 2, acronym: 'BBB', name: 'Bob B', team: '#00FF00' },
        interval: '+0.400',
      },
    ]);
  });

  it('is empty outside races', () => {
    expect(withinASecond(practiceState())).toEqual([]);
    expect(withinASecond(qualifyingState())).toEqual([]);
  });
});

describe('fastestSoFar', () => {
  it('is the TimingStats line ranked 1 on its personal best', () => {
    expect(fastestSoFar(raceState())).toEqual({
      driver: { number: 2, acronym: 'BBB', name: 'Bob B', team: '#00FF00' },
      value: '1:20.500',
      lap: 9,
    });
  });

  it('is undefined before a ranked lap with a time', () => {
    expect(fastestSoFar(practiceState())).toBeUndefined();
    const unranked = { TimingStats: { Lines: { '1': { PersonalBestLapTime: { Value: '', Position: 1 } } } } };
    expect(fastestSoFar(unranked)).toBeUndefined();
  });
});
