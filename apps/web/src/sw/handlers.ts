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
 * `max-age`, A§10): a live session's answers are `no-store`, so they are never kept.
 */
export function storable(res: Response, path: string): boolean {
  if (res.status !== 200 || res.redirected) return false;
  const type = res.headers.get('content-type') ?? '';
  if (path === '/') return /^text\/html\b/.test(type);
  if (path.startsWith('/assets/')) return /^(text|application)\/javascript\b|^text\/css\b/.test(type);
  const cc = res.headers.get('cache-control') ?? '';
  return (
    SESSION.test(path) && /^application\/json\b/.test(type) && /\bmax-age=\d+/.test(cc) && !/\bno-store\b/.test(cc)
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

/** Drops every other build's cache, and with it what it kept. */
export async function activate(d: Deps): Promise<void> {
  for (const name of await d.caches.keys()) if (name !== d.cacheName) await d.caches.delete(name);
}

/** The answer to a request, or null to leave it to the browser. Only a rejected fetch falls back to the cache. */
export function respond(req: Request, d: Deps): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== d.origin || url.pathname.startsWith('/cdn-cgi/')) return null;
  const cached = async (key: Request | string) => (await (await d.caches.open(d.cacheName)).match(key)) ?? null;
  // Network-first, and whatever comes back (Access's login redirect, a 404) goes to the page unstored.
  if (req.mode === 'navigate') return d.fetch(req).catch(async () => (await cached('/')) ?? Response.error());
  if (url.pathname.startsWith('/assets/')) return cached(req).then((hit) => hit ?? d.fetch(req));
  if (!SESSION.test(url.pathname)) return null;
  // The page's `redirect: 'error'` carries over: an Access redirect rejects, so it is never kept.
  return d.fetch(req).then(
    async (res) => {
      if (storable(res, url.pathname)) {
        const copy = res.clone();
        // A full disk costs the offline copy, never the page its answer.
        await d.caches
          .open(d.cacheName)
          .then((c) => c.put(req, copy))
          .catch(() => undefined);
      }
      return res;
    },
    async () => (await cached(req)) ?? Response.error(),
  );
}
