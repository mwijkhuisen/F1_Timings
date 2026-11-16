// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpeedTable } from '../src/views/Speeds.tsx';
import { lap, sessionDetail } from './laps.ts';

// The speed traps and own bests (#114, D1, D3, D5): the boxed tops, the reason behind every —, the own-best gap
// as the Laps tile words it, and the qualifying phase switch.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drivers: [number, string][] = [
  [12, 'ANT'],
  [63, 'RUS'],
  [81, 'PIA'],
];
// ANT's tops are on lap 5 and an in-lap's 360 km/h never counts; RUS has the top of I1 and ST. Q1 and Q2 have laps.
const laps = [
  lap(12, 2, {
    quali_phase: 1,
    lap_ms: 81_000,
    s1_ms: 27_000,
    s2_ms: 36_000,
    s3_ms: 17_950,
    i1_kph: 300,
    i2_kph: 310,
    st_kph: 340,
  }),
  lap(12, 5, {
    quali_phase: 2,
    lap_ms: 80_500,
    s1_ms: 26_800,
    s2_ms: 35_900,
    s3_ms: 17_900,
    i1_kph: 301,
    i2_kph: 315,
    st_kph: 342,
  }),
  lap(12, 6, { quali_phase: 2, lap_ms: 90_000, is_pit_in: true, st_kph: 360 }),
  lap(63, 3, {
    quali_phase: 1,
    lap_ms: 81_500,
    s1_ms: 27_100,
    s2_ms: 36_000,
    s3_ms: 18_400,
    i1_kph: 305,
    i2_kph: 312,
    st_kph: 345,
  }),
  lap(63, 4, { quali_phase: 1, lap_ms: 81_300, s1_ms: 27_300, s2_ms: 36_100, s3_ms: 17_900 }),
  lap(81, 7, { quali_phase: 2, lap_ms: 82_000 }),
];

const show = (type: string, name: string, rows = laps, telemetry = false) =>
  act(() => root.render(<SpeedTable detail={sessionDetail(type, name, drivers)} laps={rows} telemetry={telemetry} />));
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const text = (el: Element) => {
  const clone = el.cloneNode(true) as Element;
  for (const pop of clone.querySelectorAll('.pop')) pop.remove();
  const reason = el.querySelector('.pop')?.textContent;
  return reason ? `${clone.textContent} (${reason})` : (clone.textContent ?? '');
};
const rows = () => [...host.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(text));
const heads = () => [...host.querySelectorAll('thead th')].map((th) => th.textContent);
/** The boxed cells, as [driver, column] in the table's order. */
const boxed = () =>
  [...host.querySelectorAll('tbody tr')].flatMap((tr) =>
    [...tr.children].flatMap((td, i) =>
      td.querySelector('.t-purple') ? [[tr.children[0]?.textContent, heads()[i]]] : [],
    ),
  );

describe('SpeedTable', () => {
  it('lists the drivers by top speed, the speed with its lap under it, an in-lap never counting', () => {
    show('Qualifying', 'Qualifying');
    expect(rows().map((r) => r[0])).toEqual(['RUS', 'ANT', 'PIA']);
    expect(rows()[1]?.slice(1, 4)).toEqual(['301L5', '315, fastestL5', '342L5']);
    expect(host.querySelector('h2')?.textContent).toBe('Speed traps and own bests');
  });

  it('boxes the one top of each column, with ", fastest" for a screen reader', () => {
    show('Qualifying', 'Qualifying');
    expect(boxed()).toEqual([
      ['RUS', 'I1'],
      ['RUS', 'ST'],
      ['ANT', 'I2'],
    ]);
    expect(rows()[0]?.slice(1, 4)).toEqual(['305, fastestL3', '312L3', '345, fastestL3']);
    expect(host.querySelectorAll('.t-purple .vh')).toHaveLength(3);
  });

  it('shows — with its reason: no speed-trap reading, no valid lap with a time, a sum without all three sectors', () => {
    show('Qualifying', 'Qualifying');
    const [, , pia] = rows();
    expect(pia).toEqual([
      'PIA',
      '— (No speed-trap reading on a valid lap)',
      '— (No speed-trap reading on a valid lap)',
      '— (No speed-trap reading on a valid lap)',
      '1:22.000L7',
      '— (Needs a valid time in S1, S2 and S3 in Q2)',
    ]);
    // On Q2, RUS has no lap: both own-best cells are — and say which phase.
    expect(rows()[0]?.slice(4)).toEqual(['— (No valid lap in Q2)', '— (Needs a valid time in S1, S2 and S3 in Q2)']);
  });

  it('opens qualifying on the latest phase with laps, and names it in the own-best headers', () => {
    show('Qualifying', 'Qualifying');
    expect(
      [...host.querySelectorAll('fieldset button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Q1', 'false'],
      ['Q2', 'true'],
    ]);
    expect(heads().slice(-2)).toEqual(['Q2 Best lap', 'Q2 Sum of best sectors']);
    // Q2: ANT's best sectors add up to 1:20.600, 0.100 slower than the lap.
    expect(rows()[1]?.slice(4)).toEqual(['1:20.500L5', '1:20.600+0.100 to own best lap']);
  });

  it('changes only the own-best columns with the phase, the speeds covering the session', () => {
    show('Qualifying', 'Qualifying');
    const speeds = rows().map((r) => r.slice(0, 4));
    act(() => button('Q1')?.click());
    expect(button('Q1')?.getAttribute('aria-pressed')).toBe('true');
    expect(heads().slice(-2)).toEqual(['Q1 Best lap', 'Q1 Sum of best sectors']);
    expect(rows().map((r) => r.slice(0, 4))).toEqual(speeds);
    // Q1: the sum of the best sectors can beat the lap, and says so with a minus sign (the Laps tile's wording).
    expect(rows()[0]?.slice(4)).toEqual(['1:21.300L4', '1:21.000−0.300 to own best lap']);
    expect(rows()[1]?.slice(4)).toEqual(['1:21.000L2', '1:20.950−0.050 to own best lap']);
    // PIA has no Q1 lap.
    expect(rows()[2]?.slice(4)).toEqual(['— (No valid lap in Q1)', '— (Needs a valid time in S1, S2 and S3 in Q1)']);
  });

  it('names sprint qualifying phases SQ', () => {
    show('Qualifying', 'Sprint Qualifying');
    expect([...host.querySelectorAll('fieldset button')].map((b) => b.textContent)).toEqual(['SQ1', 'SQ2']);
    expect(heads()[4]).toBe('SQ2 Best lap');
    expect(rows()[0]?.[4]).toBe('— (No valid lap in SQ2)');
  });

  it('has no phase switch and plain headers outside qualifying, and the own bests cover every lap', () => {
    show('Practice', 'Practice 1');
    expect(host.querySelector('fieldset')).toBeNull();
    expect(heads()).toEqual(['Driver', 'I1', 'I2', 'ST', 'Best lap', 'Sum of best sectors']);
    // ANT's best lap of the session is lap 5, not lap 2.
    expect(rows()[1]?.slice(4)).toEqual(['1:20.500L5', '1:20.600+0.100 to own best lap']);
    // Outside qualifying the reasons keep their wording, naming no phase.
    expect(rows()[2]?.[5]).toBe('— (Needs a valid time in S1, S2 and S3)');
    show('Practice', 'Practice 1', [lap(12, 2, { lap_ms: null })]);
    expect(rows()[0]?.[4]).toBe('— (No valid lap with a time)');
  });

  // P7b, D1: the telemetry columns. ANT's Q2 best lap (L5) has 71 % full throttle and the top 352 on L5; RUS has the
  // session's top 358 on L3 (Q1) but no Q2 lap; PIA's Q2 best lap has no telemetry; ANT's in-lap 380 never counts.
  const tel = [
    lap(12, 2, { ...laps[0], top_kph: 350 }),
    lap(12, 5, { ...laps[1], top_kph: 352, full_throttle: 0.714 }),
    lap(12, 6, { ...laps[2], top_kph: 380 }),
    lap(63, 3, { ...laps[3], top_kph: 358, full_throttle: 0.6 }),
    laps[4] as (typeof laps)[number],
    laps[5] as (typeof laps)[number],
  ];

  it('adds Top after ST and Full throttle after Best lap with telemetry, in the phase of the own bests', () => {
    show('Qualifying', 'Qualifying', tel, true);
    expect(heads()).toEqual([
      'Driver',
      'I1',
      'I2',
      'ST',
      'Top',
      'Q2 Best lap',
      'Q2 Full throttle',
      'Q2 Sum of best sectors',
    ]);
    expect(host.querySelectorAll('.legend li')).toHaveLength(3);
    expect(host.querySelector('.legend')?.textContent).toContain('Top: telemetry, anywhere on the lap');
    act(() => button('Q1')?.click());
    expect(heads()[6]).toBe('Q1 Full throttle');
  });

  it('boxes the session top of Top with its lap under it, an in-lap never counting', () => {
    show('Qualifying', 'Qualifying', tel, true);
    expect(rows()[0]?.[4]).toBe('358, fastestL3');
    expect(rows()[1]?.[4]).toBe('352L5');
    expect(boxed().filter(([, column]) => column === 'Top')).toEqual([['RUS', 'Top']]);
  });

  it('shows the share of throttle on the own best lap as a rounded percent with the lap under it', () => {
    show('Qualifying', 'Qualifying', tel, true);
    expect(rows()[1]?.[6]).toBe('71 %L5');
    act(() => button('Q1')?.click());
    // Q1: RUS's best lap is L4 (no telemetry); the share on L3 is not its best lap's.
    expect(rows()[0]?.[6]).toBe('— (No telemetry for this lap)');
  });

  it('says why a — stands: no telemetry on a valid lap, on this lap, or no lap in the phase', () => {
    show('Qualifying', 'Qualifying', tel, true);
    const [rus, , pia] = rows();
    expect(pia?.[4]).toBe('— (No telemetry on a valid lap)');
    expect(pia?.[6]).toBe('— (No telemetry for this lap)');
    expect(rus?.[6]).toBe('— (No valid lap in Q2)');
    show('Practice', 'Practice 1', [lap(12, 2, { lap_ms: null })], true);
    expect(rows()[0]?.[5]).toBe('— (No valid lap with a time)');
    expect(rows()[0]?.[6]).toBe('— (No valid lap with a time)');
  });

  it('says too few samples when the best lap has telemetry but no share (one sample, or only gaps)', () => {
    show('Qualifying', 'Qualifying', [lap(12, 5, { ...laps[1], top_kph: 352, full_throttle: null })], true);
    expect(rows()[0]?.[4]).toBe('352, fastestL5');
    expect(rows()[0]?.[6]).toBe('— (Too few telemetry samples on this lap)');
  });

  it('leaves both columns out without the telemetry prop', () => {
    show('Qualifying', 'Qualifying', tel);
    expect(heads()).toEqual(['Driver', 'I1', 'I2', 'ST', 'Q2 Best lap', 'Q2 Sum of best sectors']);
    expect(host.querySelectorAll('.legend li')).toHaveLength(2);
  });
});
