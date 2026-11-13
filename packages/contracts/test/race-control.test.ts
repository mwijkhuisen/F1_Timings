import { expect, test } from 'vitest';
import { isUnmatched, PERIOD_LIKE } from '../src/race-control.ts';

const row = (message: string | null, flag: string | null = null) => ({ message, flag });

test('isUnmatched: a period-like message with no form and no stewards note', () => {
  for (const m of ['SAFETY CAR IN', 'VSC ENDED', 'RESUME OF THE RACE', 'THE SAFETY CAR DEPLOYED'])
    expect(isUnmatched(row(m)), m).toBe(true);
});

test('isUnmatched: a known form, a stewards note, an unrelated message and a null are not counted', () => {
  expect(isUnmatched(row('SAFETY CAR DEPLOYED'))).toBe(false);
  expect(isUnmatched(row('RED FLAG - SESSION SUSPENDED'))).toBe(false);
  expect(isUnmatched(row('VSC ENDED', 'RED'))).toBe(false); // the flag is a form
  expect(isUnmatched(row('SC DEPLOYED'))).toBe(false); // not period-like: PERIOD_LIKE has no bare SC
  expect(isUnmatched(row('UNDER SAFETY CAR INCIDENT NOTED'))).toBe(false);
  expect(isUnmatched(row('YELLOW IN TRACK SECTOR 7'))).toBe(false);
  expect(isUnmatched(row(null))).toBe(false);
});

test('PERIOD_LIKE stays a plain alternation, which PostgreSQL ~ reads the same', () => {
  expect(PERIOD_LIKE.source).toBe('SAFETY CAR|VSC|RED FLAG|RESUME');
  expect(PERIOD_LIKE.flags).toBe('');
});
