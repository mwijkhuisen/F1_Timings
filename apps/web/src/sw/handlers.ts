// The service worker's logic (#121), pure: everything it uses comes in as `d`, so the tests pass fakes. Nothing in
// the app imports this and it imports nothing, so sw.js stays one classic script (a module shared with the app would
// become a chunk that sw.js imports).

export type Deps = {
  caches: CacheStorage;
  fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
  cacheName: string;
  /** `/` and every emitted .js and .css file. */
  shell: readonly string[];
  origin: string;
};

/** A session's answers (A§10), by pathname only, so #98's `?v=` passes. */
const SESSION = /^\/api\/v1\/sessions\/\d{1,9}(\/(laps|stints|pits|race-control|weather|rain))?$/;

/**
 * An answer to keep: a plain 200 of the type its path serves. From the API only a final session's (the server's
 * `max-age`, A§10): a live session's answers are `no-store`, so they are never kept, nor is a zero `max-age` or a
 * `no-cache`.
 */
export function storable(res: Response, path: string): boolean {
  if (res.status !== 200 || res.redirected) return false;
  const type = res.headers.get('content-type') ?? '';
  if (path === '/') return /^text\/html\b/.test(type);
  if (path.startsWith('/assets/')) return /^(text|application)\/javascript\b|^text\/css\b/.test(type);
  const cc = res.headers.get('cache-control') ?? '';
  return (
    SESSION.test(path) &&
    /^application\/json\b/.test(type) &&
    /\bmax-age=[1-9]\d*/i.test(cc) &&
    !/\bno-(store|cache)\b/i.test(cc)
  );
}

/** Precaches the shell, or throws: the install then fails and the browser tries again on a later load. */
export async function install(d: Deps): Promise<void> {
  const cache = await d.caches.open(d.cacheName);
  await Promise.all(
    d.shell.map(async (path) => {
      // Never /index.html: Caddy's file_server redirects it to /.
      const res = await d.fetch(path, { redirect: 'error' });
      if (!storable(res, path)) throw new Error(`precache ${path}: ${res.status}`);
      await cache.put(path, res);
    }),
  );
}

/** Drops every other build's cache, and with it what it kept. A cache not named `f1-` is not the worker's. */
export async function activate(d: Deps): Promise<void> {
  for (const name of await d.caches.keys())
    if (name.startsWith('f1-') && name !== d.cacheName) await d.caches.delete(name);
}

/**
 * The answer to a request, or null to leave it to the browser. Every path is network-first and only a rejected fetch
 * falls back to the cache: window script can write Cache Storage, so a stored copy is never served online. Hashed
 * assets still come from the browser's immutable HTTP cache without a round trip.
 */
export function respond(req: Request, d: Deps): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== d.origin || url.pathname.startsWith('/cdn-cgi/')) return null;
  // ponytail: no network timeout, so a stalled (lie-fi) network waits for the OS timeout before the stored copy
  // shows. Upgrade: race the session JSON only against about 5 s when a stored copy exists. A navigation must keep
  // waiting, so the worker never shows the shell in place of Access's login.
  const stored = (key: Request | string) => async () =>
    (await (await d.caches.open(d.cacheName)).match(key)) ?? Response.error();
  // Whatever comes back (Access's login redirect, a 404) goes to the page unstored.
  if (req.mode === 'navigate') return d.fetch(req).catch(stored('/'));
  if (url.pathname.startsWith('/assets/')) return d.fetch(req).catch(stored(req));
  if (!SESSION.test(url.pathname)) return null;
  // The page's `redirect: 'error'` carries over: an Access redirect rejects, so it is never kept.
  return d.fetch(req).then(async (res) => {
    if (storable(res, url.pathname)) {
      const copy = res.clone();
      // A full disk costs the offline copy, never the page its answer.
      await d.caches
        .open(d.cacheName)
        .then((c) => c.put(req, copy))
        .catch(() => undefined);
    }
    return res;
  }, stored(req));
}
