// @vitest-environment happy-dom
import type { Rain } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RainMapCard } from '../src/views/RainMap.tsx';
import { sessionDetail } from './laps.ts';

// The rain map in a real React tree (P5c, A§13): the slider moves the frame; with a cap (the player's T) no frame
// after T is drawn or reachable, and the slider follows T while it sits on the newest frame.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = sessionDetail('Race', 'Race');
const detail = {
  ...base,
  session: { ...base.session, date_start: '2026-11-09T14:00:00Z' },
  meeting: { ...base.meeting, circuit_short_name: 'Monza' },
};
const at = (hm: string) => Date.parse(`2026-11-09T${hm}:00Z`);
// Frame k has rain in cell 24 (the centre) only, 0.1·(k + 1) mm: 0.4, 0.8, 1.2 and 1.6 mm/h.
const rain: Rain = {
  grid: { map_id: 'it-1922', centre_lat: 45.6216, centre_lon: 9.2888, size: 7, step_m: 1500, state: 'final' },
  frames: ['14:00', '14:15', '14:30', '14:45'].map((hm, k) => {
    const mm = Array<number | null>(49).fill(0);
    mm[24] = 0.1 * (k + 1);
    return { date: `2026-11-09T${hm}:00Z`, mm };
  }),
};
const heaviest = (k: number) => `Rain in 1 of 49 cells, heaviest ${(0.4 * (k + 1)).toFixed(1)} mm/h, at the circuit`;

let root: Root;
let host: HTMLElement;
let client: QueryClient;

beforeEach(() => {
  // Filled beforehand, and no query runs: nothing is fetched or imported.
  client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  client.setQueryData(['rain', detail.session.session_key], rain);
  client.setQueryData(['map', 'it-1922'], { outline: 'M 0 0 L 1 1 Z', osm: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (cap?: number) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RainMapCard detail={detail} cap={cap} />
      </QueryClientProvider>,
    ),
  );
const range = () => host.querySelector<HTMLInputElement>('input[aria-label="Rain map time"]') as HTMLInputElement;
// React listens to `input`; the native setter bypasses its value tracker, as a real drag does.
const slide = (v: number) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(range(), String(v));
    range().dispatchEvent(new Event('input', { bubbles: true }));
  });
const summary = () => host.querySelector('.rainsum')?.textContent;
const shown = () => ({ value: range().value, max: range().max, output: host.querySelector('output')?.textContent });

describe('the rain map slider', () => {
  it('moves the frame: the summary, the field’s name and the time follow', () => {
    render();
    expect(shown()).toEqual({ value: '0', max: '3', output: '15:00' }); // the first frame at the start
    expect(summary()).toBe(heaviest(0));
    slide(2);
    expect(shown()).toEqual({ value: '2', max: '3', output: '15:30' });
    expect(summary()).toBe(heaviest(2));
    expect(host.querySelector('svg.rainfield')?.getAttribute('aria-label')).toBe(heaviest(2));
    expect(range().getAttribute('aria-valuetext')).toBe('15:30 Amsterdam time');
  });
});

describe('the rain map up to T (the player)', () => {
  it('draws no frame after T: the slider ends at the last frame at or before T', () => {
    render(at('14:20'));
    expect(shown()).toEqual({ value: '1', max: '1', output: '15:15' });
    expect(summary()).toBe(heaviest(1));
    slide(3); // past the end: the browser clamps to max; the handler never sees more
    expect(Number(range().value)).toBeLessThanOrEqual(1);
    expect(summary()).not.toBe(heaviest(3));
    expect(summary()).not.toBe(heaviest(2));
  });

  it('says so while T is before the first frame', () => {
    render(at('13:59'));
    expect(host.textContent).toContain('No rain frame up to this time yet.');
    expect(range()).toBeNull();
  });

  it('follows T across a frame boundary while on the newest frame; moved back, it stays until moved to the newest', () => {
    render(at('14:20'));
    render(at('14:29')); // a tick inside the same frame: nothing moves
    expect(shown().value).toBe('1');
    render(at('14:30'));
    expect(shown()).toEqual({ value: '2', max: '2', output: '15:30' });
    expect(summary()).toBe(heaviest(2));

    slide(0); // the user looks back
    render(at('14:45'));
    expect(shown()).toEqual({ value: '0', max: '3', output: '15:00' });
    expect(summary()).toBe(heaviest(0));

    slide(3); // back on the newest: following again
    expect(shown().value).toBe('3');
    render(at('14:10')); // a seek back: capped, and still following
    expect(shown()).toEqual({ value: '0', max: '0', output: '15:00' });
    render(at('14:16'));
    expect(shown()).toEqual({ value: '1', max: '1', output: '15:15' });
  });

  it('a seek back before a picked frame drops the pick and follows T again', () => {
    render(at('14:50'));
    slide(2);
    render(at('14:20')); // frame 2 is after T now
    expect(shown()).toEqual({ value: '1', max: '1', output: '15:15' });
    render(at('14:46'));
    expect(shown().value).toBe('3');
  });
});
