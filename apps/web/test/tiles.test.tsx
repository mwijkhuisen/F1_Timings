import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { qualiPhases } from '../src/lib/quali.ts';
import { QualiTiles, SessionTiles } from '../src/views/Tiles.tsx';
import { field, lap, sessionDetail } from './laps.ts';

// The tiles above the lap table (P4b): the session's bests, and for qualifying pole and the cut-offs first.

/** Each tile as [label, value text, holder line], with a `—` value's reason as `— (reason)`. */
const tiles = (html: string) =>
  [
    ...html.matchAll(/<div><dt>([^<]+)<\/dt><dd class="v">([\s\S]*?)<\/dd>(?:<dd class="who">([^<]*)<\/dd>)?<\/div>/g),
  ].map(([, label, value = '', who]) => {
    const reason = /<div popover[^>]*>([^<]+)<\/div>/.exec(value)?.[1];
    return [label, reason ? `— (${reason})` : value, who ?? null];
  });

const race = sessionDetail('Race', 'Race', [
  [12, 'ANT'],
  [63, 'RUS'],
]);

describe('SessionTiles', () => {
  it('names each best and its holder', () => {
    const laps = [
      lap(12, 55, { lap_ms: 80_529, s1_ms: 26_606, s2_ms: 35_147, s3_ms: 18_776, st_kph: 340 }),
      lap(63, 6, { lap_ms: 81_000, s1_ms: 26_700, s2_ms: 35_200, s3_ms: 18_724, st_kph: 363 }),
      // An in-lap's values never count.
      lap(63, 7, { lap_ms: 70_000, s2_ms: 30_000, st_kph: 370, is_pit_in: true }),
    ];
    const html = renderToStaticMarkup(<SessionTiles detail={race} laps={laps} />);
    expect(html).toMatch(/^<dl class="tiles" aria-label="Session bests">/);
    expect(tiles(html)).toEqual([
      ['Fastest lap', '1:20.529', 'ANT · L55'],
      ['Best S1', '26.606', 'ANT · L55'],
      ['Best S2', '35.147', 'ANT · L55'],
      ['Best S3', '18.724', 'RUS · L6'],
      ['Sum of best sectors', '1:20.477', '−0.052 to the fastest lap'],
      ['Top speed', '363 km/h', 'RUS · L6 · speed trap'],
    ]);
  });

  it('shows — with its reason for a session without a valid S2', () => {
    const laps = [
      lap(12, 2, { lap_ms: 80_529, s1_ms: 26_606, s3_ms: 18_776 }),
      lap(12, 3, { lap_ms: 90_000, s2_ms: 35_000, is_pit_in: true }),
    ];
    const html = renderToStaticMarkup(<SessionTiles detail={race} laps={laps} />);
    const got = tiles(html);
    expect(got[2]).toEqual(['Best S2', '— (No valid S2 time)', null]);
    expect(got[4]).toEqual(['Sum of best sectors', '— (Needs a valid time in S1, S2 and S3)', null]);
    expect(got[5]).toEqual(['Top speed', '— (No speed-trap reading on a valid lap)', null]);
    expect(html).toContain('popoverTarget="tile-s2"');
    // A holder without a driver entry is shown by number.
    const other = renderToStaticMarkup(<SessionTiles detail={race} laps={[lap(4, 9, { lap_ms: 81_000 })]} />);
    expect(tiles(other)[0]).toEqual(['Fastest lap', '1:21.000', '4 · L9']);
    expect(tiles(other)[1]).toEqual(['Best S1', '— (No valid S1 time)', null]);
  });

  it('says why there is no fastest lap', () => {
    const html = renderToStaticMarkup(<SessionTiles detail={race} laps={[lap(12, 1, { is_pit_out: true })]} />);
    expect(tiles(html)[0]).toEqual(['Fastest lap', '— (No valid lap with a time)', null]);
  });
});

describe('QualiTiles', () => {
  const drivers = Array.from({ length: 22 }, (_, i): [number, string] => [i + 1, `C${String(i + 1).padStart(2, '0')}`]);
  const detail = sessionDetail('Qualifying', 'Qualifying', drivers);

  it('shows pole, then each cut-off with its position', () => {
    const html = renderToStaticMarkup(<QualiTiles detail={detail} quali={qualiPhases(field([22, 16, 10]), [])} />);
    expect(html).toMatch(/^<dl class="tiles" aria-label="Qualifying">/);
    expect(tiles(html)).toEqual([
      ['Pole', '1:18.010', 'C01 · Q3'],
      ['Q1 cut-off (P16)', '1:20.160', 'C16'],
      ['Q2 cut-off (P10)', '1:19.100', 'C10'],
    ]);
  });

  it('says a cut-off is known once the next phase has laps', () => {
    const html = renderToStaticMarkup(<QualiTiles detail={detail} quali={qualiPhases(field([22, 16]), [])} />);
    expect(tiles(html)).toEqual([
      ['Pole', '1:19.010', 'C01 · Q2'],
      ['Q1 cut-off (P16)', '1:20.160', 'C16'],
    ]);
    // Q2 has only out-laps so far: no pole yet, and no cut-off.
    const outs = [lap(1, 1, { quali_phase: 1, is_pit_out: true }), lap(1, 2, { quali_phase: 2, is_pit_out: true })];
    expect(tiles(renderToStaticMarkup(<QualiTiles detail={detail} quali={qualiPhases(outs, [])} />))).toEqual([
      ['Pole', '— (No valid lap in Q2)', null],
      ['Q1 cut-off (P1)', '— (Known once Q2 has laps)', null],
    ]);
  });

  it('shows nothing without phase data', () => {
    expect(renderToStaticMarkup(<QualiTiles detail={detail} quali={qualiPhases([lap(1, 1)], [])} />)).toBe('');
  });
});
