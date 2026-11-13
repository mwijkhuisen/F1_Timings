import { describe, expect, it, vi } from 'vitest';
import { activate, type Deps, install, respond } from '../src/sw/handlers.ts';
import { FakeCaches, ORIGIN } from './caches.ts';

// The service worker (#121): it keeps the shell and a final session's answers, and never anything live, a redirect, a
// non-200 or a no-store answer. Fakes come in as dependencies: no msw, no network. Node's Request refuses
// mode 'navigate', so requests are plain objects.

const NAME = 'f1-0123456789ab';

const req = (path: string, init: { method?: string; mode?: string; origin?: string } = {}) =>
  ({ url: `${init.origin ?? ORIGIN}${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }) as Request;

const answer = (body: string, headers: Record<string, string>, status = 200) => new Response(body, { status, headers });
const FINAL = { 'content-type': 'application/json', 'cache-control': 'private, max-age=86400' };
const json = (headers: Record<string, string> = FINAL, status = 200) => answer('{"ok":1}', headers, status);
const redirected = (res: Response) => Object.defineProperty(res, 'redirected', { value: true });
// Status 0 is out of Response's range: what a `redirect: 'manual'` fetch hands back.
const opaqueRedirect = () =>
  ({ type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers() }) as Response;

/** A worker on fake caches whose network answers `net` (a function of the request), or rejects as offline. */
function setup(net: ((url: string) => Response) | 'offline' = () => json()) {
  const caches = new FakeCaches();
  const fetch = vi.fn(async (input: Request | string, _init?: RequestInit) => {
    if (net === 'offline') throw new TypeError('Failed to fetch');
    return net(typeof input === 'string' ? input : input.url);
  });
  const d: Deps = {
    caches: caches.storage,
    fetch,
    cacheName: NAME,
    shell: ['/', '/assets/index-a.js'],
    origin: ORIGIN,
  };
  const stored = async () => [...(await caches.open(NAME)).entries.keys()];
  return { caches, fetch, d, stored };
}

const SESSION = '/api/v1/sessions/9158';
const ROUTES = ['', '/laps', '/stints', '/pits', '/race-control', '/weather', '/rain'];

describe("a final session's answers", () => {
  it.each(ROUTES.flatMap((r) => [`${SESSION}${r}`, `${SESSION}${r}?v=abc123`]))(
    'keeps %s under its full URL',
    async (path) => {
      const { d, stored } = setup();
      const res = await respond(req(path), d);
      expect(await res?.json()).toEqual({ ok: 1 });
      expect(await stored()).toEqual([`${ORIGIN}${path}`]);
    },
  );

  it.each([
    ['no-store', () => json({ 'content-type': 'application/json', 'cache-control': 'no-store' })],
    ['no-store beside a max-age', () => json({ ...FINAL, 'cache-control': 'private, max-age=86400, no-store' })],
    ['no Cache-Control', () => json({ 'content-type': 'application/json' })],
    ['max-age=0', () => json({ ...FINAL, 'cache-control': 'private, max-age=0' })],
    ['no-cache beside a max-age', () => json({ ...FINAL, 'cache-control': 'no-cache, max-age=60' })],
    ['NO-STORE in capitals', () => json({ ...FINAL, 'cache-control': 'NO-STORE, max-age=60' })],
    ['a 404', () => json({ ...FINAL }, 404)],
    ['a 500', () => json({ ...FINAL }, 500)],
    ['a redirected answer', () => redirected(json())],
    ['an opaque redirect (status 0)', opaqueRedirect],
    ['an HTML 200 under an API path', () => answer('<!doctype html>', { ...FINAL, 'content-type': 'text/html' })],
  ])('never keeps %s, and hands it to the page as it came', async (_name, make) => {
    const res = make();
    const { d, stored } = setup(() => res);
    expect(await respond(req(`${SESSION}/laps`), d)).toBe(res);
    expect(await stored()).toEqual([]);
  });

  it('offline, answers with the kept copy, else with a network error', async () => {
    const online = setup();
    await respond(req(`${SESSION}/laps?v=1`), online.d);
    const offline = { ...online.d, fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) };
    expect(await (await respond(req(`${SESSION}/laps?v=1`), offline))?.json()).toEqual({ ok: 1 });
    // Another revision is another URL, and another session was never kept.
    expect((await respond(req(`${SESSION}/laps?v=2`), offline))?.type).toBe('error');
    expect((await respond(req('/api/v1/sessions/1/laps'), offline))?.type).toBe('error');
  });
});

describe('what the worker leaves to the browser', () => {
  it.each([
    ['the playback stream', req('/api/v1/playback/1/stream')],
    ['/live', req('/api/v1/live')],
    ['/status', req('/api/v1/status')],
    ['/recordings', req('/api/v1/recordings')],
    ['/seasons', req('/api/v1/seasons')],
    ['/seasons/2026', req('/api/v1/seasons/2026')],
    ['a session path with more after it', req(`${SESSION}/laps/1`)],
    ["Access's own endpoint", req('/cdn-cgi/access/authorized')],
    ["a navigation to Access's logout", req('/cdn-cgi/access/logout', { mode: 'navigate' })],
    ['/healthz', req('/healthz')],
    ['a POST', req(`${SESSION}/laps`, { method: 'POST' })],
    ['a cross-origin URL', req(`${SESSION}/laps`, { origin: 'https://other.test' })],
    ['a cross-origin navigation', req('/', { mode: 'navigate', origin: 'https://other.test' })],
  ])('%s', (_name, request) => {
    const { d, fetch } = setup();
    expect(respond(request, d)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('navigations', () => {
  it.each([
    ['an HTML 200', () => answer('<!doctype html>', { 'content-type': 'text/html' })],
    ["Access's login redirect", opaqueRedirect],
    ['a 404', () => answer('not found', {}, 404)],
  ])('online, hand the page the network answer, %s, and keep nothing', async (_name, make) => {
    const res = make();
    const { d, stored } = setup(() => res);
    expect(await respond(req('/2026/1300/11000/laps', { mode: 'navigate' }), d)).toBe(res);
    expect(await stored()).toEqual([]);
  });

  it('offline, get the shell, else a network error', async () => {
    const { caches, d } = setup('offline');
    expect((await respond(req('/live', { mode: 'navigate' }), d))?.type).toBe('error');
    await (await caches.open(NAME)).put('/', answer('<!doctype html>shell', { 'content-type': 'text/html' }));
    expect(await (await respond(req('/2026/1300/11000/laps', { mode: 'navigate' }), d))?.text()).toBe(
      '<!doctype html>shell',
    );
  });
});

describe('assets', () => {
  // Window script can write Cache Storage: a kept copy online would let one injection persist.
  it('come from the network first, the kept copy only when the fetch rejects', async () => {
    const online = setup(() => answer('net', { 'content-type': 'text/javascript' }));
    const kept = answer('kept', { 'content-type': 'text/javascript' });
    await (await online.caches.open(NAME)).put('/assets/index-a.js', kept);
    expect(await (await respond(req('/assets/index-a.js'), online.d))?.text()).toBe('net');
    const offline = { ...online.d, fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) };
    expect(await (await respond(req('/assets/index-a.js'), offline))?.text()).toBe('kept');
    expect((await respond(req('/assets/other-b.js'), offline))?.type).toBe('error');
  });
});

describe('install and activate', () => {
  const shell = (url: string) =>
    url === '/'
      ? answer('<!doctype html>', { 'content-type': 'text/html' })
      : answer('x', { 'content-type': 'text/javascript' });

  it('install keeps the shell, fetched without following a redirect', async () => {
    const { d, fetch, stored } = setup(shell);
    await install(d);
    expect(await stored()).toEqual([`${ORIGIN}/`, `${ORIGIN}/assets/index-a.js`]);
    for (const [, init] of fetch.mock.calls) expect(init).toEqual({ redirect: 'error' });
  });

  it.each([
    ['a redirect (the fetch rejects)', 'offline' as const],
    ['a redirected answer', (url: string) => redirected(shell(url))],
    [
      'a non-200',
      (url: string) => (url === '/' ? shell(url) : answer('gone', { 'content-type': 'text/javascript' }, 404)),
    ],
    // Caddy's SPA fallback: index.html for every path.
    ['an asset served as HTML', () => answer('<!doctype html>', { 'content-type': 'text/html' })],
  ])('install fails on %s', async (_name, net) => {
    const { d } = setup(net);
    await expect(install(d)).rejects.toThrow();
  });

  it("activate drops every other build's cache, and only the worker's", async () => {
    const { caches, d } = setup();
    await caches.open('f1-old');
    await caches.open(NAME);
    await caches.open('other');
    await caches.open('f1-older');
    await activate(d);
    expect(await caches.keys()).toEqual([NAME, 'other']);
  });
});
