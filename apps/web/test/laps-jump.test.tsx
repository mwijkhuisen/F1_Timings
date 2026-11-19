// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { LapsTab } from '../src/views/LapsTab.tsx';
import { lap, rc, sessionDetail } from './laps.ts';

// The jump links of the Laps tab (#238): one per section that renders, to the section's id.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
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
});

const render = (rows: ReturnType<typeof rc>[]) => {
  server.use(
    http.get(`*/api/v1/sessions/${KEY}/race-control`, () => HttpResponse.json(rows)),
    http.get(`*/api/v1/sessions/${KEY}/overtakes`, () => HttpResponse.json([])),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <LapsTab
          session={KEY}
          detail={sessionDetail('Practice', 'Practice 1')}
          laps={[lap(1, 1, { lap_ms: 90_000 })]}
        />
      </QueryClientProvider>,
    ),
  );
};
const links = () => [...host.querySelectorAll('.jump a')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('LapsTab jump links', () => {
  it('links the three sections, with their ids, once race control is there', async () => {
    render([rc(2, 'SAFETY CAR DEPLOYED', { category: 'SafetyCar' })]);
    await vi.waitFor(() => expect(host.querySelector('.rclog')).not.toBeNull());
    expect(links()).toEqual([
      ['Laps', '#laps'],
      ['Speed traps', '#speeds'],
      ['Race control', '#race-control'],
    ]);
    expect(host.querySelector('.jump')?.textContent).toBe('Laps · Speed traps · Race control');
    for (const id of ['laps', 'speeds', 'race-control']) expect(host.querySelectorAll(`#${id}`)).toHaveLength(1);
    // The row sits at the top of the tab, before the tiles.
    expect(host.firstElementChild?.classList.contains('jump')).toBe(true);
  });

  it('has no Race control link without race-control messages', async () => {
    render([]);
    await vi.waitFor(() => expect(host.textContent).toContain('No race-control messages'));
    expect(links()).toEqual([
      ['Laps', '#laps'],
      ['Speed traps', '#speeds'],
    ]);
    expect(host.querySelector('.jump')?.textContent).toBe('Laps · Speed traps');
    expect(host.querySelector('#race-control')).toBeNull();
  });
});
