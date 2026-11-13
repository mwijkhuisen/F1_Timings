// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { App } from '../src/App.tsx';
import { ErrorBoundary } from '../src/ui/ErrorView.tsx';
import { live, recordings, seasons } from './season-data.ts';

// The page's error boundary (#100): reset by the pathname inside <main>, so a view that throws leaves the header usable
// and a navigation resets it. Status throws while `boom.on` is set; everything else in it is real.

const boom = vi.hoisted(() => ({ on: false }));
vi.mock('../src/views/Status.tsx', async (load) => {
  const m = await load<typeof import('../src/views/Status.tsx')>();
  const { createElement } = await import('react');
  return {
    ...m,
    Status: () => {
      if (boom.on) throw new Error('status');
      return createElement(m.Status);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = {
  revision: 'dev',
  states: { scheduled: 0, due: 0, fetched: 0, final: 0, failed: 0 },
  cancelled: 0,
  failed: [],
  recorder: null,
  ingest: null,
  rain: { states: { live: 0, final: 0, failed: 0 }, failed: [] },
  rc_unmatched: [],
};
const BROKEN = 'Something went wrong: reload the page.';

let root: Root;
let host: HTMLElement;
let client: QueryClient;

beforeEach(() => {
  server.use(
    http.get('*/api/v1/seasons', () => HttpResponse.json(seasons)),
    http.get('*/api/v1/live', () => HttpResponse.json(live)),
    http.get('*/api/v1/status', () => HttpResponse.json(status)),
    http.get('*/api/v1/recordings', () => HttpResponse.json(recordings)),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  boom.on = false;
  history.replaceState(null, '', '/');
});

const h1 = () => host.querySelector('main h1')?.textContent;

it('a view that throws leaves the header usable, and a navigation resets the boundary', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    boom.on = true;
    history.replaceState(null, '', '/status');
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector('main')?.textContent).toContain(BROKEN);
    expect(host.querySelector('nav[aria-label="Session switcher"]')).not.toBeNull();
    const pages = host.querySelector('nav[aria-label="Pages"]');
    expect(pages).not.toBeNull();
    // The header's own queries still answer: /live names an open recording.
    await vi.waitFor(() => expect(pages?.querySelector('.pill.live')).not.toBeNull());

    const replays = [...(pages?.querySelectorAll('a') ?? [])].find((a) => a.textContent === 'Replays');
    await act(async () => replays?.click());
    expect(location.pathname).toBe('/replay');
    await vi.waitFor(() => expect(h1()).toBe('Replays'));
    expect(host.textContent).not.toContain(BROKEN);

    // Back to /status, fixed: the new path reset the boundary, so Status renders.
    boom.on = false;
    await act(async () => {
      history.replaceState(null, '', '/status');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await vi.waitFor(() => expect(h1()).toBe('Status'));
    expect(host.textContent).not.toContain(BROKEN);
  } finally {
    error.mockRestore();
  }
});

let mounts = 0;
function Child({ fail }: { fail: boolean }) {
  useEffect(() => {
    mounts++;
  }, []);
  if (fail) throw new Error('child');
  return <p>ok</p>;
}

it('a new reset value clears a failure, and never remounts a healthy child', () => {
  mounts = 0;
  const show = (reset: string, fail: boolean) =>
    act(() =>
      root.render(
        <ErrorBoundary reset={reset}>
          <Child fail={fail} />
        </ErrorBoundary>,
      ),
    );
  show('/a/laps', false);
  show('/a/compare', false); // a session's tab switch: same page, new path
  expect(mounts).toBe(1);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    show('/a/compare', true);
    expect(host.textContent).toBe(BROKEN);
    show('/a/compare', false); // the same path: still failed
    expect(host.textContent).toBe(BROKEN);
    show('/a/stints', false);
    expect(host.textContent).toBe('ok');
  } finally {
    error.mockRestore();
  }
});
