import { describe, expect, it } from 'vitest';
import { KIND_LABEL, KIND_NAME, kindsAt, trackPeriods } from '../src/lib/track.ts';
import { rc } from './laps.ts';

// The S0 forms (scripts/race-control-forms.sql) and their transitions, synthetic rows only.

const SC = 'SAFETY CAR DEPLOYED';
const SC_IN = 'SAFETY CAR IN THIS LAP';
const red = (n: number | null) => rc(n, 'RED FLAG', { category: 'Flag', flag: 'RED' });
const chq = (n: number) => rc(n, 'CHEQUERED FLAG', { category: 'Flag', flag: 'CHEQUERED' });
const resume = (n: number) => rc(n, 'RACE WILL RESUME AT 15:05');
const periods = (...rows: Parameters<typeof trackPeriods>[0]) => trackPeriods(rows).periods;

describe('trackPeriods', () => {
  it('closes a safety car at its IN THIS LAP row', () => {
    expect(periods(rc(10, SC, { category: 'SafetyCar' }), rc(13, SC_IN), chq(50))).toEqual([
      { kind: 'sc', from: 10, to: 13 },
    ]);
  });

  it('reads both VSC spellings', () => {
    expect(
      periods(
        rc(5, 'VIRTUAL SAFETY CAR DEPLOYED'),
        rc(6, 'VIRTUAL SAFETY CAR ENDING'),
        rc(20, 'VSC DEPLOYED'),
        rc(21, 'VSC ENDING'),
      ),
    ).toEqual([
      { kind: 'vsc', from: 5, to: 6 },
      { kind: 'vsc', from: 20, to: 21 },
    ]);
  });

  it('ends a red flag the lap before RACE WILL RESUME, never before it started', () => {
    expect(periods(red(30), resume(31))).toEqual([{ kind: 'red', from: 30, to: 30 }]);
    expect(periods(red(30), resume(30))).toEqual([{ kind: 'red', from: 30, to: 30 }]);
    expect(periods(red(30), resume(33))).toEqual([{ kind: 'red', from: 30, to: 32 }]);
  });

  it('ends a red flag the lap before a safety car that follows it without RACE WILL RESUME', () => {
    expect(periods(red(30), rc(32, SC), rc(36, SC_IN), chq(58))).toEqual([
      { kind: 'red', from: 30, to: 31 },
      { kind: 'sc', from: 32, to: 36 },
    ]);
    expect(periods(red(30), rc(30, SC), rc(33, SC_IN))).toEqual([
      { kind: 'red', from: 30, to: 30 },
      { kind: 'sc', from: 30, to: 33 },
    ]);
  });

  it('reads the 2026 red flag without a flag', () => {
    expect(periods(rc(12, 'RED FLAG - RACE SUSPENDED'), resume(13))).toEqual([{ kind: 'red', from: 12, to: 12 }]);
  });

  it('lets a safety car close a VSC on the same lap', () => {
    const p = periods(rc(8, 'VSC DEPLOYED'), rc(9, SC), rc(11, SC_IN));
    expect(p).toEqual([
      { kind: 'vsc', from: 8, to: 9 },
      { kind: 'sc', from: 9, to: 11 },
    ]);
    expect(kindsAt(p, 9)).toEqual(['sc', 'vsc']);
  });

  it('lets a red flag close a safety car on the same lap', () => {
    expect(periods(rc(4, SC), red(6), resume(7))).toEqual([
      { kind: 'sc', from: 4, to: 6 },
      { kind: 'red', from: 6, to: 6 },
    ]);
  });

  it('closes everything at the chequered flag', () => {
    expect(periods(rc(55, SC), rc(56, 'VSC DEPLOYED'), chq(57))).toEqual([
      { kind: 'sc', from: 55, to: 57 },
      { kind: 'vsc', from: 56, to: 57 },
    ]);
  });

  it('closes what is still open at the highest lap number in the rows', () => {
    expect(periods(rc(40, 'VSC DEPLOYED'), rc(44, 'GREEN LIGHT - PIT EXIT OPEN'), rc(42, 'TRACK CLEAR'))).toEqual([
      { kind: 'vsc', from: 40, to: 44 },
    ]);
    // A red flag after the chequered flag (END → RED once in the [box] output, query 3).
    expect(periods(chq(58), red(58))).toEqual([{ kind: 'red', from: 58, to: 58 }]);
  });

  it('keeps the first of repeated DEPLOYED rows', () => {
    expect(periods(rc(3, SC), rc(4, SC), rc(6, SC_IN))).toEqual([{ kind: 'sc', from: 3, to: 6 }]);
  });

  it('lists a period row without a lap number as unplaced and changes nothing with it', () => {
    const open = rc(null, SC);
    expect(trackPeriods([open, rc(5, SC_IN)])).toEqual({ periods: [], unplaced: [open] });
    const end = rc(null, SC_IN);
    expect(trackPeriods([rc(3, SC), end, rc(9, 'GREEN LIGHT - PIT EXIT OPEN')])).toEqual({
      periods: [{ kind: 'sc', from: 3, to: 9 }],
      unplaced: [end],
    });
  });

  it('ignores every other row', () => {
    expect(
      trackPeriods([
        rc(2, 'SAFETY CAR THROUGH THE PIT LANE', { category: 'SafetyCar' }),
        rc(3, 'CAR 44 (HAM) TIME 1:31.204 DELETED - TRACK LIMITS AT TURN 4 LAP 3 15:12:01'),
        rc(4, 'YELLOW IN TRACK SECTOR 7', { category: 'Flag', flag: 'YELLOW' }),
        rc(5, null),
        rc(null, null, { flag: 'CLEAR' }),
        rc(6, SC_IN), // nothing open
        resume(7),
      ]),
    ).toEqual({ periods: [], unplaced: [] });
  });
});

describe('kindsAt', () => {
  const p = [
    { kind: 'vsc', from: 1, to: 5 },
    { kind: 'sc', from: 3, to: 5 },
    { kind: 'red', from: 5, to: 5 },
  ] as const;

  it('lists the kinds most severe first', () => {
    expect(kindsAt(p, 5)).toEqual(['red', 'sc', 'vsc']);
    expect(kindsAt(p, 4)).toEqual(['sc', 'vsc']);
    expect(kindsAt(p, 1)).toEqual(['vsc']);
    expect(kindsAt(p, 6)).toEqual([]);
  });

  it('names each kind', () => {
    expect([KIND_NAME.vsc, KIND_LABEL.vsc, KIND_NAME.red, KIND_LABEL.sc]).toEqual([
      'Virtual safety car',
      'VSC',
      'Red flag',
      'SC',
    ]);
  });
});
