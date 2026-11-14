import { readFileSync } from 'node:fs';
import type { Laps, SessionDetail } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../src/lib/time.ts';
import { ResultTab, ResultTable } from '../src/views/Result.tsx';
import { lap, result, sessionDetail } from './laps.ts';

// The Result tab (#110) on the OpenF1 fixtures' shapes: the race 11388, the sprint 11383 and the qualifying 11392,
// read from the server's committed fixtures and stored as ingest stores them (`perPhase` in ingest/normalise.ts:
// seconds as ms, a string gap such as "+1 LAP" as [null], Q1–Q3 per phase).

type Raw = {
  driver_number: number;
  position: number | null;
  number_of_laps: number | null;
  dnf: boolean | null;
  dns: boolean | null;
  dsq: boolean | null;
  duration: number | (number | null)[] | null;
  gap_to_leader: number | string | (number | null)[] | null;
};
const ms = (s: number | null) => (s === null ? null : Math.round(s * 1000));
const perPhase = (v: Raw['duration'] | Raw['gap_to_leader']) =>
  v === null ? null : typeof v === 'string' ? [null] : Array.isArray(v) ? v.map(ms) : [ms(v)];
const fixture = (name: string): SessionDetail['results'] =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../server/src/openf1/fixtures/session_result-${name}.golden.json`, import.meta.url),
        'utf8',
      ),
    ) as Raw[]
  ).map((r) => ({
    driver_number: r.driver_number,
    position: r.position,
    laps: r.number_of_laps,
    grid: null,
    dnf: r.dnf,
    dns: r.dns,
    dsq: r.dsq,
    durations_ms: perPhase(r.duration),
    gaps_ms: perPhase(r.gap_to_leader),
  }));

const detailOf = (type: string, name: string, results: SessionDetail['results']) =>
  sessionDetail(
    type,
    name,
    results.map((r): [number, string] => [r.driver_number, `D${r.driver_number}`]),
    results,
  );
const render = (detail: SessionDetail, laps: Laps | null = null) =>
  renderToStaticMarkup(<ResultTable detail={detail} laps={laps} />);
/** The acronyms in row order. */
const order = (html: string) => [...html.matchAll(/<th scope="row"[^>]*>(\w+)<\/th>/g)].map(([, a]) => a);
/** One driver's cells after the Pos cell: [team, laps, …times, status]; [0] is Pos. */
const cells = (html: string, acronym: string) => {
  const tr = new RegExp(
    `<tr><td>((?:(?!</tr>)[\\s\\S])*?)</td><th scope="row"[^>]*>${acronym}</th>([\\s\\S]*?)</tr>`,
  ).exec(html);
  return [tr?.[1] ?? '', ...[...(tr?.[2] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, b]) => b ?? '')];
};
/** A cell's text without its note's popover. */
const text = (cell: string | undefined) =>
  (cell ?? '').replace(/<div popover[\s\S]*?<\/div>/g, '').replace(/<[^>]*>/g, '');
const reason = (cell: string | undefined) => /<div popover[^>]*>([^<]*)<\/div>/.exec(cell ?? '')?.[1];

describe('the Result tab: a race (session_result-normal, 11388)', () => {
  const html = render(detailOf('Race', 'Race', fixture('normal')));

  it('lists the classification, then the unclassified by laps', () => {
    const rows = order(html);
    expect(rows).toHaveLength(22);
    expect(rows.slice(0, 3)).toEqual(['D3', 'D16', 'D12']);
    expect(rows.slice(-3)).toEqual(['D18', 'D43', 'D5']);
  });

  it("shows the winner's race time, then the gaps, and +n laps for a lapped gap", () => {
    expect(cells(html, 'D3').map(text)).toEqual(['1', '', '62', '1:42:00.785', '']);
    expect(text(cells(html, 'D16')[3])).toBe('+7.335');
    expect(text(cells(html, 'D10')[3])).toBe('+1 lap');
    expect(text(cells(html, 'D11')[3])).toBe('+2 laps');
    expect(text(cells(html, 'D77')[3])).toBe('+3 laps');
  });

  it('keeps a classified DNF in place with its laps behind, and words the status', () => {
    expect(cells(html, 'D23').map(text)).toEqual(['18', '', '59', '+3 laps', 'DNF']);
  });

  it('gives a null position — with its reason', () => {
    const d18 = cells(html, 'D18');
    expect(text(d18[0])).toBe('—');
    expect(reason(d18[0])).toBe('No position in the OpenF1 data');
    expect(text(d18[4])).toBe('DNF');
    expect(html.match(/No position in the OpenF1 data<\/div>/g)).toHaveLength(3);
  });

  it('says the official order includes time penalties, and has no Q columns', () => {
    expect(html).toContain(
      '<p class="muted">The official order includes time penalties; the gap chart&#x27;s line crossings do not.</p>',
    );
    expect(html).toContain('<th scope="col">Time / gap</th><th scope="col">Status</th>');
    expect(html).not.toContain('>Q1<');
  });

  it('gives every note a unique id', () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the Result tab: a sprint (session_result-sprint, 11383)', () => {
  const html = render(detailOf('Race', 'Sprint', fixture('sprint')));

  it('shows a time under an hour as minutes, and the retirements', () => {
    expect(text(cells(html, 'D3')[3])).toBe('39:48.162');
    expect(cells(html, 'D81').map(text)).toEqual(['14', '', '19', '+1 lap', 'DNF']);
    expect(cells(html, 'D18').map(text)).toEqual(['—', '', '0', '+20 laps', 'DNF']);
  });
});

describe('the Result tab: qualifying (session_result-quali, 11392)', () => {
  const results = fixture('quali');
  const detail = detailOf('Qualifying', 'Qualifying', results);
  // Car 12's Q1 and Q2 times have a lap (Q2 within 1 ms); its Q3 time has none.
  const laps = [lap(12, 3, { lap_ms: 95_390 }), lap(12, 9, { lap_ms: 94_279 }), lap(3, 4, { lap_ms: 95_215 })];
  const html = render(detail, laps);

  it('shows Q1–Q3 from the official times with their gaps, and no caption', () => {
    expect(html).toContain(
      '<th scope="col">Laps</th><th scope="col">Q1</th><th scope="col">Q2</th><th scope="col">Q3</th>',
    );
    expect(html).not.toContain('Time / gap');
    expect(html).not.toContain('time penalties');
    const [q1, q2, q3] = cells(html, 'D12').slice(3);
    expect(q1).toContain('1:35.390');
    expect(q1).toContain('<small class="margin">+0.361</small>');
    expect(q2).toContain('<small class="margin">+0.080</small>');
    expect(q3).toContain('1:34.035');
    expect(q3).toContain('<small class="margin">fastest</small>');
  });

  it('gives a missing Q time — with its reason', () => {
    const q3 = cells(html, 'D30')[5];
    expect(text(q3)).toBe('—');
    expect(reason(q3)).toBe('No Q3 time in the OpenF1 data');
  });

  it('marks an official time without a lap row, once the laps are known', () => {
    const [q1, q2, q3] = cells(html, 'D12').slice(3);
    expect(q1).not.toContain('NO LAP');
    expect(q2).not.toContain('NO LAP');
    expect(q3).toContain('<span class="badge">NO LAP</span>');
    expect(reason(q3)).toBe('Official time, no lap in the data');
    const times = results.flatMap((r) => r.durations_ms?.filter((t) => t !== null) ?? []).length;
    // No laps at all (9900): every official time; laps still loading: none.
    expect(render(detail, []).match(/>NO LAP</g)).toHaveLength(times);
    expect(render(detail, null)).not.toContain('NO LAP');
  });

  it('never marks NO LAP on a Jolpica session, which has no lap rows by design', () => {
    const jolpica = { ...detail, session: { ...detail.session, source: 'jolpica' } } as SessionDetail;
    expect(render(jolpica, [])).not.toContain('NO LAP');
  });

  it('gives every note a unique id', () => {
    const ids = [...render(detail, []).matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(ids.length).toBeGreaterThan(60);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the phases SQ1–SQ3 in a sprint qualifying', () => {
    expect(render(detailOf('Qualifying', 'Sprint Qualifying', results))).toContain(
      '<th scope="col">SQ1</th><th scope="col">SQ2</th><th scope="col">SQ3</th>',
    );
  });
});

describe('fmtDuration', () => {
  it('is a lap time below an hour and h:mm:ss.SSS from it', () => {
    expect(fmtDuration(3_599_999)).toBe('59:59.999');
    expect(fmtDuration(3_600_000)).toBe('1:00:00.000');
    expect(fmtDuration(6_120_785)).toBe('1:42:00.785');
  });
});

describe('the Result tab: the words and the reasons', () => {
  it('words DNS and DSQ, DSQ first', () => {
    const rows = [{ ...result(1, null), dns: true }, { ...result(2, null), dsq: true, dnf: true }, result(3, 1)];
    const html = render(detailOf('Race', 'Race', rows));
    expect(text(cells(html, 'D1').at(-1))).toBe('DNS');
    expect(text(cells(html, 'D2').at(-1))).toBe('DSQ');
    expect(text(cells(html, 'D3').at(-1))).toBe('');
  });

  it('gives no "+n laps" to a DNS or DSQ, only to a DNF', () => {
    const rows = [
      { ...result(1, 1), laps: 62, durations_ms: [6_120_785], gaps_ms: [0] },
      { ...result(2, null), laps: 0, dns: true },
      { ...result(3, null), laps: 40, dsq: true },
      { ...result(4, null), laps: 40, dnf: true },
    ];
    const html = render(detailOf('Race', 'Race', rows));
    expect(text(cells(html, 'D2')[3])).toBe('—');
    expect(reason(cells(html, 'D2')[3])).toBe('No gap in the OpenF1 data');
    expect(html).not.toContain('+62 laps');
    expect(reason(cells(html, 'D3')[3])).toBe('No gap in the OpenF1 data');
    expect(text(cells(html, 'D4')[3])).toBe('+22 laps');
  });

  it('gives a winner without a time — with its reason, never +0.000', () => {
    const html = render(detailOf('Race', 'Race', [{ ...result(1, 1), laps: 62, gaps_ms: [0] }]));
    expect(text(cells(html, 'D1')[3])).toBe('—');
    expect(reason(cells(html, 'D1')[3])).toBe('No gap in the OpenF1 data');
    expect(html).not.toContain('+0.000');
  });

  it('gives practice its best lap and gaps, and a missing lap count or gap its reason', () => {
    const rows = [
      { ...result(1, 1), laps: 30, durations_ms: [75_123], gaps_ms: [0] },
      { ...result(2, 2), laps: null, durations_ms: [75_500], gaps_ms: [377] },
      { ...result(3, 3), laps: 12 },
    ];
    const html = render(detailOf('Practice', 'Practice 1', rows));
    expect(text(cells(html, 'D1')[3])).toBe('1:15.123');
    expect(text(cells(html, 'D2')[3])).toBe('+0.377');
    expect(reason(cells(html, 'D2')[2])).toBe('No lap count in the OpenF1 data');
    // No "+n laps" outside a race.
    expect(reason(cells(html, 'D3')[3])).toBe('No gap in the OpenF1 data');
  });

  it("shows the team, and the driver cell's title is name · team", () => {
    const d = detailOf('Race', 'Race', [result(4, 1)]);
    const named = {
      ...d,
      drivers: [{ ...d.drivers[0], full_name: 'Lando Norris', team_name: 'McLaren' }],
    } as SessionDetail;
    const html = render(named);
    expect(html).toContain('title="Lando Norris · McLaren">D4</th><td class="team">McLaren</td>');
  });

  it('says why when there is no result', () => {
    const empty = renderToStaticMarkup(
      <ResultTab
        detail={sessionDetail('Race', 'Race')}
        laps={null}
        live={null}
        now={Date.parse('2026-11-14T00:00:00Z')}
      />,
    );
    expect(empty).toBe('<p>No results in the OpenF1 data.</p>');
  });
});
