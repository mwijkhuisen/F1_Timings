import type { Lap } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Driver } from '../src/lib/session.ts';
import { Order } from '../src/views/Order.tsx';
import { lap } from './laps.ts';

// The Order tab (#115, A§13) on hand-built laps, rendered statically.

const T0 = Date.parse('2026-10-25T20:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
/** Car d's laps: lap 1 starts `start` s after T0, each lap `times[i]` s, each starting where the last one ended. */
const drive = (d: number, start: number, times: number[]): Lap[] => {
  let s = start;
  return times.map((t, i) => {
    const l = lap(d, i + 1, { date_start: at(s), lap_ms: t * 1000 });
    s += t;
    return l;
  });
};
/** A car whose lap rows exist but carry neither a start nor a time from lap 2 on: no crossing after laps 2 and up. */
const holed = (d: number, start: number, rows: number): Lap[] => [
  lap(d, 1, { date_start: at(start), lap_ms: 90_000 }),
  ...Array.from({ length: rows - 1 }, (_, i) => lap(d, i + 2)),
];

const VER: Driver = { number: 1, acronym: 'VER', name: 'Max Verstappen', team: '#3671C6' };
const NOR: Driver = { number: 4, acronym: 'NOR', name: null, team: '#FF8000' };
const PER: Driver = { number: 11, acronym: 'PER', name: null, team: null };
const NOGRID = 'Grid not in the OpenF1 data';

// NOR leads after lap 1 (crosses at 90 s, VER at 91 s, PER at 92 s), VER after lap 2 and 3.
const full = [...drive(1, 0, [91, 80, 90]), ...drive(4, 1, [89, 90, 90]), ...drive(11, 2, [90, 90, 90])];
const GRID = new Map([
  [1, 1],
  [4, 2],
  [11, 3],
]);

const render = (laps: Lap[], grid: Map<number, number> | null = null, drivers = [VER, NOR, PER]) =>
  renderToStaticMarkup(<Order drivers={drivers} laps={laps} grid={grid} noGrid={NOGRID} />);
const rowOf = (html: string, label: string) =>
  html.match(new RegExp(`<tr><th scope="row" class="ln">${label}</th>.*?</tr>`))?.[0] ?? '';
const acronyms = (row: string) => [...row.matchAll(/<td[^>]*>([A-Z]{3})/g)].map((m) => m[1]);

describe('Order', () => {
  it('says so when no lap has a start', () => {
    expect(render([lap(1, 1), lap(4, 1)])).toBe('<p class="muted">No line crossings in this session&#x27;s data.</p>');
    expect(render([])).toContain('No line crossings');
  });

  it('is a named scroll region around a table with the sticky head and lap column, and the caption', () => {
    const html = render(full, GRID);
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Running order">');
    expect(html).toContain('<table class="list order" aria-label="Running order">');
    // thead th and tbody th are the sticky head row and first column (styles.css).
    expect(html).toMatch(
      /<thead><tr><th scope="col" class="ln">Lap<\/th><th scope="col">P1<\/th><th scope="col">P2<\/th><th scope="col">P3<\/th><\/tr><\/thead>/,
    );
    expect(html).toContain('<tr><th scope="row" class="ln">2</th>');
    expect(html).not.toContain('P4');
    expect(html).toContain(
      '<p class="muted">The order at the line, from the timing data. It can differ from the classification where a time penalty applies.</p>',
    );
  });

  it('ranks each lap by laps completed, then the time at the line', () => {
    const html = render(full, GRID);
    expect(acronyms(rowOf(html, '1'))).toEqual(['NOR', 'VER', 'PER']);
    // Lap 2: VER 91 + 80 = 171 s, NOR 90 + 90 = 180 s, PER 182 s.
    expect(acronyms(rowOf(html, '2'))).toEqual(['VER', 'NOR', 'PER']);
    expect(acronyms(rowOf(html, '3'))).toEqual(['VER', 'NOR', 'PER']);
  });

  it('sets the team bar only through --team and --team-l, and none without a colour', () => {
    const html = render(full, GRID);
    expect(html).toContain('<td class="drv" style="--team:#3671C6;--team-l:');
    expect(html).toContain('--team:#FF8000');
    // PER has no team colour: no style, the CSS falls back to --muted.
    expect(rowOf(html, '1')).toContain('<td class="drv">PER');
    const inline = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(inline.length).toBeGreaterThan(0);
    for (const s of inline) expect(s.split(';').every((p) => p.startsWith('--team'))).toBe(true);
    expect(html).toContain('title="Max Verstappen"');
  });

  it('falls back to the number for a driver that is not in the list', () => {
    expect(rowOf(render(full, null, [VER, NOR]), '1')).toContain('<td class="drv">11</td>');
  });

  it('starts with a Grid row in grid order, and only from integer positions from 1', () => {
    const grid = new Map([
      [11, 1],
      [1, 2],
      [4, 3],
      [99, 0],
      [98, 1.5],
    ]);
    expect(acronyms(rowOf(render(full, grid), 'Grid'))).toEqual(['PER', 'VER', 'NOR']);
    expect(render(full, GRID).indexOf('<th scope="row" class="ln">Grid</th>')).toBeLessThan(
      render(full, GRID).indexOf('<th scope="row" class="ln">1</th>'),
    );
  });

  it('shows the no-grid text in a Grid row across the positions when there is no grid', () => {
    for (const grid of [null, new Map<number, number>(), new Map([[1, 0]])]) {
      const html = render(full, grid);
      expect(rowOf(html, 'Grid')).toBe(
        `<tr><th scope="row" class="ln">Grid</th><td colSpan="3" class="muted">${NOGRID}</td></tr>`,
      );
      // Never the qualifying order: no gain without a grid.
      expect(html).not.toContain('gained');
    }
  });

  it('gives lap 1 each driver’s places gained, with the tower’s words', () => {
    // Grid P3, P1, P2 for VER, NOR, PER: after lap 1 NOR, VER, PER.
    const html = render(
      full,
      new Map([
        [1, 3],
        [4, 1],
        [11, 3],
      ]),
    );
    const row = rowOf(html, '1');
    expect(row).toContain(
      'NOR<span class="gain"><span class="muted"><span aria-hidden="true">–</span><span class="vh">no change</span>',
    );
    expect(row).toContain(
      'VER<span class="gain"><span><span aria-hidden="true">▲1</span><span class="vh">gained 1 place</span>',
    );
    expect(row).toContain('PER<span class="gain"><span class="muted"><span aria-hidden="true">–</span>');
    // Lap 2 has no gains.
    expect(rowOf(html, '2')).not.toContain('gain');

    const lost = render(
      full,
      new Map([
        [1, 1],
        [4, 2],
        [11, 1],
      ]),
    );
    expect(rowOf(lost, '1')).toContain('<span aria-hidden="true">▼2</span><span class="vh">lost 2 places</span>');
    expect(rowOf(lost, '1')).toContain('gained 1 place');
  });

  it('shows no gain for a driver the grid map lacks', () => {
    const row = rowOf(render(full, new Map([[1, 2]])), '1');
    expect(row).toContain('VER<span class="gain">');
    expect(row).not.toContain('NOR<span');
    expect(row).not.toContain('PER<span');
  });

  describe('an incomplete row', () => {
    const laps = [...drive(1, 0, [91, 80, 90]), ...drive(4, 1, [89, 90, 90]), ...holed(11, 2, 3)];
    const html = render(laps, GRID);

    // React keeps the prop name popoverTarget; HTML attribute names are case-insensitive.
    const rowTwo = html.match(/<tr><th scope="row" class="ln"><button[^>]*popovertarget="ord-2".*?<\/tr>/i)?.[0] ?? '';

    it('puts a note on the lap and mutes the ranked cells', () => {
      expect(rowOf(html, '1')).not.toContain('order incomplete');
      expect(html).toContain('id="ord-2" class="pop">1 driver without a crossing: order incomplete</div>');
      expect(html).toContain('id="ord-3" class="pop">1 driver without a crossing: order incomplete</div>');
      expect(rowTwo).toContain('<td class="drv muted"');
      expect(rowTwo).toContain('VER<span class="vh">, order incomplete</span>');
      expect(rowTwo).toContain('NOR<span class="vh">, order incomplete</span>');
    });

    it('then gives each missing driver its acronym, a dash and a note', () => {
      expect(rowTwo).toMatch(
        /PER —<\/button><div popover="auto" id="ord-2-11" class="pop">No crossing for PER after lap 2<\/div>/,
      );
      expect(html).toContain('id="ord-3-11" class="pop">No crossing for PER after lap 3</div>');
      // PER is never ranked in that row: the ranked cells are the others.
      expect(acronyms(rowTwo.replace(/<button.*?<\/div>/g, ''))).toEqual(['VER', 'NOR']);
    });

    it('widens the table for the cars of a row and counts the plural', () => {
      const two = render([...drive(1, 0, [90, 90, 90]), ...holed(11, 1, 3), ...holed(4, 2, 3)], null);
      expect(two).toContain('2 drivers without a crossing: order incomplete');
      expect(two).toContain('P3');
    });
  });
});
