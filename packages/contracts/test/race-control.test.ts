import { expect, test } from 'vitest';
import { IGNORED, isUnmatched, PERIOD_LIKE } from '../src/race-control.ts';

const row = (message: string | null, flag: string | null = null) => ({ message, flag });

test('isUnmatched: a period-like message with no form and no ignored wording', () => {
  for (const m of [
    'SAFETY CAR IN',
    'VSC ENDED',
    'RESUME OF THE RACE',
    'THE SAFETY CAR DEPLOYED',
    'SC DEPLOYED',
    'VIRTUAL SC ENDING',
    'SESSION SUSPENDED',
  ])
    expect(isUnmatched(row(m)), m).toBe(true);
});

test('isUnmatched: a known form, an unrelated message and a null are not counted', () => {
  expect(isUnmatched(row('SAFETY CAR DEPLOYED'))).toBe(false);
  expect(isUnmatched(row('RED FLAG - SESSION SUSPENDED'))).toBe(false);
  expect(isUnmatched(row('VSC ENDED', 'RED'))).toBe(false); // the flag is a form
  expect(isUnmatched(row('YELLOW IN TRACK SECTOR 7'))).toBe(false);
  expect(isUnmatched(row('MISCELLANEOUS'))).toBe(false); // SC inside a word is not the word SC
  expect(isUnmatched(row(null))).toBe(false);
});

// One real wording per ignored term (D4); all but the covers line are period-like with no form, so only IGNORED keeps them out.
test.each([
  'UNDER SAFETY CAR INCIDENT NOTED',
  'STEWARDS: SAFETY CAR PROCEDURE',
  'SAFETY CAR INFRINGEMENT CAR 4',
  'SAFETY CAR LIGHTS ON',
  'SAFETY CAR LIGHTS OFF',
  'ALL CARS MAY OVERTAKE THE SAFETY CAR',
  'LAPPED CAR(S) MAY NOW OVERTAKE THE SAFETY CAR: 4, 81',
  'SAFETY CAR THROUGH THE PIT LANE',
  'ALL CARS TO FOLLOW THE SAFETY CAR THROUGH THE PIT LANE',
  'SAFETY CAR WILL USE START/FINISH STRAIGHT',
  'FORMATION LAP WILL BE STARTED BEHIND THE SAFETY CAR',
  'FORMATION LAP WILL BE STARTED BEHIND THE SAFETY CAR ON WET-WEATHER TYRES',
  'FORMATION LAP(S) BEHIND SAFETY CAR',
  'SAFETY CAR WILL ENTER PITS: ROLLING START PROCEDURE',
  'RACE WILL START BEHIND THE SAFETY CAR',
  'THE SAFETY CAR WILL STAY OUT FOR 3 LAPS',
  'COVERS ON TIME 1 HOURS AFTER CHEQUERED FLAG = 15:00',
])('isUnmatched: ignores the procedural wording %s', (m) => {
  expect(IGNORED.test(m), m).toBe(true);
  expect(isUnmatched(row(m)), m).toBe(false);
});

test('SC counts as a word: SC DEPLOYED and VIRTUAL SC ENDING are period-like, MISCELLANEOUS and DISC are not', () => {
  for (const m of ['SC DEPLOYED', 'VIRTUAL SC ENDING', 'SC', 'CAR 4 SC.']) expect(PERIOD_LIKE.test(m), m).toBe(true);
  for (const m of ['MISCELLANEOUS', 'DISC BRAKE', 'ESC']) expect(PERIOD_LIKE.test(m), m).toBe(false);
});

test('both patterns stay plain, flagless and free of \\b, which PostgreSQL ~ reads as a backspace', () => {
  for (const re of [PERIOD_LIKE, IGNORED]) {
    expect(re.flags).toBe('');
    expect(re.source).not.toContain('\\b');
  }
});
