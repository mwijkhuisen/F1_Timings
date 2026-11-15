import { describe, expect, it } from 'vitest';
import {
  formatD,
  parseD,
  parseTab,
  type Route,
  replayQuery,
  routeOf,
  sessionPath,
  slug,
  titleOf,
  withWord,
} from '../src/lib/routes.ts';

describe('routeOf', () => {
  it.each([
    ['/', { id: 'latest' }],
    ['/2026', { id: 'year', year: 2026 }],
    ['/status', { id: 'status' }],
    ['/live', { id: 'live' }],
    ['/replay', { id: 'replays' }],
    ['/replay/7', { id: 'replay', recording: 7 }],
    ['/replay/123456789', { id: 'replay', recording: 123456789 }],
    ['/2026/1290/9965', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: null }],
    ['/2026/1290/9965/laps', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'laps' }],
    [
      '/2026/1290-singapore/9965-race/stints',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'stints' },
    ],
    [
      '/2026/1290-singapore/9965-race/order',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'order' },
    ],
    [
      '/2026/1290-singapore/9965-race/compare',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'compare' },
    ],
    [
      '/2026/1290-singapore/9965-race/minisectors',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'minisectors' },
    ],
    [
      '/2026/1290-singapore/9965-race/weather',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'weather' },
    ],
    // The key decides; the name is decoration.
    ['/2026/1290-wrong-name/9965-/laps', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'laps' }],
    ['/2026/%31290-singapore/9965/laps', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'laps' }],
  ])('%s', (path, route) => {
    expect(routeOf(path)).toEqual(route);
  });

  it.each([
    '/20266',
    '/202',
    '/abcd',
    '/2026/',
    '/2026/1290',
    '/2026/1290/9965/laps/extra',
    '/2026/1290/9965/weather/extra',
    '/2026/1290/9965/Weather',
    '/2026/1290/9965/rain',
    '/2026/1290/9965/toString',
    '/2026/1290/9965/',
    '/2026/abc/9965/laps',
    '/2026/1290-Singapore/9965/laps',
    '/2026/1290_x/9965/laps',
    '/2026/1234567890/9965/laps',
    '/status/x',
    '/live/x',
    '/replay/',
    '/replay/x',
    '/replay/abc',
    '/replay/1234567890',
    '/replay/7/x',
    '/%',
    '/2026/%E0%A4%A',
    '/__proto__',
    '/constructor',
    '',
  ])('%s is not found', (path) => {
    expect(routeOf(path)).toBeNull();
  });
});

describe('slug and sessionPath', () => {
  it('slugs a name', () => {
    expect(slug('São Paulo')).toBe('sao-paulo');
    expect(slug('  Free Practice 1 ')).toBe('free-practice-1');
    expect(slug(null)).toBe('');
  });

  it('builds the canonical URL, dropping a trailing Grand Prix from the meeting', () => {
    const path = sessionPath(2026, { key: 1290, name: 'Singapore Grand Prix' }, { key: 9965, name: 'Race' }, 'laps');
    expect(path).toBe('/2026/1290-singapore/9965-race/laps');
    expect(routeOf(path)).toMatchObject({ id: 'session', meeting: 1290, session: 9965, view: 'laps' });
  });

  it('keeps a bare key when there is no name', () => {
    expect(sessionPath(2026, { key: 1, name: null }, { key: 2, name: '' }, 'stints')).toBe('/2026/1/2/stints');
    // Order only to a race (a sprint is type Race), and kept when the type is unknown.
    const order = (type?: string) =>
      sessionPath(2026, { key: 1, name: null }, { key: 2, name: '', ...(type && { type }) }, 'order');
    expect([order('Race'), order('Practice'), order('Qualifying'), order()]).toEqual([
      '/2026/1/2/order',
      '/2026/1/2/laps',
      '/2026/1/2/laps',
      '/2026/1/2/order',
    ]);
  });
});

describe('titleOf: the title for every route', () => {
  const session: Route = { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'laps' };
  const names = { meeting: 'Mexico City Grand Prix', session: 'Race' };

  it.each<[Route | null, string, string]>([
    [{ id: 'latest' }, 'F1 Timings', 'F1 Timings'],
    [{ id: 'year', year: 2026 }, '2026 · F1 Timings', '2026 · F1 Timings'],
    [session, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Laps · F1 Timings'],
    [{ ...session, view: null }, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Laps · F1 Timings'],
    [{ ...session, view: 'order' }, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Order · F1 Timings'],
    [{ ...session, view: 'compare' }, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Compare · F1 Timings'],
    [
      { ...session, view: 'minisectors' },
      '2026 · F1 Timings',
      'Mexico City Grand Prix · Race · Mini-sectors · F1 Timings',
    ],
    [{ ...session, view: 'stints' }, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Stints · F1 Timings'],
    [{ ...session, view: 'weather' }, '2026 · F1 Timings', 'Mexico City Grand Prix · Race · Weather · F1 Timings'],
    [{ id: 'status' }, 'Status · F1 Timings', 'Status · F1 Timings'],
    [{ id: 'live' }, 'Live · F1 Timings', 'Live · F1 Timings'],
    [{ id: 'replays' }, 'Replays · F1 Timings', 'Replays · F1 Timings'],
    [{ id: 'replay', recording: 7 }, 'Replay · F1 Timings', 'Replay: Mexico City Grand Prix · Race · F1 Timings'],
    [null, 'Not found · F1 Timings', 'Not found · F1 Timings'],
  ])('%j', (route, bare, named) => {
    expect(titleOf(route)).toBe(bare);
    expect(titleOf(route, names)).toBe(named);
    // Names only, never a result: no lap time, gap or position.
    for (const title of [bare, named]) expect(title).not.toMatch(/\d:\d\d\.\d{3}|[+−-]\d+\.\d{3}|\bP\d+\b/);
  });

  it('shows a missing name as a dash', () => {
    expect(titleOf(session, { meeting: null, session: 'Race' })).toBe('— · Race · Laps · F1 Timings');
    expect(titleOf({ id: 'replay', recording: 7 }, { meeting: 'Mexico City Grand Prix', session: null })).toBe(
      'Replay: Mexico City Grand Prix · — · F1 Timings',
    );
  });
});

describe('withWord: the title word in front (D1)', () => {
  it('puts the word before the page title, and leaves the title alone without one', () => {
    expect(withWord('Safety car', titleOf({ id: 'live' }))).toBe('Safety car · Live · F1 Timings');
    expect(
      withWord(
        'Safety car',
        titleOf({ id: 'replay', recording: 7 }, { meeting: 'Mexico City Grand Prix', session: 'Race' }),
      ),
    ).toBe('Safety car · Replay: Mexico City Grand Prix · Race · F1 Timings');
    expect(withWord(null, 'Live · F1 Timings')).toBe('Live · F1 Timings');
    expect(withWord('', 'Live · F1 Timings')).toBe('Live · F1 Timings');
  });
});

describe('parseD and formatD: the picks in ?d= (C4)', () => {
  const drivers = [{ number: 1 }, { number: 3 }, { number: 63 }, { number: 44 }];

  it('keeps the order and drops unknown and repeated numbers', () => {
    expect(parseD('63,3', drivers)).toEqual([63, 3]);
    expect(parseD('3,99,63,3,1', drivers)).toEqual([3, 63, 1]);
    expect(parseD('44', drivers)).toEqual([44]);
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['another separator', '3;63'],
    ['not a number', 'a'],
    ['an empty item', '3,,63'],
    ['a trailing comma', '3,63,'],
    ['over 100 characters', `${'1,'.repeat(50)}1`],
    ['only unknown numbers', '7,99'],
  ])('is null (the default pick) for %s', (_, param) => {
    expect(parseD(param, drivers)).toBeNull();
  });

  it('reads 100 characters but no more', () => {
    const hundred = `${'0'.repeat(98)}63`;
    expect(hundred).toHaveLength(100);
    expect(parseD(hundred, drivers)).toEqual([63]);
    expect(parseD(`0${hundred}`, drivers)).toBeNull();
  });

  it('formatD joins the numbers with commas, round trip', () => {
    expect(formatD([63, 3])).toBe('63,3');
    expect(formatD([])).toBe('');
    expect(parseD(formatD([44, 1]), drivers)).toEqual([44, 1]);
  });
});

describe('the player tab in the URL (#100)', () => {
  // #112 adds compare and stints; the player has no Mini-sectors tab.
  it.each(['laps', 'order', 'compare', 'stints', 'weather'] as const)('parseTab reads %s', (tab) => {
    expect(parseTab(tab)).toBe(tab);
  });

  it.each([null, '', 'tower', 'LAPS', 'laps ', 'minisectors', 'Stints', '<x>'])(
    'parseTab gives the tower for %j',
    (param) => {
      expect(parseTab(param)).toBe('tower');
    },
  );

  it('replayQuery sets t and keeps the tab, and sets the tab and keeps t', () => {
    expect(replayQuery('?tab=laps', { t: '21:00:15' })).toBe('?t=21:00:15&tab=laps');
    expect(replayQuery('?t=21:00:15', { tab: 'weather' })).toBe('?t=21:00:15&tab=weather');
    expect(replayQuery('?tab=weather&t=21:00:15', { tab: 'order' })).toBe('?t=21:00:15&tab=order');
    expect(replayQuery('', { t: '21:00:15' })).toBe('?t=21:00:15');
    expect(replayQuery('', { tab: 'laps' })).toBe('?tab=laps');
    expect(replayQuery('?t=21:00:15&tab=compare', { tab: 'stints' })).toBe('?t=21:00:15&tab=stints');
    expect(replayQuery('?tab=compare', { t: '21:00:15' })).toBe('?t=21:00:15&tab=compare');
  });

  it('replayQuery drops the tower, a bad t, a bad tab and any other param', () => {
    expect(replayQuery('?t=21:00:15&tab=laps', { tab: 'tower' })).toBe('?t=21:00:15');
    expect(replayQuery('?tab=laps', { tab: 'tower' })).toBe('');
    expect(replayQuery('?t=abc&tab=laps', { tab: 'weather' })).toBe('?tab=weather');
    expect(replayQuery('?t=21:00', {})).toBe('');
    expect(replayQuery('?t=21:00:15&tab=junk&d=1,44', {})).toBe('?t=21:00:15');
  });

  it("replayQuery leaves ':' unescaped", () => {
    expect(replayQuery('?t=21%3A00%3A15', { tab: 'laps' })).toBe('?t=21:00:15&tab=laps');
  });
});
