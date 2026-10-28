import type { Lap } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Driver } from '../src/lib/session.ts';
import { MiniSectors, segClass } from '../src/views/MiniSectors.tsx';

// The mini-sector grid and the speed traps (D6), rendered statically (A§15).

const lap = (driver_number: number, lap_number: number, extra: Partial<Lap>): Lap => ({
  driver_number,
  lap_number,
  date_start: null,
  lap_ms: null,
  s1_ms: null,
  s2_ms: null,
  s3_ms: null,
  i1_kph: 290,
  i2_kph: 250,
  st_kph: 310,
  is_pit_out: false,
  is_pit_in: false,
  seg1: null,
  seg2: null,
  seg3: null,
  deleted: false,
  deleted_reason: null,
  quali_phase: null,
  compound: 'SOFT',
  colour: { lap: null, s1: null, s2: null, s3: null },
  ...extra,
});

const VER: Driver = { number: 1, acronym: 'VER', name: null, team: '#3671C6' };
const NOR: Driver = { number: 4, acronym: 'NOR', name: null, team: null };

const laps = [
  // Listed out of order: the grid sorts by lap number.
  lap(1, 2, {
    seg1: [2048, 2064, 9999, 2048],
    seg2: [2052, 2049],
    seg3: [2065],
    deleted: true,
    deleted_reason: 'TRACK LIMITS AT TURN 1',
    is_pit_in: true,
  }),
  lap(1, 1, { seg1: [2049, 2050, null], seg2: [2051, 0], seg3: null, i1_kph: null, is_pit_out: true }),
  lap(4, 1, { seg1: [2068, 1, 2048, 2048], seg2: [2048, 2048], seg3: [2048], st_kph: null }),
];

const render = (drivers: Driver[], type: string | null = 'Qualifying') =>
  renderToStaticMarkup(<MiniSectors sessionType={type} laps={laps} drivers={drivers} />);

/** Per lap row: the lap cell, then per sector the [class, title] of each box, then the speeds. */
const lapRows = (html: string) =>
  [...html.matchAll(/<tr><th scope="row"[^>]*>([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)].map(([, head = '', rest = '']) => {
    const tds = [...rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, td = '']) => td);
    const boxes = (td: string) =>
      [...td.matchAll(/<span class="ms (ms-\w+)" role="img" aria-label="([^"]*)" title="([^"]*)">/g)].map(
        ([, cls, label, title]) => {
          expect(label).toBe(title);
          return [cls, title];
        },
      );
    return { head, sectors: tds.slice(0, 3).map(boxes), speeds: tds.slice(3) };
  });

describe('segClass', () => {
  it.each([
    [2048, 'ms-yellow'],
    [2049, 'ms-green'],
    [2051, 'ms-purple'],
    [2064, 'ms-pit'],
    [0, 'ms-none'],
    [null, 'ms-none'],
  ])('%s → %s', (code, cls) => {
    expect(segClass(code)).toBe(cls);
  });

  it.each([2050, 2052, 2065, 2068, 1, 9999])('unknown segment codes render grey: %s', (code) => {
    expect(segClass(code)).toBe('ms-grey');
  });
});

describe('the mini-sector grid', () => {
  const html = render([VER, NOR]);
  const [ver1, ver2, nor1] = lapRows(html);

  it('unknown segment codes render grey, with the code in the title', () => {
    expect(ver1?.sectors[0]?.[1]).toEqual(['ms-grey', 'unknown code 2050']);
    expect(ver2?.sectors[0]?.[2]).toEqual(['ms-grey', 'unknown code 9999']);
    expect(ver2?.sectors[1]?.[0]).toEqual(['ms-grey', 'unknown code 2052']);
    expect(ver2?.sectors[2]?.[0]).toEqual(['ms-grey', 'unknown code 2065']);
    expect(nor1?.sectors[0]?.slice(0, 2)).toEqual([
      ['ms-grey', 'unknown code 2068'],
      ['ms-grey', 'unknown code 1'],
    ]);
  });

  it('pads every sector to the longest array in the session, with no-data boxes', () => {
    // S1 4, S2 2, S3 1 boxes per lap. VER lap 1: a null element, then padding; a null S3 array.
    expect(ver1?.sectors).toEqual([
      [
        ['ms-green', 'personal best'],
        ['ms-grey', 'unknown code 2050'],
        ['ms-none', 'no data'],
        ['ms-none', 'no data'],
      ],
      [
        ['ms-purple', 'overall best'],
        ['ms-none', 'no data'],
      ],
      [['ms-none', 'no data']],
    ]);
    expect(ver2?.sectors[0]).toEqual([
      ['ms-yellow', 'other'],
      ['ms-pit', 'pit lane'],
      ['ms-grey', 'unknown code 9999'],
      ['ms-yellow', 'other'],
    ]);
    expect(nor1?.sectors.map((s) => s.length)).toEqual([4, 2, 1]);
  });

  it('shows the speed traps in km/h, — for a null speed', () => {
    expect(ver1?.speeds).toEqual(['—', '250', '310']);
    expect(nor1?.speeds).toEqual(['290', '250', '—']);
    expect(html).toContain('aria-label="Mini-sectors and speed traps (km/h)"');
  });

  it('strikes a deleted lap and badges in- and out-laps, laps in order', () => {
    expect(ver1?.head).toBe('1<span class="badge">OUT</span>');
    expect(ver2?.head).toBe('<s>2</s><span class="badge">IN</span>');
    expect(html).toContain('<th scope="row" title="Deleted: TRACK LIMITS AT TURN 1">');
  });

  it('groups the laps per selected driver, in pick order, with the team bar', () => {
    const heads = [...html.matchAll(/<th scope="rowgroup" colSpan="7" class="drv"([^>]*)>(\w+)</g)];
    expect(heads.map(([, attrs, a]) => [a, attrs])).toEqual([
      ['VER', ' style="--team:#3671C6"'],
      ['NOR', ''],
    ]);
    expect(lapRows(render([NOR, VER]))[0]?.speeds).toEqual(['290', '250', '—']);
    expect(lapRows(render([NOR]))).toHaveLength(1);
  });

  it('shows the legend above the grid, inside a scroll box', () => {
    expect(html).toMatch(/<p class="legend">[\s\S]*<div class="scroll"><table/);
    for (const text of ['overall best', 'personal best', 'other', 'pit lane', 'unknown code', 'no data'])
      expect(html).toContain(`</span> ${text}</span>`);
  });

  it('shows the race banner only in a Race-type session', () => {
    const banner = '<p class="banner" role="note">Mini-sector colours unreliable in races</p>';
    expect(render([VER], 'Race')).toContain(banner);
    expect(html).not.toContain('banner');
    expect(render([VER], null)).not.toContain('banner');
  });

  it('asks for a driver without a selection', () => {
    expect(render([])).toBe('<p>Pick a driver.</p>');
  });
});
