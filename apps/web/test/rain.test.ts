import { describe, expect, it } from 'vitest';
import { cellRect, firstFrameAt, lastFrameAtOrBefore, rainStep, rainSummary } from '../src/lib/rain.ts';

// The rain map's numbers (P5c): 15-minute mm as mm/h steps, the cells in km, the summary and the frame picks.

const dry = () => Array<number | null>(49).fill(0);
const at = (cells: Record<number, number | null>) => {
  const mm = dry();
  for (const [k, v] of Object.entries(cells)) mm[Number(k)] = v;
  return mm;
};

describe('rainStep', () => {
  it('bins mm per 15 min at 0.1, 2.5 and 7.6 mm/h', () => {
    expect(rainStep(null)).toBe(0);
    expect(rainStep(0)).toBe(0);
    expect(rainStep(0.024)).toBe(0); // 0.096 mm/h
    expect(rainStep(0.025)).toBe(1); // 0.1 mm/h
    expect(rainStep(0.624)).toBe(1);
    expect(rainStep(0.625)).toBe(2); // 2.5 mm/h
    expect(rainStep(1.899)).toBe(2);
    expect(rainStep(1.9)).toBe(3); // 7.6 mm/h
    expect(rainStep(30)).toBe(3);
  });
});

describe('cellRect', () => {
  it('puts row 0 at the north (top) and column 0 at the west, 1.5 km cells around 0 0', () => {
    expect(cellRect(0, 7, 1500)).toEqual({ x: -5.25, y: -5.25, w: 1.5 }); // north-west corner
    expect(cellRect(6, 7, 1500)).toEqual({ x: 3.75, y: -5.25, w: 1.5 }); // north-east
    expect(cellRect(42, 7, 1500)).toEqual({ x: -5.25, y: 3.75, w: 1.5 }); // south-west
    expect(cellRect(48, 7, 1500)).toEqual({ x: 3.75, y: 3.75, w: 1.5 }); // south-east
    expect(cellRect(24, 7, 1500)).toEqual({ x: -0.75, y: -0.75, w: 1.5 }); // the centre
  });
});

describe('rainSummary', () => {
  it('says so when no cell reaches 0.1 mm/h', () => {
    expect(rainSummary(dry(), 7, 1500)).toBe('No rain within 5 km');
    expect(rainSummary(at({ 3: 0.024, 9: null }), 7, 1500)).toBe('No rain within 5 km');
  });

  it('says "No rain data for this time" when every value is null, not that it is dry', () => {
    expect(rainSummary(Array<number | null>(49).fill(null), 7, 1500)).toBe('No rain data for this time');
  });

  it('counts the wet cells and names the heaviest with its distance and direction', () => {
    // Cell 16 is row 2, column 2: (−1.5, −1.5) km, north-west of the centre.
    expect(rainSummary(at({ 16: 0.8 }), 7, 1500)).toBe(
      'Rain in 1 of 49 cells, heaviest 3.2 mm/h, 2 km north-west of the circuit',
    );
    // Cell 3 is (0, −4.5) km; cell 27 is (4.5, 0) km; cell 45 is (0, 4.5) km; cell 32 (1.5, 1.5) km.
    expect(rainSummary(at({ 3: 2, 0: 0.1 }), 7, 1500)).toBe(
      'Rain in 2 of 49 cells, heaviest 8.0 mm/h, 5 km north of the circuit',
    );
    expect(rainSummary(at({ 27: 0.5 }), 7, 1500)).toMatch(/, 5 km east of the circuit$/);
    expect(rainSummary(at({ 45: 0.5 }), 7, 1500)).toMatch(/, 5 km south of the circuit$/);
    expect(rainSummary(at({ 32: 0.5 }), 7, 1500)).toMatch(/, 2 km south-east of the circuit$/);
    expect(rainSummary(at({ 42: 0.5 }), 7, 1500)).toMatch(/, 6 km south-west of the circuit$/);
    expect(rainSummary(at({ 6: 0.5 }), 7, 1500)).toMatch(/, 6 km north-east of the circuit$/);
    expect(rainSummary(at({ 21: 0.5 }), 7, 1500)).toMatch(/, 5 km west of the circuit$/);
  });

  it('says "at the circuit" for the centre cell', () => {
    expect(rainSummary(at({ 24: 0.3, 0: 0.1 }), 7, 1500)).toBe(
      'Rain in 2 of 49 cells, heaviest 1.2 mm/h, at the circuit',
    );
  });

  it('gives a tie to the first cell in row-major order', () => {
    expect(rainSummary(at({ 32: 0.5, 16: 0.5 }), 7, 1500)).toMatch(/, 2 km north-west of the circuit$/);
  });
});

const frames = ['10:00', '10:15', '10:30'].map((hm) => ({ date: `2026-11-09T${hm}:00Z`, mm: dry() }));

describe('firstFrameAt', () => {
  it('picks the first frame at or after the start, else the last, else 0', () => {
    expect(firstFrameAt(frames, '2026-11-09T09:00:00Z')).toBe(0);
    expect(firstFrameAt(frames, '2026-11-09T10:15:00Z')).toBe(1);
    expect(firstFrameAt(frames, '2026-11-09T10:16:00Z')).toBe(2);
    expect(firstFrameAt(frames, '2026-11-09T11:00:00Z')).toBe(2);
    expect(firstFrameAt([], '2026-11-09T11:00:00Z')).toBe(0);
  });
});

describe('lastFrameAtOrBefore', () => {
  it('picks the last frame dated at or before T, or −1', () => {
    expect(lastFrameAtOrBefore(frames, Date.parse('2026-11-09T09:59:59Z'))).toBe(-1);
    expect(lastFrameAtOrBefore(frames, Date.parse('2026-11-09T10:00:00Z'))).toBe(0);
    expect(lastFrameAtOrBefore(frames, Date.parse('2026-11-09T10:29:59Z'))).toBe(1);
    expect(lastFrameAtOrBefore(frames, Date.parse('2026-11-09T12:00:00Z'))).toBe(2);
    expect(lastFrameAtOrBefore([], 0)).toBe(-1);
  });
});
