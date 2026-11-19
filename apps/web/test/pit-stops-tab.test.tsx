// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { StintsTab } from '../src/views/Stints.tsx';
import { lap, rc, sessionDetail } from './laps.ts';

// The Stints tab by session type: the pit section (#111, D2), where races list the stops and other types say why they
// do not; and the pace per run and the run plan (#114), which fetch race control for races and practice only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
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

const pit = {
  driver_number: 4,
  lap_number: 5,
  date: null,
  pit_ms: 22000,
  lane_ms: 22000,
  stop_ms: null,
  source: 'openf1',
  filled: {},
};
const stints = [
  { driver_number: 4, stint_number: 1, lap_start: 1, lap_end: 5, compound: 'MEDIUM', tyre_age_at_start: 0 },
  { driver_number: 4, stint_number: 2, lap_start: 6, lap_end: 9, compound: 'HARD', tyre_age_at_start: 0 },
];

function mount(type: string, pits: unknown[]) {
  server.use(
    http.get(`*/api/v1/sessions/${KEY}/stints`, () => HttpResponse.json(stints)),
    http.get(`*/api/v1/sessions/${KEY}/pits`, () => HttpResponse.json(pits)),
    http.get(`*/api/v1/sessions/${KEY}/race-control`, () => HttpResponse.json([])),
    http.get(`*/api/v1/sessions/${KEY}/weather`, () => HttpResponse.json([])),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const laps = [lap(4, 1), lap(4, 9)];
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <StintsTab
          session={KEY}
          detail={sessionDetail(type, type, [[4, 'NOR']])}
          laps={laps}
          live={null}
          now={Date.now()}
        />
      </QueryClientProvider>,
    ),
  );
}

describe('StintsTab pit stops', () => {
  it('lists the stops of a race', async () => {
    mount('Race', [pit]);
    await vi.waitFor(() => expect(host.querySelector('table.pits')).not.toBeNull());
    expect(host.textContent).toContain('22.0 s');
  });

  it('says there are no pit rows for a session without any, race or not', async () => {
    mount('Practice', []);
    await vi.waitFor(() => expect(host.textContent).toContain('No pit rows in the OpenF1 data for this session.'));
    expect(host.querySelector('table.pits')).toBeNull();
  });

  it('lists no table for a non-race session that has rows', async () => {
    mount('Practice', [pit]);
    await vi.waitFor(() => expect(host.textContent).toContain('Pit stops are listed for races and sprints.'));
    expect(host.querySelector('table.pits')).toBeNull();
  });
});

describe('StintsTab pace and run plan (#114)', () => {
  let rcCalls = 0;
  type Opts = { rows?: unknown[]; weather?: number; extra?: unknown[] };
  const timed = [
    lap(4, 1, { is_pit_out: true, date_start: '2026-10-31T21:00:00.000Z' }),
    ...[2, 3, 4].map((n) => lap(4, n, { lap_ms: 90_000, date_start: `2026-10-31T21:0${n}:00.000Z` })),
    lap(4, 5, { lap_ms: 91_000, date_start: '2026-10-31T21:05:00.000Z', is_pit_in: true }),
  ];
  function open(type: string, rcStatus = 200, { rows = [], weather = 200, extra = [] }: Opts = {}) {
    rcCalls = 0;
    server.use(
      http.get(`*/api/v1/sessions/${KEY}/stints`, () => HttpResponse.json([...stints.slice(0, 1), ...extra])),
      http.get(`*/api/v1/sessions/${KEY}/pits`, () => HttpResponse.json([])),
      http.get(`*/api/v1/sessions/${KEY}/weather`, () =>
        weather === 200 ? HttpResponse.json([]) : HttpResponse.json({ error: 'x' }, { status: weather }),
      ),
      http.get(`*/api/v1/sessions/${KEY}/race-control`, () => {
        rcCalls++;
        return rcStatus === 200 ? HttpResponse.json(rows) : HttpResponse.json({ error: 'x' }, { status: rcStatus });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <StintsTab
            session={KEY}
            detail={sessionDetail(type, type, [[4, 'NOR']])}
            laps={timed}
            live={null}
            now={Date.now()}
          />
        </QueryClientProvider>,
      ),
    );
  }
  const heading = (text: string) => [...host.querySelectorAll('h2')].some((h) => h.textContent === text);

  it('fetches race control for practice, and draws the run plan above the pace table', async () => {
    open('Practice');
    await vi.waitFor(() => expect(host.querySelector('table.pace')).not.toBeNull());
    expect(rcCalls).toBe(1);
    expect(heading('Run plan')).toBe(true);
    // The stint bars, the run plan, then the pace table.
    const boxes = host.querySelectorAll('.stintbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[1]?.compareDocumentPosition(host.querySelector('table.pace') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(host.textContent).toContain('Fuel loads and engine modes are unknown');
    expect(host.querySelector('table.pace thead')?.textContent).toContain('Track °C');
  });

  it('fetches race control for a race, with the pace per stint and no run plan', async () => {
    open('Race');
    await vi.waitFor(() => expect(host.querySelector('table.pace')).not.toBeNull());
    expect(rcCalls).toBe(1);
    expect(heading('Run plan')).toBe(false);
    expect(host.querySelector('table.pace thead')?.textContent).not.toContain('Track °C');
  });

  it('fetches no race control for qualifying and shows neither', async () => {
    open('Qualifying');
    await vi.waitFor(() => expect(host.querySelector('.stintbox')).not.toBeNull());
    expect(rcCalls).toBe(0);
    expect(host.querySelector('table.pace')).toBeNull();
    expect(heading('Run plan')).toBe(false);
    expect(host.textContent).not.toContain('Fuel loads');
  });

  it('says so when race control fails, and still shows the pace', async () => {
    open('Practice', 500);
    await vi.waitFor(() => expect(host.textContent).toContain('Race control did not load: periods are not left out.'));
    expect(host.querySelector('table.pace')).not.toBeNull();
  });

  it('leaves a lap out for a red flag and draws the red band, from the race-control rows', async () => {
    const rows = [
      rc(null, 'RED FLAG', { category: 'Flag', flag: 'RED', date: '2026-10-31T21:02:00.000Z' }),
      rc(null, 'GREEN LIGHT - PIT EXIT OPEN', { category: 'Flag', flag: 'GREEN', date: '2026-10-31T21:03:30.000Z' }),
    ];
    open('Practice', 200, { rows });
    await vi.waitFor(() => expect(host.querySelector('table.pace')).not.toBeNull());
    expect(host.querySelectorAll('.redband')).toHaveLength(1);
    // Laps 2 and 3 overlap 21:02:00–21:03:30; the out-lap and the in-lap are the pit reason.
    expect(host.querySelector('table.pace [id$="-left"]')?.textContent).toBe(
      '1 out-lap, 1 in-lap, 2 under SC, VSC or red flag',
    );
  });

  it('says the weather did not load, once it has failed', async () => {
    open('Practice', 200, { weather: 500 });
    await vi.waitFor(() => expect(host.textContent).toContain('Weather did not load'));
    expect(host.textContent).toContain('track —, weather did not load');
    expect(host.textContent).not.toContain('No track temperature');
  });

  it('counts the race stints without lap numbers under the table', async () => {
    const bare = (n: number) => ({ ...stints[0], stint_number: n, lap_start: null, lap_end: null });
    open('Race', 200, { extra: [bare(2)] });
    await vi.waitFor(() => expect(host.textContent).toContain('1 stint without lap numbers is not shown.'));
  });

  it('uses the plural for several race stints without lap numbers', async () => {
    const bare = (n: number) => ({ ...stints[0], stint_number: n, lap_start: null, lap_end: 5 });
    open('Race', 200, { extra: [bare(2), bare(3)] });
    await vi.waitFor(() => expect(host.textContent).toContain('2 stints without lap numbers are not shown.'));
  });

  it('says nothing about lap numbers when every stint has them', async () => {
    open('Race');
    await vi.waitFor(() => expect(host.querySelector('table.pace')).not.toBeNull());
    expect(host.textContent).not.toContain('without lap numbers');
  });
});
