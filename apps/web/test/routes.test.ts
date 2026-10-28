import { describe, expect, it } from 'vitest';
import { routeOf, sessionPath, slug } from '../src/lib/routes.ts';

describe('routeOf', () => {
  it.each([
    ['/', { id: 'latest' }],
    ['/2026', { id: 'year', year: 2026 }],
    ['/status', { id: 'status' }],
    ['/2026/1290/9965', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: null }],
    ['/2026/1290/9965/laps', { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'laps' }],
    [
      '/2026/1290-singapore/9965-race/stints',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'stints' },
    ],
    [
      '/2026/1290-singapore/9965-race/compare',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'compare' },
    ],
    [
      '/2026/1290-singapore/9965-race/minisectors',
      { id: 'session', year: 2026, meeting: 1290, session: 9965, view: 'minisectors' },
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
    '/2026/1290/9965/',
    '/2026/abc/9965/laps',
    '/2026/1290-Singapore/9965/laps',
    '/2026/1290_x/9965/laps',
    '/2026/1234567890/9965/laps',
    '/status/x',
    '/live',
    '/replay/abc',
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
  });
});
