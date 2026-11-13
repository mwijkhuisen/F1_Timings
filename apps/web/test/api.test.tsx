import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Seasons } from '@f1/contracts';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ZodError } from 'zod';
import { server } from '../../../test/msw.setup.ts';
import { getJson, HttpError, queryClient, REVISION, retry } from '../src/lib/api.ts';
import { ErrorView, errorText, NEW_VERSION } from '../src/ui/ErrorView.tsx';

// D6: every answer is parsed with its contract; the error view never echoes a body or a ZodError message.

const url = 'http://web.test/api/v1/seasons';
const get = () => getJson(url, Seasons, new AbortController().signal);
const zodError = Seasons.safeParse([{ year: '2026' }]).error;

describe('getJson', () => {
  it('returns the parsed answer', async () => {
    server.use(http.get(url, () => HttpResponse.json([{ year: 2026, meetings: 25, sessions: 121 }])));
    await expect(get()).resolves.toEqual([{ year: 2026, meetings: 25, sessions: 121 }]);
  });

  it('rejects an answer that fails its contract with a ZodError', async () => {
    server.use(http.get(url, () => HttpResponse.json([{ year: 2026, meetings: 25, sessions: 121, extra: 1 }])));
    await expect(get()).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects a non-OK status with an HttpError, without reading the body', async () => {
    server.use(http.get(url, () => HttpResponse.json({ error: 'not found' }, { status: 404 })));
    await expect(get()).rejects.toMatchObject({ name: 'HttpError', status: 404 });
  });

  it('adds ?v=<revision> to the per-session paths only, and every fetch goes through getJson', async () => {
    const seen: string[] = [];
    server.use(
      http.get('http://web.test/api/v1/*', ({ request }) => {
        seen.push(new URL(request.url).pathname + new URL(request.url).search);
        return HttpResponse.json([]);
      }),
    );
    const paths = ['/sessions/1', '/sessions/1/laps', '/sessions/1/stints', '/sessions/1/race-control']
      .concat(['/sessions/1/weather', '/sessions/1/rain'])
      .concat(['/seasons', '/seasons/2026', '/status', '/live', '/recordings']);
    const any = { parse: (d: unknown) => d };
    for (const p of paths) await getJson(`http://web.test/api/v1${p}`, any, new AbortController().signal);
    expect(seen).toEqual(paths.map((p) => `/api/v1${p}${p.startsWith('/sessions/') ? `?v=${REVISION}` : ''}`));
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const fetching = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => /\bfetch\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1));
    // The worker (#121) only passes the page's own requests on and fetches its shell: it builds no API URL.
    expect(fetching).toEqual(['lib/api.ts', 'sw/handlers.ts', 'sw/main.ts']);
  });

  // The stale flag is module state that never resets: each of these gets a fresh copy of the modules.
  const fresh = async () => {
    vi.resetModules();
    return { api: await import('../src/lib/api.ts'), ui: await import('../src/ui/ErrorView.tsx') };
  };
  const answer = (body: JsonBodyType, headers: Record<string, string> = {}) =>
    server.use(http.get(url, () => HttpResponse.json(body, { headers })));
  const seasons = [{ year: 2026, meetings: 1, sessions: 1 }];
  const call = (api: typeof import('../src/lib/api.ts')) => api.getJson(url, Seasons, new AbortController().signal);

  it('a differing F1-Revision resolves with the data and marks the app stale', async () => {
    const { api, ui } = await fresh();
    answer(seasons, { 'F1-Revision': `${REVISION}-other` });
    expect(renderToStaticMarkup(<ui.NewVersion />)).toBe('');
    await expect(call(api)).resolves.toEqual(seasons);
    expect(api.isStale()).toBe(true);
    expect(renderToStaticMarkup(<ui.NewVersion />)).toBe('<p role="alert">A new version is out: reload the page.</p>');
  });

  it('a matching or absent F1-Revision does not mark the app stale', async () => {
    const { api } = await fresh();
    answer(seasons, { 'F1-Revision': REVISION });
    await expect(call(api)).resolves.toHaveLength(1);
    answer(seasons);
    await expect(call(api)).resolves.toHaveLength(1);
    expect(api.isStale()).toBe(false);
  });

  it('an answer that fails its contract rejects with a ZodError and marks the app stale; an HttpError does not', async () => {
    const { api } = await fresh();
    server.use(http.get(url, () => HttpResponse.json({ error: 'x' }, { status: 500 })));
    await expect(call(api)).rejects.toMatchObject({ name: 'HttpError', status: 500 });
    expect(api.isStale()).toBe(false);
    answer([{ year: '2026' }]);
    await expect(call(api)).rejects.toBeInstanceOf(ZodError);
    expect(api.isStale()).toBe(true);
  });

  it("turns a redirect (Access's login page) into a TypeError", async () => {
    server.use(http.get(url, () => HttpResponse.redirect('http://web.test/login', 302)));
    await expect(get()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('queryClient', () => {
  // #121: the default 'online' pauses a query after an `offline` event; the service worker decides offline.
  it("runs queries whatever the browser's online state", () => {
    expect(queryClient.getDefaultOptions().queries?.networkMode).toBe('always');
  });
});

describe('errorText', () => {
  it.each([
    ['a 401', new HttpError(401), 'Your Access session may have expired: reload to sign in.'],
    ['a TypeError', new TypeError('fetch failed'), 'Your Access session may have expired: reload to sign in.'],
    ['a 404', new HttpError(404), 'Not found.'],
    ['a ZodError', zodError, NEW_VERSION],
    ['a 500', new HttpError(500), 'API error'],
    ['anything else', new Error('secret detail'), 'API error'],
  ])('%s', (_name, error, text) => {
    expect(errorText(error)).toBe(text);
  });

  // D5 (#121). Node's navigator has no onLine, which leaves every text above as it is.
  it('says offline for a TypeError while the browser is offline, and only then', () => {
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    vi.stubGlobal('navigator', { onLine: false });
    expect(errorText(new TypeError('Failed to fetch'))).toBe('You are offline: this page needs the network.');
    expect(errorText(new HttpError(401))).toBe('Your Access session may have expired: reload to sign in.');
    vi.stubGlobal('navigator', { onLine: true });
    expect(errorText(new TypeError('Failed to fetch'))).toBe(
      'Your Access session may have expired: reload to sign in.',
    );
  });

  it('renders as an alert without the error message', () => {
    const html = renderToStaticMarkup(<ErrorView error={zodError} />);
    expect(html).toBe('<p role="alert">A new version is out: reload the page.</p>');
  });
});

describe('retry', () => {
  it.each([
    ['a 500', new HttpError(500), true],
    ['a TypeError', new TypeError('fetch failed'), true],
    ['a 401', new HttpError(401), false],
    ['a 404', new HttpError(404), false],
    ['a ZodError', zodError, false],
  ])('retries %s once: %s', (_name, error, again) => {
    expect(retry(0, error)).toBe(again);
    expect(retry(1, error)).toBe(false);
  });
});
