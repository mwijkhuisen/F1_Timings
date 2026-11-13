// @vitest-environment happy-dom
import type { Laps, Live, SessionDetail, Stints } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { View } from '../src/lib/routes.ts';
import { Session } from '../src/views/Session.tsx';
import { lap, sessionDetail } from './laps.ts';

// The picks in `?d=` (C4) in a real React tree: read once at mount, written back on a pick, kept by the canonical
// redirect, carried by the Compare and Mini-sectors tabs only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 11000;
const PATH = '/2026/1300-mexico-city/11000-race';
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
  history.replaceState(null, '', '/');
});

const render = (url: string) => {
  history.replaceState(null, '', url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(
    ['session', KEY],
    sessionDetail('Race', 'Race', [
      [1, 'VER'],
      [3, 'RIC'],
      [63, 'RUS'],
    ]),
  );
  client.setQueryData(['laps', KEY], [lap(1, 1), lap(3, 1), lap(63, 1)]);
  // Everything is in the cache, so nothing is fetched: the head shows without its season, recordings and weather.
  client.setQueryData(['season', 2026], null);
  client.setQueryData(['recordings'], null);
  client.setQueryData(['weather', KEY], []);
  client.setQueryData(['live'], null);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Session session={KEY} view="minisectors" />
      </QueryClientProvider>,
    ),
  );
};
const chips = () => [...host.querySelectorAll('.chip')].map((c) => c.firstChild?.textContent);
const href = (text: string) =>
  [...host.querySelectorAll('.tabs a')].find((a) => a.textContent === text)?.getAttribute('href');
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());

describe('Session: the picks in ?d=', () => {
  it('reads ?d at mount, keeps it through the canonical redirect, and writes each pick back', () => {
    // A wrong name: the redirect to the canonical path keeps the query.
    render('/2026/1300-x/11000-y/minisectors?d=63,3');
    expect(location.pathname).toBe(`${PATH}/minisectors`);
    expect(location.search).toBe('?d=63,3');
    expect(chips()).toEqual(['RUS', 'RIC']);
    expect(href('Compare')).toBe(`${PATH}/compare?d=63,3`);
    expect(href('Mini-sectors')).toBe(`${PATH}/minisectors?d=63,3`);
    expect(href('Laps')).toBe(`${PATH}/laps`);
    expect(href('Stints')).toBe(`${PATH}/stints`);

    click(host.querySelector('[aria-label="Remove RUS"]'));
    expect(location.search).toBe('?d=3');
    click([...host.querySelectorAll('.picker button')].find((b) => b.textContent === 'VER'));
    expect(location.search).toBe('?d=3,1');
    expect(chips()).toEqual(['RIC', 'VER']);
    expect(href('Laps')).toBe(`${PATH}/laps`);
  });

  it('writes nothing for the default top two, nor for a bad ?d, until the first pick', () => {
    render(`${PATH}/minisectors?d=3;63`);
    expect(chips()).toEqual(['VER', 'RIC']);
    expect(location.search).toBe('?d=3;63');
    expect(href('Compare')).toBe(`${PATH}/compare`);
    click(host.querySelector('[aria-label="Remove VER"]'));
    expect(location.search).toBe('?d=3');
  });

  it('keeps the hash when it writes a pick back', () => {
    render(`${PATH}/minisectors?d=63,3#top`);
    click(host.querySelector('[aria-label="Remove RUS"]'));
    expect(location.search).toBe('?d=3');
    expect(location.hash).toBe('#top');
  });
});

describe('Session without laps: the reason, no dead end (#99)', () => {
  const live: Live = {
    session: { session_key: KEY, meeting_name: null, session_name: null, date_start: '', date_end: '' },
    recording: { id: 5, started_at: '2026-10-31T19:00:00.000Z', ended_at: null, complete: false },
  };
  const show = (
    view: View,
    session: Partial<SessionDetail['session']> = {},
    { laps = [] as Laps, stints = [] as Stints, now = null as Live | null } = {},
  ) => {
    // A fresh tree per call: a query observer keeps the client it was made with.
    act(() => root.unmount());
    root = createRoot(host);
    history.replaceState(null, '', `${PATH}/${view}`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['race-control', KEY], []);
    const d = sessionDetail('Race', 'Race', [[1, 'VER']]);
    client.setQueryData(['session', KEY], { ...d, session: { ...d.session, ...session } });
    client.setQueryData(['laps', KEY], laps);
    client.setQueryData(['stints', KEY], stints);
    client.setQueryData(['season', 2026], null);
    client.setQueryData(['recordings'], null);
    client.setQueryData(['weather', KEY], []);
    client.setQueryData(['live'], now);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Session session={KEY} view={view} />
        </QueryClientProvider>,
      ),
    );
    // The tab's own content, after the head and the tabs.
    return host.innerHTML.slice(host.innerHTML.indexOf('</nav>', host.innerHTML.indexOf('class="tabs"')) + 6);
  };

  it('Compare and Mini-sectors show the reason instead of an empty picker', () => {
    for (const view of ['compare', 'minisectors'] as const) {
      expect(show(view)).toBe('<p>No laps in the OpenF1 data.</p>');
      expect(host.querySelector('.picked')).toBeNull();
    }
  });

  it('Laps, Stints and Weather each say why', () => {
    expect(show('laps', { ingest_state: 'failed', fail_count: 9, last_error: 'schema' })).toBe(
      '<p>The fetch failed 9 times (unexpected data) and is not retried.</p>',
    );
    expect(show('stints', { is_cancelled: true })).toBe('<p>No stints: the session was cancelled.</p>');
    expect(show('stints', {}, { laps: [lap(1, 1)] })).toBe('<p>No stints in the OpenF1 data.</p>');
    expect(show('weather', { source: 'f1-archive' })).toMatch(/^<p>No weather in the F1 archive.<\/p>/);
    expect(show('laps', {}, { now: live })).toBe('<p>Live now: <a href="/live">follow it</a>.</p>');
  });

  it('the head says "data final", and "Live now · Follow" while live', () => {
    show('laps', {}, { now: live });
    const meta = host.querySelector('.head p.muted')?.textContent;
    expect(meta).toContain(' · data final · Live now · Follow');
    expect(host.querySelector('.head a[href="/live"]')?.textContent).toBe('Follow');
  });
});
