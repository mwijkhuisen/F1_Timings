// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { Status } from '../src/views/Status.tsx';

// The status page polls /api/v1/status every 60 s (#105). Date and the intervals are faked; the promises and msw's
// responses stay real (as in season-page.test.tsx).
const body = {
  revision: 'dev',
  states: { scheduled: 0, due: 0, fetched: 0, final: 0, failed: 0 },
  cancelled: 0,
  failed: [],
  recorder: null,
  ingest: null,
  rain: { states: { live: 0, final: 0, failed: 0 }, failed: [] },
  rc_unmatched: [],
};

let root: Root;
let host: HTMLElement;
let client: QueryClient;
let requests: number;
const count = ({ request }: { request: Request }) => {
  if (new URL(request.url).pathname === '/api/v1/status') requests++;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  requests = 0;
  server.events.on('request:start', count);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  root.unmount();
  host.remove();
  client.clear();
  server.events.removeListener('request:start', count);
  vi.useRealTimers();
});

it('asks for /api/v1/status once at mount and again after 60 s', async () => {
  server.use(http.get('*/api/v1/status', () => HttpResponse.json(body)));
  const mounted = Date.now(); // the interval starts at mount; vi.waitFor spends fake time too
  root.render(
    <QueryClientProvider client={client}>
      <Status />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Status'));
  expect(requests).toBe(1);
  await vi.advanceTimersByTimeAsync(59_999 - (Date.now() - mounted));
  expect(requests).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(requests).toBe(2));
});
