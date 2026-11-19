// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { server } from '../../../test/msw.setup.ts';
import { HttpError } from '../src/lib/api.ts';
import { ErrorView, Pending } from '../src/ui/ErrorView.tsx';
import { Status } from '../src/views/Status.tsx';

// #237: an error that a second try can fix says so with a "Try again" button; one that it cannot (an expired Access
// session, a missing page, a new version) does not.

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
  vi.unstubAllGlobals();
});

const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
const offline = () => vi.stubGlobal('navigator', { onLine: false });

describe('ErrorView', () => {
  it('offers Try again for an API error and calls retry on a click', () => {
    const retry = vi.fn();
    act(() => root.render(<ErrorView error={new HttpError(500)} retry={retry} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('API error');
    act(() => button()?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers Try again offline', () => {
    offline();
    act(() => root.render(<ErrorView error={new TypeError('Failed to fetch')} retry={() => {}} />));
    expect(host.textContent).toContain('You are offline');
    expect(button()).toBeDefined();
  });

  it.each([
    ['an expired Access session (401)', new HttpError(401)],
    ['a TypeError while online (the login redirect)', new TypeError('Failed to fetch')],
    ['a missing page (404)', new HttpError(404)],
    ['a new version', new ZodError([])],
  ])('offers nothing for %s', (_name, error) => {
    act(() => root.render(<ErrorView error={error} retry={() => {}} />));
    expect(button()).toBeUndefined();
  });

  it('offers nothing without a retry', () => {
    act(() => root.render(<ErrorView error={new HttpError(500)} />));
    expect(button()).toBeUndefined();
  });
});

describe('Pending', () => {
  it('passes retry to the error, and shows Loading… without one', () => {
    act(() => root.render(<Pending error={new HttpError(503)} retry={() => {}} />));
    expect(button()).toBeDefined();
    act(() => root.render(<Pending error={null} retry={() => {}} />));
    expect(host.textContent).toBe('Loading…');
  });
});

describe('a caller', () => {
  it('Status asks again on Try again and shows the page when the second answer is good', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/v1/status', () => {
        calls++;
        return calls === 1
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({
              revision: 'dev',
              states: { scheduled: 0, due: 0, fetched: 0, final: 0, failed: 0 },
              cancelled: 0,
              failed: [],
              recorder: null,
              ingest: null,
              rain: { states: { live: 0, final: 0, failed: 0 }, failed: [] },
              rc_unmatched: [],
              standings_mismatch: [],
            });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Status />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(button()).toBeDefined());
    act(() => button()?.click());
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Status'));
    expect(calls).toBe(2);
    client.clear();
  });
});
