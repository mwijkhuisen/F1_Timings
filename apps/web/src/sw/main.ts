import { activate, install, respond } from './handlers.ts';

// The service worker (#121): the second build entry, emitted as /sw.js, a classic script with no import or export
// (test/build.test.ts). vite.config.ts fills in the two placeholders: the build's hash and the precache list.
// There is no webworker lib (it clashes with DOM), so the scope has a minimal type of its own.

type Ev = { waitUntil(p: Promise<unknown>): void };
type FetchEv = { request: Request; respondWith(r: Promise<Response>): void };
type SwScope = {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', f: (e: Ev) => void): void;
  addEventListener(type: 'fetch', f: (e: FetchEv) => void): void;
};

const sw = self as unknown as SwScope;
const BUILD = '__F1_BUILD__';
const SHELL = '__F1_SHELL__'.split(',');
const d = {
  caches,
  // A wrapper, not `fetch` itself: called as `d.fetch(…)`, the bare global would throw "Illegal invocation".
  fetch: (input: Request | string, init?: RequestInit) => fetch(input, init),
  cacheName: `f1-${BUILD}`,
  shell: SHELL,
  origin: location.origin,
};

// Navigations are network-first and assets hashed, so a new worker may take over an open page at once.
sw.addEventListener('install', (e) => e.waitUntil(install(d).then(() => sw.skipWaiting())));
sw.addEventListener('activate', (e) => e.waitUntil(activate(d).then(() => sw.clients.claim())));
sw.addEventListener('fetch', (e) => {
  const answer = respond(e.request, d);
  if (answer) e.respondWith(answer);
});
