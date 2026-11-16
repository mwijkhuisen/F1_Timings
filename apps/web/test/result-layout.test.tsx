import { readFileSync } from 'node:fs';
import { Standings } from '@f1/contracts';
import { format } from 'echarts/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResultTable, StandingsSection } from '../src/views/Result.tsx';
import { resultFixture, sessionDetail } from './laps.ts';

// The Result tab's tables at 360 and 390 px and the three-column breakpoint (#202). CI has no browser and happy-dom no layout,
// so this models the browser's auto table layout, as P8's chart test lays out through ECharts' own text metrics. A
// column is as wide as its widest cell; a cell is its text, measured by zrender (`format.getTextRect`, in node its
// built-in Arial-like width table) at the CSS sizes (14 px body and names, 12 px upper-case heads tracked 0.06em,
// 11 px `.margin` line, a Note button at least 44 px), plus the cell padding (8 px a side, 6 px under 600 px, both read
// from the CSS) and the 4 px `.drv` bar. At its narrowest a wrapping cell (a team name, a head outside a box) counts
// its longest word; at its widest nothing wraps.
// Calibration (Edge headless on Windows, Segoe UI, the 2026 São Paulo race 11412, Singapore sprint 11383 and Mexico
// FP1 11397, #202 harness): Edge / model is 0.968–0.980 per table at the narrowest and 0.974–0.984 at the widest, so
// the model is 1.6–3.2 % wide; per column it is 0.935–1.042 (it misses bold and the 11 px line by up to 4 %). The
// factor K covers that and a wider system font (SF Pro on an iPhone) on top; the 360 px case uses 1.0, since the model
// is already 1.6–3.2 % wider than Edge per table.
const K = 1.05;
const SCROLLBAR = 17; // a classic desktop scroll bar, which the media query's width includes

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = (pattern: RegExp) => {
  const m = pattern.exec(css);
  expect(m, String(pattern)).not.toBeNull();
  return Number(m?.[1]);
};
const GUTTER = rule(/\nmain \{\n {2}padding: 0 (\d+)px/); // main's, a side
const PAD = rule(/\n {2}:not\(\.scroll\) > \.result :is\(th, td\) \{\n {4}padding: 0 (\d+)px;/); // under 600 px
const PAD_WIDE = rule(/\nth,\ntd \{\n {2}height: 44px;\n {2}padding: 0 (\d+)px;/);
const golden = <T,>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../server/src/openf1/fixtures/${name}.golden.json`, import.meta.url), 'utf8'));

// The data: the committed OpenF1 fixtures. Every team name of the field shows (championship_teams), two cars each;
// an acronym is three characters, as OpenF1's.
const TEAMS = golden<{ team_name: string }[]>('championship_teams-normal').map((t) => t.team_name);
const classification = (type: string, name: string, file: string) => {
  const results = resultFixture(file);
  const d = sessionDetail(
    type,
    name,
    results.map((r): [number, string] => [r.driver_number, `D${r.driver_number}`]),
    results,
  );
  return renderToStaticMarkup(
    <ResultTable
      detail={{ ...d, drivers: d.drivers.map((x, i) => ({ ...x, team_name: TEAMS[i % TEAMS.length] ?? null })) }}
      laps={null}
    />,
  );
};
type Place = { position_start: number | null; position_current: number; points_start: number; points_current: number };
const place = (p: Place) => ({
  position: p.position_current,
  change: p.position_start === null ? null : p.position_start - p.position_current,
  team_colour: null,
  points: p.points_current,
  session_points: p.points_current - p.points_start,
});
const standings = (file: string, sprint: boolean) =>
  renderToStaticMarkup(
    <StandingsSection
      sprint={sprint}
      standings={Standings.parse({
        drivers: golden<(Place & { driver_number: number })[]>(`championship_drivers-${file}`).map((p, i) => ({
          ...place(p),
          full_name: `Driver ${p.driver_number}`,
          acronym: `D${p.driver_number}`,
          // 2026's mid-season swap: one driver shows both teams (11412: "Racing Bulls / Red Bull Racing").
          team_names: i === 1 ? ['Racing Bulls', 'Red Bull Racing'] : [TEAMS[i % TEAMS.length]],
        })),
        teams: golden<(Place & { team_name: string })[]>(`championship_teams-${file}`).map((p) => ({
          ...place(p),
          team_name: p.team_name,
        })),
        rounds: [],
        provisional: false,
      })}
    />,
  );

const width = (text: string, px: number, weight = 400) =>
  format.getTextRect(text, `${weight} ${px}px sans-serif`).width;
const decode = (s: string) =>
  s
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
type Cell = { text: string; line: string; note: boolean; head: boolean; drv: boolean };
/** One table's cells by row, from the markup: a popover and the `.vh` words take no width. */
const cells = (html: string, label: string): Cell[][] => {
  const table = new RegExp(
    `<table class="result" aria-label="${label.replace("'", '&#x27;')}">([\\s\\S]*?)</table>`,
  ).exec(html)?.[1];
  expect(table, label).toBeDefined();
  return [...(table ?? '').matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, tr = '']) =>
    [...tr.matchAll(/<(t[dh])([^>]*)>([\s\S]*?)<\/t[dh]>/g)].map(([, tag, attrs = '', inner = '']) => {
      const body = inner.replace(/<div popover[\s\S]*?<\/div>/g, '').replace(/<span class="vh">[\s\S]*?<\/span>/g, '');
      const line = /<small class="margin">([\s\S]*?)<\/small>/.exec(body)?.[1] ?? '';
      return {
        text: decode(body.replace(/<small class="margin">[\s\S]*?<\/small>/, '').replace(/<[^>]*>/g, '')),
        line: decode(line),
        note: body.includes('class="note"'),
        head: tag === 'th' && attrs.includes('scope="col"'),
        drv: attrs.includes('class="drv"'),
      };
    }),
  );
};
/** The table's width at its narrowest (`min`, what 390 px gets) or widest (`max`, a grid track's max-content). */
const tableWidth = (rows: Cell[][], at: 'min' | 'max', pad = PAD_WIDE) => {
  const cell = (c: Cell) => {
    const words = (s: string) => (at === 'min' && (c.drv || c.head) ? s.split(' ') : [s]);
    const longest = (s: string, px: number, track = 0) =>
      Math.max(0, ...words(s).map((w) => width(w, px) + track * px * [...w].length));
    const content = c.head
      ? longest(c.text.toUpperCase(), 12, 0.06)
      : Math.max(c.note ? 44 : 0, longest(c.text, 14), c.line ? longest(c.line, 11) : 0);
    return content + 2 * pad + (c.drv ? 4 : 0);
  };
  const columns = rows.reduce<number[]>((cols, row) => row.map((c, i) => Math.max(cols[i] ?? 0, cell(c))), []);
  return columns.reduce((a, b) => a + b, 0);
};

const race = { result: classification('Race', 'Race', 'normal'), standings: standings('normal', false) };
const sprint = { result: classification('Race', 'Sprint', 'sprint'), standings: standings('sprint', true) };
const practice = classification('Practice', 'Practice 1', 'normal');
const three = ({ result, standings: s }: typeof race, at: 'min' | 'max') => [
  tableWidth(cells(result, 'Result'), at),
  tableWidth(cells(s, "Drivers' standings"), at),
  tableWidth(cells(s, "Constructors' standings"), at),
];

describe('the Result tab on a phone (#202)', () => {
  it('relies on the CSS it models: 8 px padding, no wrap, but the team names and the heads outside a box', () => {
    expect(css).toMatch(/\nth,\ntd \{\n {2}height: 44px;\n {2}padding: 0 \d+px;\n {2}white-space: nowrap;/);
    expect(css).toMatch(/\n@media \(max-width: 600px\) \{\n {2}:not\(\.scroll\) > \.result :is\(th, td\) \{/);
    expect(css).toMatch(/\n:not\(\.scroll\) > \.result thead th \{[^}]*white-space: normal;/);
    expect(css).toMatch(/\n:not\(\.scroll\) > \.result th\.drv \{\n {2}white-space: normal;/);
    expect(css).toMatch(/\n\.drv \{\n {2}border-left: 4px solid var\(--tc\);/);
  });

  it.each([
    ['the race', race.result, 'Result'],
    ['the sprint', sprint.result, 'Result'],
    ['a practice', practice, 'Result'],
    ['the drivers after the race', race.standings, "Drivers' standings"],
    ['the constructors after the race', race.standings, "Constructors' standings"],
    ['the drivers after the sprint', sprint.standings, "Drivers' standings"],
    ['the constructors after the sprint', sprint.standings, "Constructors' standings"],
  ])('fits %s in 358 px at 390 and in 328 px at 360, nothing cut off', (_, html, label) => {
    const rows = cells(html, label);
    expect(rows.length).toBeGreaterThan(11);
    expect(tableWidth(rows, 'min', PAD) * K).toBeLessThanOrEqual(390 - 2 * GUTTER);
    expect(tableWidth(rows, 'min', PAD)).toBeLessThanOrEqual(360 - 2 * GUTTER);
  });

  it('keeps each heading on one line above its table, at 390 px and in a column', () => {
    for (const { result, standings: s } of [race, sprint]) {
      const heads = [...s.matchAll(/<h2>([^<]*)<\/h2>/g)].map(([, h = '']) => h).slice(0, 2);
      expect(heads).toHaveLength(2);
      const narrowest = Math.min(...three({ result, standings: s }, 'max'));
      for (const h of ['Classification', ...heads]) {
        expect(width(h, 17, 700) * K, h).toBeLessThanOrEqual(390 - 2 * GUTTER);
        expect(width(h, 17, 700) * K, h).toBeLessThanOrEqual(narrowest);
      }
    }
  });
});

describe('the three-column breakpoint B (#202)', () => {
  const B = Number(/\n@media \(min-width: (\d+)px\) \{\n {2}\.result-grid \{/.exec(css)?.[1]);
  const gap = Number(/\n\.result-grid \{[^}]*column-gap: (\d+)px;/.exec(css)?.[1]);

  it('is between the phone and 1440 px', () => {
    expect(B).toBeGreaterThan(390);
    expect(B).toBeLessThanOrEqual(1440);
    expect(gap).toBeGreaterThan(0);
  });

  it.each([
    ['race', race],
    ['sprint', sprint],
  ])('fits the three %s tables side by side, unwrapped, with the gaps, the gutter and a scroll bar', (_, tab) => {
    const sum = three(tab, 'max').reduce((a, b) => a + b, 0);
    expect(sum * K + 2 * gap + 2 * GUTTER + SCROLLBAR).toBeLessThanOrEqual(B);
  });
});
