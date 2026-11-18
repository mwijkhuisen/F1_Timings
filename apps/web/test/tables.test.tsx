// @vitest-environment happy-dom
import { Laps } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTables, savedPicks } from '../src/lib/tables.ts';
import { Comparison } from '../src/views/Compare.tsx';
import { QualiSwitch } from '../src/views/LapsTab.tsx';
import { LapTable } from '../src/views/LapTable.tsx';
import { Session } from '../src/views/Session.tsx';
import { SpeedTable } from '../src/views/Speeds.tsx';
import { lap, sessionDetail } from './laps.ts';

// #237 D1: the table settings and the driver picks are remembered in `f1.tables`, each field checked on the way in.

vi.mock('../src/views/Chart.tsx', () => ({ Chart: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
const PATH = '/2026/1300-mexico-city/11000-race';
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

const store = (v: unknown) => localStorage.setItem('f1.tables', JSON.stringify(v));
const stored = () => JSON.parse(localStorage.getItem('f1.tables') ?? '{}') as Record<string, unknown>;
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const pressed = () => [...host.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);
/** A storage that throws on every call. */
const broken = () =>
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });

const drivers: [number, string][] = [
  [1, 'VER'],
  [3, 'RIC'],
  [63, 'RUS'],
];
const raceLaps = [lap(1, 1, { lap_ms: 90_000 }), lap(3, 1, { lap_ms: 91_000 }), lap(63, 1, { lap_ms: 92_000 })];
const qualiLaps = [
  lap(1, 1, { quali_phase: 1, lap_ms: 90_000 }),
  lap(1, 2, { quali_phase: 2, lap_ms: 89_000 }),
  lap(3, 1, { quali_phase: 1, lap_ms: 91_000 }),
];

describe('readTables', () => {
  it('keeps the fields that pass their check and drops the rest', () => {
    store({ metric: 's2', show: 'nope', columns: 'yes', phase: 2.5, byPhase: false, window: '107', picks: [44, 1] });
    expect(readTables()).toEqual({ metric: 's2', byPhase: false, window: '107', picks: [44, 1] });
    store({ picks: [1, 'x'] });
    expect(readTables()).toEqual({});
    localStorage.setItem('f1.tables', '{not json');
    expect(readTables()).toEqual({});
    localStorage.setItem('f1.tables', '[1]');
    expect(readTables()).toEqual({});
  });

  it('savedPicks keeps the drivers the session has, in saved order, else null', () => {
    store({ picks: [63, 99, 1] });
    expect(savedPicks([{ number: 1 }, { number: 3 }, { number: 63 }])).toEqual([63, 1]);
    expect(savedPicks([{ number: 3 }])).toBeNull();
  });
});

describe('LapTable', () => {
  const show = () =>
    act(() =>
      root.render(<LapTable detail={sessionDetail('Race', 'Race', drivers)} laps={Laps.parse(raceLaps)} marks />),
    );

  it('starts from the stored metric, Times | Δ and orientation', () => {
    store({ metric: 's2', show: 'delta', columns: true });
    show();
    expect(pressed()).toEqual(['S2', 'Δ to own best', 'Drivers as columns']);
  });

  it('writes each click', () => {
    show();
    expect(pressed()).toEqual(['Lap', 'Times']);
    click(button('S3'));
    click(button('Δ to own best'));
    click(button('Drivers as columns'));
    expect(stored()).toEqual({ metric: 's3', show: 'delta', columns: true });
    click(button('Times'));
    expect(stored().show).toBe('times');
  });

  it('ignores a bad stored value', () => {
    store({ metric: 'bogus', show: 7 });
    show();
    expect(pressed()).toEqual(['Lap', 'Times']);
  });

  it('shows the defaults and still clicks when storage throws', () => {
    broken();
    show();
    expect(pressed()).toEqual(['Lap', 'Times']);
    click(button('S1'));
    expect(pressed()).toEqual(['S1', 'Times']);
  });
});

describe('SpeedTable', () => {
  const show = () =>
    act(() => root.render(<SpeedTable detail={sessionDetail('Qualifying', 'Qualifying', drivers)} laps={qualiLaps} />));

  it('opens on the stored phase when the session has it, on the latest otherwise', () => {
    store({ phase: 1 });
    show();
    expect(pressed()).toEqual(['Q1']);
    store({ phase: 3 });
    act(() => root.unmount());
    root = createRoot(host);
    show();
    expect(pressed()).toEqual(['Q2']);
  });

  it('writes a pick', () => {
    show();
    click(button('Q1'));
    expect(stored()).toEqual({ phase: 1 });
  });
});

describe('QualiSwitch', () => {
  const show = () =>
    act(() =>
      root.render(
        <QualiSwitch detail={sessionDetail('Qualifying', 'Qualifying', drivers)} quali={{ phases: [] } as never}>
          <p>every lap</p>
        </QualiSwitch>,
      ),
    );

  it('starts from the stored view and writes a click', () => {
    store({ byPhase: false });
    show();
    expect(pressed()).toEqual(['Every lap']);
    click(button('By phase'));
    expect(stored()).toEqual({ byPhase: true });
  });
});

describe('Comparison', () => {
  const show = () => {
    const detail = sessionDetail('Race', 'Race', drivers);
    const d = [
      { number: 1, acronym: 'VER', name: null, team: null, colour: null },
      { number: 3, acronym: 'RIC', name: null, team: null, colour: null },
    ] as never;
    act(() =>
      root.render(
        <Comparison detail={detail} drivers={d} laps={Laps.parse(raceLaps)} periods={[]} onReference={() => {}} />,
      ),
    );
  };

  it('starts from the stored window and writes a click', () => {
    store({ window: '107' });
    show();
    expect(pressed().slice(0, 1)).toEqual(['107 %']);
    click(button('Fit'));
    expect(stored()).toEqual({ window: 'fit' });
  });
});

describe('Session: the driver picks', () => {
  const render = (url: string, view: 'compare' | 'minisectors' = 'minisectors') => {
    history.replaceState(null, '', url);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['session', KEY], sessionDetail('Race', 'Race', drivers, []));
    client.setQueryData(['laps', KEY], [lap(1, 1), lap(3, 1), lap(63, 1)]);
    client.setQueryData(['season', 2026], null);
    client.setQueryData(['recordings'], null);
    client.setQueryData(['weather', KEY], []);
    client.setQueryData(['live'], null);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Session session={KEY} view={view} />
        </QueryClientProvider>,
      ),
    );
  };
  const chips = () => [...host.querySelectorAll('.chip')].map((c) => c.firstChild?.textContent);

  it('starts from the stored picks the session has, in stored order', () => {
    store({ picks: [63, 99, 3] });
    render(`${PATH}/minisectors`);
    expect(chips()).toEqual(['RUS', 'RIC']);
  });

  it('starts from the top 2 when the session has none of them', () => {
    store({ picks: [99, 98] });
    render(`${PATH}/minisectors`);
    expect(chips()).toEqual(['VER', 'RIC']);
  });

  it('lets ?d= win over the stored picks', () => {
    store({ picks: [63] });
    render(`${PATH}/minisectors?d=3,1`);
    expect(chips()).toEqual(['RIC', 'VER']);
  });

  it('writes a pick', () => {
    render(`${PATH}/minisectors`);
    click(host.querySelector('[aria-label="Remove VER"]'));
    expect(stored()).toEqual({ picks: [3] });
  });

  it('shows the top 2 and still picks when storage throws', () => {
    broken();
    render(`${PATH}/minisectors`);
    expect(chips()).toEqual(['VER', 'RIC']);
    click(host.querySelector('[aria-label="Remove VER"]'));
    expect(chips()).toEqual(['RIC']);
  });
});
