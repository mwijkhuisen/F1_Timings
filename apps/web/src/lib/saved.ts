import { SessionDetail } from '@f1/contracts';
import { sessionPath } from './routes.ts';

// "Saved on this device" (#121, D4): the sessions whose detail the service worker keeps (src/sw/handlers.ts). The
// pathname rule is a copy, never an import: a module shared with the worker would become a chunk that sw.js imports.
const DETAIL = /^\/api\/v1\/sessions\/\d{1,9}$/;

export type Saved = { key: number; name: string; date_start: string; path: string };

/** Newest first, one per session, each linking to its laps; empty without the Cache API. Another contract's body is skipped. */
export async function savedSessions(): Promise<Saved[]> {
  if (typeof caches === 'undefined') return [];
  const byKey = new Map<number, Saved>();
  for (const name of await caches.keys()) {
    if (!name.startsWith('f1-')) continue; // not the worker's
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      if (!DETAIL.test(new URL(req.url).pathname)) continue;
      const body = await (await cache.match(req))?.json().catch(() => null);
      const parsed = SessionDetail.safeParse(body);
      if (!parsed.success) continue;
      const { session: s, meeting: m } = parsed.data;
      byKey.set(s.session_key, {
        key: s.session_key,
        name: `${m.name ?? '—'} · ${s.name ?? '—'}`,
        date_start: s.date_start,
        path: sessionPath(m.year, { key: s.meeting_key, name: m.name }, { key: s.session_key, name: s.name }, 'laps'),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
}
