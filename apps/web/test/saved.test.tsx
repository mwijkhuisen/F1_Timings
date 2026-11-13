import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savedSessions } from '../src/lib/saved.ts';
import { SavedList } from '../src/views/Season.tsx';
import { FakeCaches } from './caches.ts';
import { sessionDetail } from './laps.ts';

// "Saved on this device" (#121, D4): `/` offline lists the sessions the worker keeps, read from its caches.

const detail = (key: number, name: string, date_start: string) => {
  const d = sessionDetail('Race', name);
  return { ...d, session: { ...d.session, session_key: key, date_start } };
};
const body = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('savedSessions', () => {
  it('lists each kept session once, newest first, linking to its laps; skips other bodies and paths', async () => {
    const caches = new FakeCaches();
    const old = await caches.open('f1-old');
    const now = await caches.open('f1-new');
    await old.put('/api/v1/sessions/11001', body(detail(11001, 'Qualifying', '2026-10-25T20:00:00.000Z')));
    await now.put('/api/v1/sessions/11001?v=2', body(detail(11001, 'Qualifying', '2026-10-25T20:00:00.000Z')));
    await now.put('/api/v1/sessions/11002', body(detail(11002, 'Race', '2026-10-26T20:00:00.000Z')));
    await now.put('/api/v1/sessions/11000', body(detail(11000, 'Practice 1', '2026-10-24T18:30:00.000Z')));
    // Another contract's body, a body that is no JSON, and a session's laps.
    await now.put('/api/v1/sessions/11003', body({ session: { session_key: 11003 } }));
    await now.put('/api/v1/sessions/11004', new Response('<!doctype html>'));
    await now.put('/api/v1/sessions/11002/laps', body(detail(11005, 'Not a detail', '2026-10-27T20:00:00.000Z')));
    vi.stubGlobal('caches', caches.storage);

    expect(await savedSessions()).toEqual([
      {
        key: 11002,
        name: 'Mexico City Grand Prix · Race',
        date_start: '2026-10-26T20:00:00.000Z',
        path: '/2026/1300-mexico-city/11002-race/laps',
      },
      {
        key: 11001,
        name: 'Mexico City Grand Prix · Qualifying',
        date_start: '2026-10-25T20:00:00.000Z',
        path: '/2026/1300-mexico-city/11001-qualifying/laps',
      },
      {
        key: 11000,
        name: 'Mexico City Grand Prix · Practice 1',
        date_start: '2026-10-24T18:30:00.000Z',
        path: '/2026/1300-mexico-city/11000-practice-1/laps',
      },
    ]);
  });

  it('is empty without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await savedSessions()).toEqual([]);
  });
});

describe('SavedList', () => {
  it('renders each session as a link with its start, as text', () => {
    const html = renderToStaticMarkup(
      <SavedList
        saved={[
          {
            key: 11002,
            name: '<b>Mexico</b> · Race',
            date_start: '2026-10-26T20:00:00.000Z',
            path: '/2026/1300-mexico-city/11002-race/laps',
          },
        ]}
      />,
    );
    expect(html).toBe(
      '<section aria-label="Saved on this device"><h2 class="eyebrow sect">Saved on this device</h2><ul class="sess">' +
        '<li><a href="/2026/1300-mexico-city/11002-race/laps">&lt;b&gt;Mexico&lt;/b&gt; · Race</a>' +
        '<time class="when" dateTime="2026-10-26T20:00:00.000Z">Mon 26 Oct 2026, 21:00</time></li></ul></section>',
    );
  });

  it('renders nothing without a saved session', () => {
    expect(renderToStaticMarkup(<SavedList saved={[]} />)).toBe('');
  });
});
