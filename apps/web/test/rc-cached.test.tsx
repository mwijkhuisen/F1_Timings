// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { Compare } from '../src/views/Compare.tsx';
import { StintsTab } from '../src/views/Stints.tsx';
import { lap, rc, sessionDetail } from './laps.ts';

// The Laps tab fills ['race-control', key] for every session type; outside a race Stints and Compare must ignore it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
const vsc = [
  rc(3, 'VIRTUAL SAFETY CAR DEPLOYED', { category: 'SafetyCar', scope: 'Track', flag: null }),
  rc(4, 'VIRTUAL SAFETY CAR ENDING', { category: 'SafetyCar', scope: 'Track', flag: null }),
];
const stints = [
  { driver_number: 4, stint_number: 1, lap_start: 1, lap_end: 5, compound: 'MEDIUM', tyre_age_at_start: 0 },
];

async function stintsTab(type: string) {
  server.use(
    http.get(`*/api/v1/sessions/${KEY}/stints`, () => HttpResponse.json(stints)),
    http.get(`*/api/v1/sessions/${KEY}/pits`, () => HttpResponse.json([])),
    http.get(`*/api/v1/sessions/${KEY}/race-control`, () => HttpResponse.json(vsc)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['race-control', KEY], vsc);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <StintsTab
          session={KEY}
          detail={sessionDetail(type, type, [[4, 'NOR']])}
          laps={[lap(4, 1), lap(4, 5)]}
          live={null}
          now={Date.now()}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('.stintbox')).not.toBeNull());
  const out = { text: host.textContent ?? '', vsclines: host.querySelectorAll('.vscline').length };
  act(() => root.unmount());
  host.remove();
  return out;
}

describe('a cached race-control answer outside a race', () => {
  it('draws no bands on the Stints tab in practice, and does in a race', async () => {
    const practice = await stintsTab('Practice');
    expect(practice.text).not.toContain('VSC, laps 3–4');
    expect(practice.vsclines).toBe(0);
    const race = await stintsTab('Race');
    expect(race.text).toContain('VSC, laps 3–4');
    expect(race.vsclines).toBe(1);
  });

  it('shows no race-control error line on Compare in practice', () => {
    const html = (type: string) => {
      const client = new QueryClient();
      client
        .getQueryCache()
        .build(client, { queryKey: ['race-control', KEY] })
        .setState({ status: 'error', error: new Error('x'), data: [], dataUpdatedAt: Date.now() });
      const d = [
        { number: 1, acronym: 'VER', name: null, team: null },
        { number: 4, acronym: 'NOR', name: null, team: null },
      ];
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Compare
            session={KEY}
            detail={sessionDetail(type, type)}
            drivers={d}
            laps={[lap(1, 1), lap(4, 1)]}
            onReference={() => {}}
          />
        </QueryClientProvider>,
      );
    };
    expect(html('Practice')).not.toContain('Race control did not load');
    expect(html('Race')).toContain('Race control did not load');
  });
});
