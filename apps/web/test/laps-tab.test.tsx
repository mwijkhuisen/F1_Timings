// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { LapsTab } from '../src/views/LapsTab.tsx';
import { field, lap, rc, sessionDetail } from './laps.ts';

// The Laps tab (P4b) in a real React tree: race control only for races and sprints, the bands once it
// arrives, the muted line when it fails, and By phase | Every lap for qualifying only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
const URL_RC = `*/api/v1/sessions/${KEY}/race-control`;
let calls = 0;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  calls = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const answer = (status = 200) =>
  server.use(
    http.get(URL_RC, () => {
      calls++;
      return status === 200
        ? HttpResponse.json([rc(2, 'VIRTUAL SAFETY CAR DEPLOYED'), rc(2, 'VIRTUAL SAFETY CAR ENDING')])
        : HttpResponse.json({ error: 'x' }, { status });
    }),
  );

const render = (type: string, name: string, laps = [lap(1, 1, { lap_ms: 90_000 }), lap(1, 2, { lap_ms: 89_000 })]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <LapsTab session={KEY} detail={sessionDetail(type, name)} laps={laps} />
      </QueryClientProvider>,
    ),
  );
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('LapsTab', () => {
  it('fetches race control once for a race and bands its laps', async () => {
    answer();
    render('Race', 'Race');
    // The table is there at once, without bands.
    expect(host.querySelector('table.laps')).not.toBeNull();
    await vi.waitFor(() => expect(host.querySelector('th.band-vsc')?.textContent).toBe('2 VSC'));
    expect(calls).toBe(1);
    expect(host.querySelector('.tiles')).not.toBeNull();
    expect(button('By phase')).toBeUndefined();
  });

  it('never fetches race control for a practice session', async () => {
    answer();
    render('Practice', 'Practice 1');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(calls).toBe(0);
    expect(host.querySelector('table.laps')).not.toBeNull();
    expect(button('By phase')).toBeUndefined();
  });

  it('says so when race control fails, and keeps the table', async () => {
    answer(500);
    render('Race', 'Sprint');
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Race control did not load: no SC, VSC or red-flag bands.'),
    );
    expect(host.querySelector('table.laps')).not.toBeNull();
    expect(host.querySelector('.band')).toBeNull();
  });

  it('starts qualifying By phase and switches to Every lap', async () => {
    answer();
    render('Qualifying', 'Qualifying', field([3, 2, 1]));
    expect(button('By phase')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('table.quali')).not.toBeNull();
    // The qualifying tiles come first, then the session's.
    expect([...host.querySelectorAll('dl.tiles')].map((d) => d.getAttribute('aria-label'))).toEqual([
      'Qualifying',
      'Session bests',
    ]);
    act(() => button('Every lap')?.click());
    expect(host.querySelector('table.quali')).toBeNull();
    expect(host.querySelector('table.laps')).not.toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(calls).toBe(0);
  });

  it('shows the Δ legend when switched', () => {
    render('Practice', 'Practice 2');
    act(() => button('Δ to own best')?.click());
    expect(host.querySelector('ul.legend')?.textContent).toBe('< 0.5 %< 1 %< 2 %≥ 2 % slower than own best');
    expect(host.querySelector('table.laps')?.getAttribute('aria-label')).toBe('Lap Δ to own best');
  });

  it('says when there are no laps, and fetches nothing', async () => {
    answer();
    render('Race', 'Race', []);
    expect(host.innerHTML).toBe('<p>No laps yet.</p>');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(calls).toBe(0);
  });
});
