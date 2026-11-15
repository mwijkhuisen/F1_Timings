// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { StintsTab } from '../src/views/Stints.tsx';
import { lap, sessionDetail } from './laps.ts';

// The Stints tab's pit section by session type (#111, D2): races list the stops, other types say why they do not.

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

const pit = { driver_number: 4, lap_number: 5, date: null, pit_ms: 22000, lane_ms: 22000, stop_ms: null };
const stints = [
  { driver_number: 4, stint_number: 1, lap_start: 1, lap_end: 5, compound: 'MEDIUM', tyre_age_at_start: 0 },
  { driver_number: 4, stint_number: 2, lap_start: 6, lap_end: 9, compound: 'HARD', tyre_age_at_start: 0 },
];

function mount(type: string, pits: unknown[]) {
  server.use(
    http.get(`*/api/v1/sessions/${KEY}/stints`, () => HttpResponse.json(stints)),
    http.get(`*/api/v1/sessions/${KEY}/pits`, () => HttpResponse.json(pits)),
    http.get(`*/api/v1/sessions/${KEY}/race-control`, () => HttpResponse.json([])),
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
