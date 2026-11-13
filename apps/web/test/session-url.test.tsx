// @vitest-environment happy-dom
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

const render = (url: string, type = 'Race', view: View = 'minisectors') => {
  history.replaceState(null, '', url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(
    ['session', KEY],
    sessionDetail(type, type, [
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
    expect(tabs()).toEqual(['Laps', 'Order', 'Compare', 'Mini-sectors', 'Stints', 'Weather']);
    expect(href('Order')).toBe(`${PATH}/order`);
    expect(host.textContent).toContain('No line crossings in this session');
  });

  it('hides the tab outside races, and the route says why', () => {
    render('/2026/1300-mexico-city/11000-practice/order', 'Practice', 'order');
    expect(tabs()).toEqual(['Laps', 'Compare', 'Mini-sectors', 'Stints', 'Weather']);
    expect(host.textContent).toContain('The running order is for races and sprints.');
  });
});
