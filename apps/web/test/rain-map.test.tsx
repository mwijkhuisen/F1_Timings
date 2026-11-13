import { readFileSync } from 'node:fs';
import type { Rain, SessionDetail } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OsmLayers } from '../src/lib/api.ts';
import type { RainFrame, RainGrid } from '../src/lib/rain.ts';
import { RainMap, RainMapCard } from '../src/views/RainMap.tsx';
import { sessionDetail } from './laps.ts';

// The rain map (P5c, A§13), rendered to markup with the data as props; the card's states from a filled query cache.

const grid: RainGrid = {
  map_id: 'it-1922',
  centre_lat: 45.6216,
  centre_lon: 9.2888,
  size: 7,
  step_m: 1500,
  state: 'final',
};
const mm = (cells: Record<number, number | null>) => {
  const out = Array<number | null>(49).fill(0);
  for (const [k, v] of Object.entries(cells)) out[Number(k)] = v;
  return out;
};
// 14:00 and 14:15 UTC are 15:00 and 15:15 in Amsterdam (CET).
const frames: RainFrame[] = [
  { date: '2026-11-09T14:00:00Z', mm: mm({ 16: 0.1, 17: 0.1, 18: 1, 30: 2, 31: null }) },
  { date: '2026-11-09T14:15:00Z', mm: mm({}) },
];
const OUTLINE = 'M -0.37 -0.03 L -0.22 -0.39 L 0.49 0.01 Z';
const osm: OsmLayers = { water: 'M 3 3 L 5 3 L 5 5 Z', coast: 'M 3 3 L 5 3', roads: 'M -1 0 L 1 0' };

const map = (over: Partial<ComponentProps<typeof RainMap>> = {}) =>
  renderToStaticMarkup(
    <RainMap grid={grid} frames={frames} outline={OUTLINE} osm={null} index={0} onIndex={() => {}} {...over} />,
  );
/** The visible text: tags dropped, React's text separators too. */
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&');
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

const OPEN_METEO =
  'Rain: Weather data by Open-Meteo.com (CC BY 4.0). Modelled, not radar; 7 × 7 points binned into three steps.';
const OUTLINE_CREDIT = 'Circuit outline: bacinger/f1-circuits (MIT), simplified.';
const OSM_CREDIT = '© OpenStreetMap contributors, ODbL.';
const UK_CREDIT = 'Includes UK Met Office model data (CC BY-SA 4.0).';
const link = (href: string, label: string) => `<a href="${href}" rel="noreferrer">${label}</a>`;

describe('the rain map', () => {
  it('draws the field in km: water, the cells by step, the rings, the outline, north and the scale bar', () => {
    const html = map({ osm });
    expect(html).toContain('<svg class="rainfield" viewBox="-6 -6 12 12" role="img" aria-label="');
    expect(html).toContain(`<path class="map-outline" d="${OUTLINE}"></path>`);
    expect(count(html, /<circle /g)).toBe(5);
    for (const r of [1, 2, 3, 4, 5]) expect(text(html)).toContain(`${r} km`);
    expect(text(html)).toContain('2 km');
    expect(html).toContain('<g class="map-north">');
    // 0.1 mm → 0.4 mm/h light (two cells), 1 mm → 4 mm/h moderate, 2 mm → 8 mm/h heavy; dry and null cells: none.
    expect(count(html, /<rect class="rain-1" x=/g)).toBe(2);
    expect(count(html, /<rect class="rain-2" x=/g)).toBe(1);
    expect(count(html, /<rect class="rain-3" x=/g)).toBe(1);
    expect(html).toContain('<rect class="rain-3" x="-2.25" y="0.75" width="1.5" height="1.5"></rect>'); // cell 30
    // The layers in order: water, cells, coast and roads, rings, outline, north arrow, scale bar.
    const order = [
      'map-water',
      'rain-1',
      'map-coast',
      'map-road',
      'map-rings',
      'map-outline',
      'map-north',
      'map-scale',
    ];
    const at = order.map((c) => html.indexOf(`class="${c}"`));
    expect(at.every((p) => p >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('draws no cell for a dry frame and says so', () => {
    const html = map({ index: 1 });
    expect(html).not.toMatch(/<rect class="rain-\d" x=/);
    expect(html).toContain('aria-label="No rain within 5 km"');
  });

  it('has the legend with the three steps, drawn with the cells’ classes', () => {
    const html = map();
    expect(html).toContain('<ul class="rainlegend" aria-label="Rain, mm/h">');
    const legend = /<ul class="rainlegend"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    expect(text(legend)).toBe('Light 0.1–2.5 mm/hModerate 2.5–7.6 mm/hHeavy ≥ 7.6 mm/h');
    for (const s of [1, 2, 3]) expect(legend).toContain(`<rect class="rain-${s}" width="1" height="1"></rect>`);
  });

  it('has the time slider: named, capped at the last frame, its value in Amsterdam time', () => {
    const html = map();
    const input = /<input [^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('type="range"');
    expect(input).toContain('aria-label="Rain map time"');
    expect(input).toContain('aria-valuetext="15:00 Amsterdam time"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="1"');
    expect(input).toContain('value="0"');
    expect(html).toMatch(/<output for="[^"]+">15:00<\/output>/);
    expect(map({ index: 1 })).toContain('aria-valuetext="15:15 Amsterdam time"');
  });

  it('shows the summary as text under the slider, the same as the field’s name', () => {
    const html = map();
    const summary = 'Rain in 4 of 49 cells, heaviest 8.0 mm/h, 2 km south-west of the circuit';
    expect(html).toContain(`aria-label="${summary}"`);
    expect(html).toMatch(new RegExp(`<p id="[^"]+" class="rainsum" aria-live="polite">${summary}</p>`));
  });

  it('announces the summary politely and describes the slider with it', () => {
    const html = map();
    const input = /<input [^>]*>/.exec(html)?.[0] ?? '';
    const sum = /<p id="([^"]+)" class="rainsum" aria-live="polite">/.exec(html);
    expect(sum).not.toBeNull();
    expect(input).toContain(`aria-describedby="${sum?.[1]}"`);
  });

  it('names an all-null frame "No rain data for this time", not dry', () => {
    const html = map({ frames: [{ date: frames[0]?.date ?? '', mm: Array<number | null>(49).fill(null) }] });
    expect(html).toContain('aria-label="No rain data for this time"');
    expect(html).toContain('>No rain data for this time</p>');
    expect(html).not.toContain('No rain within');
  });

  it('credits Open-Meteo and the outline in ADR-0008’s words, with plain noreferrer links', () => {
    const html = map();
    const credits = /<p class="foot rainsrc">[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';
    expect(text(credits)).toBe(`${OPEN_METEO} ${OUTLINE_CREDIT}`);
    expect(credits).toContain(link('https://open-meteo.com/', 'Open-Meteo.com'));
    expect(credits).toContain(link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'));
    expect(credits).toContain(link('https://github.com/bacinger/f1-circuits', 'bacinger/f1-circuits'));
    expect(credits).toContain(link('/third-party-licences.txt', 'MIT'));
    expect(count(credits, /<a /g)).toBe(count(credits, /<a href="[^"]+" rel="noreferrer">/g));
  });

  it('credits OpenStreetMap only when its layers are drawn', () => {
    expect(text(map())).not.toContain('OpenStreetMap');
    expect(text(map({ osm: { water: '', coast: '', roads: '' } }))).not.toContain('OpenStreetMap');
    const html = map({ osm });
    expect(text(html)).toContain(`${OUTLINE_CREDIT} ${OSM_CREDIT}`);
    expect(html).toContain(link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'));
    expect(html).toContain(link('https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL'));
  });

  it('credits the UK Met Office only for Silverstone (gb-1948)', () => {
    expect(text(map())).not.toContain('Met Office');
    const html = map({ grid: { ...grid, map_id: 'gb-1948' } });
    expect(text(html)).toContain(`${OUTLINE_CREDIT} ${UK_CREDIT}`);
    expect(html).toContain(link('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'));
  });

  it('without an outline file says so and still draws the cells on the km grid', () => {
    const html = map({ outline: null });
    expect(html).toContain('<p>No circuit outline for this venue.</p>');
    expect(html).not.toContain('map-outline');
    expect(count(html, /<rect class="rain-\d" x=/g)).toBe(4);
    expect(count(html, /<circle /g)).toBe(5);
    expect(html).toContain('<g class="map-scale">');
  });

  it('notes a coarse model', () => {
    expect(map()).not.toContain('Coarse model');
    expect(map({ coarse: true })).toContain('Coarse model here: the field may look uniform.');
  });

  // `vector-effect` is not inherited: on a <g> it does nothing and each child's 1 px stroke scales with the viewBox to 1 km.
  it('gives every stroked element its own non-scaling stroke, never a <g>', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]*)\{[^}]*vector-effect:\s*non-scaling-stroke;[^}]*\}/.exec(css)?.[1] ?? '';
    const selectors = rule.split(',').map((x) => x.trim());
    expect(selectors).toEqual([
      '.rainfield .map-coast',
      '.rainfield .map-road',
      '.rainfield .map-rings circle',
      '.rainfield .map-halo',
      '.rainfield .map-outline',
      '.rainfield .map-scale path',
    ]);
    // Each of those is an element of the markup (a <circle> in the rings group, a <path> in the scale group).
    const html = map({ osm });
    for (const c of ['map-coast', 'map-road', 'map-halo', 'map-outline']) expect(html).toContain(`<path class="${c}"`);
    expect(html).toMatch(/<g class="map-rings"><circle /);
    expect(html).toMatch(/<g class="map-scale"><path /);
  });

  it('sets no style attribute and no <style> (CSP)', () => {
    const html = map({ osm, outline: null, coarse: true });
    expect(html).not.toContain('<style');
    for (const [, v = ''] of html.matchAll(/\sstyle="([^"]*)"/g)) expect(v).toMatch(/^(--[\w-]+:[^;]*;?)+$/);
  });
});

// The card's states, from a query cache filled beforehand (no request is made).
describe('the rain map card', () => {
  const monza = (over: Partial<SessionDetail['session']> = {}): SessionDetail => {
    const d = sessionDetail('Race', 'Race');
    return {
      ...d,
      session: { ...d.session, date_start: '2026-11-09T14:10:00Z', ...over },
      meeting: { ...d.meeting, circuit_short_name: 'Monza' },
    };
  };
  const card = (
    detail: SessionDetail,
    rain?: Rain,
    files?: { outline: string | null; osm: OsmLayers | null },
    cap?: number,
  ) => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    if (rain) client.setQueryData(['rain', detail.session.session_key], rain);
    if (files) client.setQueryData(['map', rain?.grid?.map_id ?? null], files);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RainMapCard detail={detail} cap={cap} />
      </QueryClientProvider>,
    );
  };

  it('renders nothing for a cancelled session', () => {
    expect(card(monza({ is_cancelled: true }), { grid, frames })).toBe('');
  });

  it('says so for a venue without a circuit outline', () => {
    const d = monza();
    const html = card({ ...d, meeting: { ...d.meeting, circuit_short_name: 'Nürburgring' } });
    expect(html).toContain('<h2>Rain around the circuit</h2><p>mm/h, Amsterdam time</p>');
    expect(html).toContain('<p>No circuit outline for this venue.</p>');
    expect(html).not.toContain('<svg');
  });

  it('is loading while the rain query has no answer', () => {
    expect(card(monza())).toContain('Loading…');
  });

  it('says "Rain map not fetched yet." without a grid or without frames', () => {
    expect(card(monza(), { grid: null, frames: [] })).toContain('<p>Rain map not fetched yet.</p>');
    expect(card(monza(), { grid, frames: [] })).toContain('<p>Rain map not fetched yet.</p>');
  });

  it('says a failed grid failed: no rain data without frames, incomplete after its last frame with them (#99)', () => {
    const failed = { ...grid, state: 'failed' } as const;
    const files = { outline: OUTLINE, osm: null };
    expect(card(monza(), { grid: failed, frames: [] }, files)).toContain('<p>Rain map fetch failed: no rain data.</p>');
    const html = card(monza(), { grid: failed, frames }, files);
    // The last frame is 14:15 UTC, 15:15 in Amsterdam; the note sits above the map.
    expect(html).toMatch(
      /<p>Rain data incomplete: the fetch failed after 15:15.<\/p><div class="rainbody"><svg class="rainfield"/,
    );
  });

  it('says frames are still arriving for a live grid on the session page, not in the player', () => {
    const live = { ...grid, state: 'live' } as const;
    const files = { outline: OUTLINE, osm: null };
    expect(card(monza(), { grid: live, frames }, files)).toMatch(
      /<p>Frames still arriving \(every 15 min\).<\/p><div class="rainbody"><svg class="rainfield"/,
    );
    expect(card(monza(), { grid: live, frames }, files, Date.parse('2026-11-09T15:00:00Z'))).not.toContain(
      'Frames still arriving',
    );
    expect(card(monza(), { grid, frames }, files)).not.toContain('Frames still arriving');
    expect(card(monza(), { grid: live, frames: [] }, files)).toContain('<p>Rain map not fetched yet.</p>');
  });

  it('opens at the first frame at or after the start, with the outline and a native model', () => {
    const html = card(monza(), { grid, frames }, { outline: OUTLINE, osm: null });
    expect(html).toContain('aria-valuetext="15:15 Amsterdam time"');
    expect(html).toContain('map-outline');
    expect(html).not.toContain('Coarse model');
  });

  it('notes the coarse model where CIRCUITS has no native 15-minute data (Silverstone)', () => {
    const d = monza();
    const uk = { ...d, meeting: { ...d.meeting, circuit_short_name: 'Silverstone' } };
    const html = card(uk, { grid: { ...grid, map_id: 'gb-1948' }, frames }, { outline: OUTLINE, osm: null });
    expect(html).toContain('Coarse model here: the field may look uniform.');
    expect(text(html)).toContain(UK_CREDIT);
  });
});
