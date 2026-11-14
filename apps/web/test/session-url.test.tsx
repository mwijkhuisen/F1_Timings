// @vitest-environment happy-dom
import type { Laps, Live, SessionDetail, Stints } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import type { View } from '../src/lib/routes.ts';
import { Session } from '../src/views/Session.tsx';
import { lap, result, sessionDetail } from './laps.ts';

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

const render = (
  url: string,
  type = 'Race',
  view: View = 'minisectors',
  results: ReturnType<typeof result>[] = [],
  laps = [lap(1, 1), lap(3, 1), lap(63, 1)],
) => {
  history.replaceState(null, '', url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(
    ['session', KEY],
    sessionDetail(
      type,
      type,
      [
        [1, 'VER'],
        [3, 'RIC'],
        [63, 'RUS'],
      ],
      results,
    ),
  );
  client.setQueryData(['laps', KEY], laps);
  // Everything is in the cache, so nothing is fetched: the head shows without its season, recordings and weather.
  client.setQueryData(['season', 2026], null);
  client.setQueryData(['recordings'], null);
  client.setQueryData(['weather', KEY], []);
  client.setQueryData(['live'], null);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Session session={KEY} view={view} />
      </QueryClientProvider>,
    ),
  );
};
const tabs = () => [...host.querySelectorAll('.tabs a')].map((a) => a.textContent);
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

describe('Session: the Order tab (races and sprints only)', () => {
  it('lists Order right after Laps in a race, and shows the running order', () => {
    render(`${PATH}/order`, 'Race', 'order');
    expect(tabs()).toEqual(['Laps', 'Order', 'Compare', 'Mini-sectors', 'Stints', 'Weather', 'Result']);
    expect(href('Order')).toBe(`${PATH}/order`);
    expect(host.textContent).toContain('No line crossings in this session');
  });

  // #115: OpenF1's starting grid, as results[].grid; a 0 (Jolpica's pit-lane start) or null takes no place.
  it('fills the Grid row from results[].grid, and says so without one', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-25T20:00:00Z') + s * 1000).toISOString();
    const laps = [1, 3, 63].map((d, i) => lap(d, 1, { date_start: at(i), lap_ms: 90_000 }));
    const gridRow = () => [...host.querySelectorAll('tbody tr')].find((tr) => tr.firstChild?.textContent === 'Grid');
    render(`${PATH}/order`, 'Race', 'order', [result(1, 1, 2), result(3, 2, 1), result(63, 3, 0)], laps);
    expect([...(gridRow()?.querySelectorAll('td') ?? [])].map((td) => td.textContent)).toEqual(['RIC', 'VER']);
    act(() => root.unmount());
    root = createRoot(host);
    render(`${PATH}/order`, 'Race', 'order', [result(1, 1), result(3, 2)], laps);
    expect(gridRow()?.textContent).toBe('GridGrid not in the OpenF1 data');
  });

  it('hides the tab outside races, and the route says why', () => {
    render('/2026/1300-mexico-city/11000-practice/order', 'Practice', 'order');
    expect(tabs()).toEqual(['Laps', 'Compare', 'Mini-sectors', 'Stints', 'Weather', 'Result']);
    expect(host.textContent).toContain('The running order is for races and sprints.');
  });
});

describe('Session: the Result tab (#110)', () => {
  it('is the last tab, keeps its own URL, and shows the result without laps (9900)', () => {
    const won = { ...result(1, 1), laps: 62, durations_ms: [6_120_785], gaps_ms: [0] };
    render(`${PATH}/result`, 'Race', 'result', [won, result(3, 2)], []);
    expect(tabs().at(-1)).toBe('Result');
    expect(href('Result')).toBe(`${PATH}/result`);
    expect(location.pathname).toBe(`${PATH}/result`);
    expect(host.querySelector('table.result')?.textContent).toContain('1:42:00.785');
  });

  it('says why when the session has no result', () => {
    render(`${PATH}/result`, 'Race', 'result', []);
    expect(host.textContent).toContain('No results in the OpenF1 data.');
  });
});

describe('Session without laps: the reason, no dead end (#99)', () => {
  const live: Live = {
    session: { session_key: KEY, meeting_name: null, session_name: null, date_start: '', date_end: '' },
    recording: { id: 5, started_at: '2026-10-31T19:00:00.000Z', ended_at: null, complete: false },
  };
  let client: QueryClient;
  const show = (
    view: View,
    session: Partial<SessionDetail['session']> = {},
    { laps = [] as Laps, stints = [] as Stints, now = null as Live | null } = {},
  ) => {
    // A fresh tree per call: a query observer keeps the client it was made with.
    act(() => root.unmount());
    root = createRoot(host);
    history.replaceState(null, '', `${PATH}/${view}`);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
    expect(show('laps', { ingest_state: 'failed', fail_count: 9, last_error: 'schema', fetch_count: 0 })).toBe(
      '<p>The fetch failed 9 times (unexpected data) and is not retried.</p>',
    );
    expect(show('stints', { is_cancelled: true })).toBe('<p>No stints: the session was cancelled.</p>');
    expect(show('stints', {}, { laps: [lap(1, 1)] })).toBe('<p>No stints in the OpenF1 data.</p>');
    expect(show('weather', { source: 'f1-archive' })).toMatch(/^<p>No weather in the F1 archive.<\/p>/);
    expect(show('laps', { ingest_state: 'due', fetch_count: 0 }, { now: live })).toBe(
      '<p>Live now: <a href="/live">follow it</a>.</p>',
    );
  });

  it('the head says "data final", and "Live now · Follow" while live', () => {
    show('laps');
    expect(host.querySelector('.head p.muted')?.textContent).toContain(' · data final');
    show('laps', { ingest_state: 'scheduled', fetch_count: 0 }, { now: live });
    const meta = host.querySelector('.head p.muted')?.textContent;
    expect(meta).toMatch(/ · Live now · Follow$/);
    expect(meta).not.toContain('data');
    expect(host.querySelector('.head a[href="/live"]')?.textContent).toBe('Follow');
  });

  it('asks /live only while the session is scheduled or due and not cancelled, and ignores a cached answer else (F7)', () => {
    const asked = () =>
      client
        .getQueryCache()
        .find({ queryKey: ['live'] })
        ?.isActive();
    for (const ingest_state of ['scheduled', 'due'] as const) {
      show('laps', { ingest_state, fetch_count: 0 }, { now: live });
      expect(asked()).toBe(true);
    }
    // The cache holds an open recording of this session, but a final, fetched, failed or cancelled one is never live.
    for (const session of [
      { ingest_state: 'final' },
      { ingest_state: 'fetched' },
      { ingest_state: 'failed' },
      { ingest_state: 'due', is_cancelled: true },
    ] as const) {
      expect(show('laps', session, { now: live })).not.toContain('Live now');
      expect(asked()).toBe(false);
      expect(host.querySelector('.head p.muted')?.textContent).not.toContain('Live now');
    }
  });
});

describe('Session: a new fetch refetches its laps, stints and weather (#99)', () => {
  const d = sessionDetail('Race', 'Race', [[1, 'VER']]);
  const asked = { laps: 0, stints: 0, weather: 0 };
  const count = (what: keyof typeof asked, body: unknown[]) =>
    http.get(`*/api/v1/sessions/${KEY}/${what}`, () => {
      asked[what]++;
      return HttpResponse.json(body);
    });

  it('on a changed fetch_count, once each; not on an answer with the same fetch_count', async () => {
    server.use(count('laps', [lap(1, 1)]), count('stints', []), count('weather', []));
    asked.laps = asked.stints = asked.weather = 0;
    history.replaceState(null, '', `${PATH}/stints`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const due = { ...d, session: { ...d.session, ingest_state: 'due', fetch_count: 1 } } as const;
    client.setQueryData(['session', KEY], due);
    client.setQueryData(['laps', KEY], [lap(1, 1)]);
    client.setQueryData(['stints', KEY], []);
    client.setQueryData(['weather', KEY], []);
    client.setQueryData(['race-control', KEY], []);
    client.setQueryData(['season', 2026], null);
    client.setQueryData(['recordings'], null);
    client.setQueryData(['live'], null);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Session session={KEY} view="stints" />
        </QueryClientProvider>,
      ),
    );
    expect(host.innerHTML).toContain('No stints in the OpenF1 data.');

    // A poll whose answer changed, but not its fetch_count: nothing else is asked.
    act(() => client.setQueryData(['session', KEY], { ...due, session: { ...due.session, ingest_state: 'fetched' } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual({ laps: 0, stints: 0, weather: 0 });

    // A new fetch: the laps, the stints (this tab) and the weather (the head) are asked once each.
    act(() =>
      client.setQueryData(['session', KEY], {
        ...due,
        session: { ...due.session, ingest_state: 'final', fetch_count: 2 },
      }),
    );
    await vi.waitFor(() => expect(asked).toEqual({ laps: 1, stints: 1, weather: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual({ laps: 1, stints: 1, weather: 1 });
  });
});
