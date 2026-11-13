import { describe, expect, it } from 'vitest';
import { decide, isComplete, type Link } from '../src/live/recorder.ts';

const MIN = 60_000;
const START = Date.parse('2026-11-08T12:00:00Z');
const END = START + 60 * MIN;
const session = { dateStart: START, dateEnd: END, cancelled: false };
const idle = { session, startedSeen: false, endsAt: undefined };

describe('decide', () => {
  it.each([
    ['cancelled', { session: { ...session, cancelled: true }, now: START }, 'abort'],
    ['moved later: before the new start − 60 min', { now: START - 60 * MIN - 1 }, 'abort'],
    ['at the start − 60 min', { now: START - 60 * MIN }, 'continue'],
    ['during the session', { startedSeen: true, now: START + 10 * MIN }, 'continue'],
    ['never started, at the window end', { now: END + 30 * MIN }, 'stop'],
    ['never started, just before the window end', { now: END + 30 * MIN - 1 }, 'continue'],
    ['a stale Ends sets no endsAt: never started, before the window end', { now: START + 40 * MIN }, 'continue'],
    ['qualifying between segments, past the window end', { startedSeen: true, now: END + 31 * MIN }, 'continue'],
    ['a red flag past the planned end', { startedSeen: true, now: END + 90 * MIN }, 'continue'],
    ['the hard stop', { startedSeen: true, now: END + 180 * MIN }, 'stop'],
    ['just before the hard stop', { startedSeen: true, now: END + 180 * MIN - 1 }, 'continue'],
    ['Ends + 30 min, before the planned end', { startedSeen: true, endsAt: START, now: START + 30 * MIN }, 'stop'],
    ['Ends + 29 min', { startedSeen: true, endsAt: START, now: START + 29 * MIN }, 'continue'],
    ['a late Ends + 29 min', { startedSeen: true, endsAt: END + MIN, now: END + 30 * MIN }, 'continue'],
  ] as const)('%s', (_name, input, expected) => {
    expect(decide({ ...idle, ...input })).toBe(expected);
  });

  // Las Vegas FP1 → FP2 and FP3 → Q: the next session starts 2.5 h after this one's planned end, so its lead
  // begins at END + 90 min. The handover is at max(next start − 60 min, END) (#94).
  const after = (gap: number) => ({ dateStart: END + gap, dateEnd: END + gap + 60 * MIN });
  const vegas = { startedSeen: true, next: after(150 * MIN) };
  const on = { startedSeen: true };
  const cancelled = { ...session, cancelled: true };
  it.each([
    ['no Ends, just before the next lead', { ...vegas, now: END + 90 * MIN - 1 }, 'continue'],
    ['no Ends, at the next lead', { ...vegas, now: END + 90 * MIN }, 'handover'],
    ['a late Ends, at the next lead', { ...vegas, endsAt: END + 70 * MIN, now: END + 90 * MIN }, 'handover'],
    ['an Ends that ends it before the next lead', { ...vegas, endsAt: END + 55 * MIN, now: END + 85 * MIN }, 'stop'],
    ['never started, a next lead before the window end', { next: after(70 * MIN), now: END + 10 * MIN }, 'handover'],
    ['a next lead inside this session: not before its end', { ...on, next: after(30 * MIN), now: END - 1 }, 'continue'],
    ['a next lead inside this session: at its end', { ...on, next: after(30 * MIN), now: END }, 'handover'],
    ['back to back: at the end', { ...on, next: after(0), now: END }, 'handover'],
    ['truly overlapping: old rules, past the end', { ...on, next: after(-30 * MIN), now: END + 90 * MIN }, 'continue'],
    ['truly overlapping: old rules, the hard stop', { ...on, next: after(-30 * MIN), now: END + 180 * MIN }, 'stop'],
    ['cancelled wins over the handover', { ...on, session: cancelled, next: after(0), now: END }, 'abort'],
  ] as const)('with a next session: %s', (_name, input, expected) => {
    expect(decide({ ...idle, ...input })).toBe(expected);
  });
});

describe('isComplete', () => {
  const span = (from: number, to?: number, token = true): Link => ({
    from,
    token,
    ...(to === undefined ? {} : { to }),
  });
  const STOP = END + 30 * MIN;
  const window = { dateStart: START, dateEnd: END };

  it('holds for one link across the window, and never without a subscribe', () => {
    expect(isComplete([span(START - 59 * MIN)], STOP, window)).toBe(true);
    expect(isComplete([], STOP, window)).toBe(false);
  });

  it('ignores a 3-minute flap before the session, which is exactly what FP1 showed', () => {
    const links = [span(START - 40 * MIN, START - 20 * MIN), span(START - 17 * MIN)];
    expect(isComplete(links, STOP, window)).toBe(true);
  });

  it('ignores a flap after the window', () => {
    expect(isComplete([span(START - 5 * MIN, END + 2 * MIN), span(END + 10 * MIN)], STOP, window)).toBe(true);
  });

  it('allows a 60 s gap inside the window, not 61 s', () => {
    const gap = (ms: number) => [span(START - MIN, START + 10 * MIN), span(START + 10 * MIN + ms)];
    expect(isComplete(gap(60_000), STOP, window)).toBe(true);
    expect(isComplete(gap(61_000), STOP, window)).toBe(false);
  });

  it('clips a gap that crosses the window edge', () => {
    expect(isComplete([span(START - 30 * MIN, START - 5 * MIN), span(START + 30_000)], STOP, window)).toBe(true);
    expect(isComplete([span(START - 30 * MIN, START - 5 * MIN), span(START + 61_000)], STOP, window)).toBe(false);
    expect(isComplete([span(START - MIN, END - 30_000)], STOP, window)).toBe(true);
    expect(isComplete([span(START - MIN, END - 61_000)], STOP, window)).toBe(false);
  });

  it('counts a late start as a gap: the session began without this recording', () => {
    expect(isComplete([span(START + 30_000)], STOP, window)).toBe(true);
    expect(isComplete([span(START + 10 * MIN)], STOP, window)).toBe(false);
  });

  it('does not count a stop before the planned end (an early Ends) as a gap', () => {
    expect(isComplete([span(START - MIN)], START + 20 * MIN, window)).toBe(true);
  });

  it('refuses an anonymous stretch inside the window, not one before or after it', () => {
    expect(isComplete([span(START - MIN, START + 5 * MIN, false), span(START + 5 * MIN)], STOP, window)).toBe(false);
    expect(isComplete([span(START - 30 * MIN, START - MIN, false), span(START - MIN)], STOP, window)).toBe(true);
    expect(isComplete([span(START - MIN, END + MIN), span(END + MIN, undefined, false)], STOP, window)).toBe(true);
  });
});
