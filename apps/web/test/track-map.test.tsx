// @vitest-environment happy-dom
import type { Views } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Positions } from '../src/lib/stream.ts';
import { fmtClock } from '../src/lib/time.ts';
import { TrackMap } from '../src/views/TrackMap.tsx';
import { DRIVERS } from './feed-state.ts';

// The Map tab's drawing (P7a, A§13) in a real React tree: the dots at T in team colour with their acronyms, a hollow
// car that never moves, `move` only between two samples of one run, and the words of each state. Positions are passed
// as props, the outline is in the query cache beforehand: nothing is fetched.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.parse('2026-11-08T17:00:10Z');
const drivers = DRIVERS as Views['DriverList'];
let root: Root;
let host: HTMLElement;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  client.setQueryData(['map', 'br-1940'], { outline: 'M 0 0 L 100 50 Z', osm: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const car = (x: number, y: number, t: number, run = t) => ({ x, y, t, run });
/** The store's positions channel, holding `pos`. */
const channel = (pos: Positions | null | undefined) => ({ get: () => pos, subscribe: () => () => {} });
const render = (pos: Positions | null | undefined, { circuit = 'Interlagos', now = T } = {}) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <TrackMap circuit={circuit} positions={channel(pos)} drivers={drivers} now={() => now} playing={false} />
      </QueryClientProvider>,
    ),
  );
const cars = () => [...host.querySelectorAll<SVGGElement>('g.car')];
const byText = (text: string) => cars().find((g) => g.querySelector('text')?.textContent === text) as SVGGElement;

describe('the outline', () => {
  it('draws the halo and the outline in a viewBox of the bounding box plus 8 %', () => {
    render(null);
    const svg = host.querySelector('svg.trackmap') as SVGSVGElement;
    expect(svg.getAttribute('viewBox')).toBe('-8 -8 116 66');
    expect(svg.querySelector('path.map-halo')?.getAttribute('d')).toBe('M 0 0 L 100 50 Z');
    expect(svg.querySelector('path.map-outline')?.getAttribute('d')).toBe('M 0 0 L 100 50 Z');
  });

  it('says so for a venue without an outline, and for a circuit with no mapping', () => {
    render(null, { circuit: 'Nowhere' });
    expect(host.textContent).toContain('No circuit outline for this venue.');
    expect(host.querySelector('svg')).toBeNull();
  });

  it('credits the outline (ADR-0008) in the foot, links inline', () => {
    render(null);
    const foot = host.querySelector('p.foot.rainsrc') as HTMLElement;
    expect(foot.textContent).toBe('Circuit outline: bacinger/f1-circuits (MIT), simplified.');
    expect(foot.querySelector('a[href="https://github.com/bacinger/f1-circuits"]')).not.toBeNull();
  });
});

describe('the cars at T', () => {
  const pos: Positions = {
    at: T - 500,
    cars: { 1: car(1500, -250, T - 500), 3: car(-40, 20, T - 600), 9: car(0, 0, T - 700) },
  };

  it('draws a dot per car in its team colour, with the acronym, or the number when the DriverList lacks it', () => {
    render(pos);
    expect(cars()).toHaveLength(3);
    expect(host.querySelectorAll('g.car circle')).toHaveLength(3);
    expect(cars().map((g) => g.querySelector('text')?.textContent)).toEqual(['AAA', 'CCC', '9']);
    const a = byText('AAA');
    expect(a.style.getPropertyValue('--team')).not.toBe(''); // AAA's TeamColour
    expect(a.style.getPropertyValue('--x')).toBe('1.5'); // metres in km
    expect(a.style.getPropertyValue('--y')).toBe('-0.25');
    expect(byText('CCC').style.getPropertyValue('--team')).toBe(''); // no colour in the DriverList: --muted by CSS
    expect(cars().every((g) => g.getAttribute('class') === 'car')).toBe(true); // first sample: a jump
    expect(host.querySelector('[style*="transform"]')).toBeNull();
  });

  it('labels the picture with the time at T, the cars and those without a recent position', () => {
    render({ at: T - 500, cars: { 1: car(0, 0, T - 500), 2: car(0, 0, T - 2500) } });
    expect(host.querySelector('svg.trackmap')?.getAttribute('role')).toBe('img');
    expect(host.querySelector('svg.trackmap')?.getAttribute('aria-label')).toBe(
      `Car positions at ${fmtClock(T)}: 2 cars, 1 without a recent position`,
    );
  });

  it('hollows a car 1.6 s behind the newest sample, and never moves it', () => {
    render({ at: T, cars: { 1: car(0, 0, T - 2000), 2: car(5, 5, T - 1000) } });
    render({ at: T, cars: { 1: car(1, 1, T - 1600, T - 2000), 2: car(6, 6, T, T - 1000) } });
    expect(byText('AAA').getAttribute('class')).toBe('car stale');
    expect(byText('BBB').getAttribute('class')).toBe('car move');
  });

  it('keeps a car 1.4 s behind the newest sample solid (line jitter is not a dropout)', () => {
    render({ at: T, cars: { 1: car(0, 0, T - 1400) } });
    expect(byText('AAA').getAttribute('class')).toBe('car');
  });

  it('hollows every car once the newest sample is 5 s behind T (the position feed stopped)', () => {
    render({ at: T - 5100, cars: { 1: car(0, 0, T - 5100), 2: car(0, 0, T - 5100) } });
    expect(cars().map((g) => g.getAttribute('class'))).toEqual(['car stale', 'car stale']);
    render({ at: T - 5000, cars: { 1: car(0, 0, T - 5000), 2: car(0, 0, T - 5000) } });
    expect(cars().map((g) => g.getAttribute('class'))).toEqual(['car', 'car']);
  });

  it('moves a car only between two samples of one run: a gap, or a seek, jumps', () => {
    render({ at: 1000, cars: { 1: car(0, 0, T - 9000, T - 9000) } }, { now: T - 8000 });
    expect(byText('AAA').getAttribute('class')).toBe('car'); // the first sample
    render({ at: 1000, cars: { 1: car(10, 0, T - 8500, T - 9000) } }, { now: T - 8000 });
    expect(byText('AAA').getAttribute('class')).toBe('car move'); // the next one of the same run
    render({ at: 1000, cars: { 1: car(20, 0, T - 5000, T - 5000) } }, { now: T - 4000 });
    expect(byText('AAA').getAttribute('class')).toBe('car'); // a gap started a new run: it jumps
    render({ at: 1000, cars: { 1: car(0, 0, T - 20_000, T - 20_000) } }, { now: T - 19_000 });
    expect(byText('AAA').getAttribute('class')).toBe('car'); // a seek back: it jumps
    expect(host.querySelectorAll('g.car')).toHaveLength(1); // the same element throughout: a transition can run
  });
});

describe('the states', () => {
  it('says why there is no car while pos is null (no fitted frame yet) or not asked', () => {
    for (const pos of [null, undefined]) {
      render(pos);
      expect(cars()).toHaveLength(0);
      expect(host.textContent).toContain(
        'No car positions yet: the map places the cars once the feed has one full lap on track.',
      );
    }
  });

  it('says so when the fit is there and no car has a position', () => {
    render({ at: T, cars: {} });
    expect(cars()).toHaveLength(0);
    expect(host.textContent).toContain('No car positions in the feed yet.');
    expect(host.textContent).not.toContain('No car positions yet:');
  });

  it('shows Loading… until the outline file is in', () => {
    client.removeQueries({ queryKey: ['map', 'br-1940'] });
    render(null);
    expect(host.textContent).toContain('Loading…');
    expect(host.querySelector('svg')).toBeNull();
  });
});
