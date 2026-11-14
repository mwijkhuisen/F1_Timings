import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { qualiPhases } from '../src/lib/quali.ts';
import { QualiTable } from '../src/views/QualiTable.tsx';
import { field, lap, result, sessionDetail, time } from './laps.ts';

// Qualifying by phase (P4b) on a synthetic 22-car field: 16 through Q1, 10 through Q2. Car 5 also has a
// faster Q3 lap that was deleted; car 23 is classified but has no laps.

const drivers = Array.from({ length: 23 }, (_, i): [number, string] => [i + 1, `C${String(i + 1).padStart(2, '0')}`]);
const laps = [
  ...field([22, 16, 10]),
  lap(5, 10, { quali_phase: 3, lap_ms: 77_000, deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 4' }),
];
const results = [result(23, null)];
const render = (name: string) => {
  const detail = sessionDetail('Qualifying', name, drivers, results);
  return renderToStaticMarkup(<QualiTable detail={detail} quali={qualiPhases(laps, results)} />);
};
const html = render('Qualifying');

/** Each body row's driver (or `cut:<label>`) in order. */
const rowsOf = (h: string) =>
  [...h.matchAll(/<tr( class="[^"]*")?>(?:<th scope="row"[^>]*>(\w+)<\/th>|<td colSpan="\d+"><span>([^<]+)<)/gi)].map(
    ([, , d, label]) => d ?? `cut:${label}`,
  );
/** The `<tr>` of one driver. */
const row = (d: string) => new RegExp(`<tr[^>]*><th scope="row"[^>]*>${d}</th>([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? '';
const tds = (d: string) => [...row(d).matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, b]) => b ?? '');

describe('QualiTable', () => {
  it('draws a labelled knock-out line after P10 and P16', () => {
    const order = rowsOf(html);
    expect(order.slice(9, 12)).toEqual(['C10', 'cut:Q3 above · knocked out in Q2 below', 'C11']);
    expect(order.slice(16, 19)).toEqual(['C16', 'cut:Q2 above · knocked out in Q1 below', 'C17']);
    expect(order.filter((x) => x.startsWith('cut:'))).toHaveLength(2);
    expect(order.at(-1)).toBe('C23');
    // The row above each line carries it, a 2 px --fg border (owner D4).
    expect([...html.matchAll(/<tr class="cut"><th scope="row"[^>]*>(\w+)</g)].map(([, d]) => d)).toEqual([
      'C10',
      'C16',
    ]);
    expect(html).toContain('<tr class="cutlabel"><td colSpan="6"><span>');
  });

  it('names the phases SQ1–SQ3 in a sprint qualifying', () => {
    const sq = render('Sprint Qualifying');
    expect(sq).toContain('<th scope="col">SQ1</th><th scope="col">SQ2</th><th scope="col">SQ3</th>');
    expect(sq).toContain('<span>SQ3 above · knocked out in SQ2 below</span>');
    expect(sq).toContain('>Knocked out in SQ1</div>');
  });

  it("boxes each phase's fastest time, with the words for a screen reader (#102)", () => {
    const fastest = /<span class="t-purple">([\d:.]+)<span class="vh">, fastest of the phase<\/span><\/span>/g;
    expect([...html.matchAll(fastest)].map(([, t]) => t)).toEqual(['1:20.010', '1:19.010', '1:18.010']);
    expect(row('C01').match(/t-purple/g)).toHaveLength(3);
    expect(html.match(/fastest of the phase/g)).toHaveLength(3);
  });

  it('shows the margin to the cut-off, the gap to pole and the timed laps', () => {
    const [q1, q2, q3, pole, timed] = tds('C01');
    expect(q1).toContain('<small class="margin">−0.150 inside</small>');
    expect(q2).toContain('<small class="margin">−0.090 inside</small>');
    expect(q3).not.toContain('margin');
    expect(pole).toBe('<span class="muted">pole</span>');
    expect(timed).toBe('3');
    expect(tds('C16')[0]).toContain('on the cut-off');
    expect(tds('C11')[1]).toContain('+0.010 out');
    expect(tds('C02')[3]).toBe('+0.010');
    expect(tds('C22')[4]).toBe('1');
  });

  it('says To fastest, not To pole, before Q3 has laps', () => {
    expect(html).toContain('<th scope="col">To pole</th>');
    const detail = sessionDetail('Qualifying', 'Qualifying', drivers, results);
    const two = renderToStaticMarkup(<QualiTable detail={detail} quali={qualiPhases(field([22, 16]), results)} />);
    expect(two).toContain('<th scope="col">Q2</th><th scope="col">To fastest</th>');
    expect(two).toContain('<span class="muted">fastest</span>');
    expect(two.replace(/<[^>]*>/g, ' ')).not.toMatch(/pole/i);
  });

  it('gives — with its reason where a driver has no time', () => {
    const reasons = (d: string) => tds(d).flatMap((b) => /<div popover[^>]*>([^<]+)<\/div>/.exec(b)?.[1] ?? []);
    expect(reasons('C17')).toEqual(['Knocked out in Q1', 'Knocked out in Q1', 'Not in Q3']);
    expect(reasons('C23')).toEqual(['No laps in the data', 'No laps in the data', 'No laps in the data', 'Not in Q3']);
    expect(tds('C23')[0]).toContain('>—</button>');
  });

  it('tags a deleted lap DEL with its time and reason, and keeps the valid best', () => {
    const q3 = tds('C05')[2] ?? '';
    expect(q3).toContain(`>${'1:18.050'}</span>`);
    expect(time(5, 3)).toBe(78_050);
    expect(q3).toContain('<span class="badge">DEL</span>');
    expect(q3).toContain('>Deleted in Q3: 1:17.000 (lap 10), TRACK LIMITS AT TURN 4</div>');
    // The deleted lap counts as a timed lap.
    expect(tds('C05')[4]).toBe('4');
  });

  it('gives every note a unique id', () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says so without phase data', () => {
    const detail = sessionDetail('Qualifying', 'Qualifying');
    expect(renderToStaticMarkup(<QualiTable detail={detail} quali={qualiPhases([lap(1, 1)], [])} />)).toBe(
      '<p>No qualifying phases in the data: see Every lap.</p>',
    );
  });
});
