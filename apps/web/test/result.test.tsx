import type { Laps, SessionDetail } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtGap } from '../src/lib/time.ts';
import { ResultTab, ResultTable } from '../src/views/Result.tsx';
import { resultFixture as fixture, lap, result, sessionDetail } from './laps.ts';

// The Result tab (#110) on the OpenF1 fixtures' shapes: the race 11388, the sprint 11383 and the qualifying 11392,
// read from the server's committed fixtures and stored as ingest stores them (`resultFixture` in laps.ts).

const detailOf = (type: string, name: string, results: SessionDetail['results']) =>
  sessionDetail(
    type,
    name,
    results.map((r): [number, string] => [r.driver_number, `D${r.driver_number}`]),
    results,
  );
const render = (detail: SessionDetail, laps: Laps | null = null) =>
  renderToStaticMarkup(<ResultTable detail={detail} laps={laps} />);
/** The whole tab, as the session page renders it (the standings query stays pending: nothing is fetched here). */
const renderTab = (detail: SessionDetail) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ResultTab detail={detail} laps={null} live={null} now={0} />
    </QueryClientProvider>,
  );
/** The acronyms in row order. */
const order = (html: string) => [...html.matchAll(/<th scope="row"[^>]*>(\w+)<\/th>/g)].map(([, a]) => a);
/** One driver's cells: [Pos, laps, …times, status]. */
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

  it("shows the winner's race time, then the gaps (+m:ss.SSS from a minute), and +n laps for a lapped gap", () => {
    expect(cells(html, 'D3').map(text)).toEqual(['1', '62', '1:42:00.785', '']);
    expect(text(cells(html, 'D16')[2])).toBe('+7.335');
    // From a minute up, as a lap time (owner, 2026-11-15).
    expect(text(cells(html, 'D30')[2])).toBe('+1:21.666');
    expect(text(cells(html, 'D10')[2])).toBe('+1 lap');
    expect(text(cells(html, 'D11')[2])).toBe('+2 laps');
    expect(text(cells(html, 'D77')[2])).toBe('+3 laps');
  });

  it('keeps a classified DNF in place with its laps behind, and words the status', () => {
    expect(cells(html, 'D23').map(text)).toEqual(['18', '59', '+3 laps', 'DNF']);
  });

  it('gives a null position — with its reason', () => {
    const d18 = cells(html, 'D18');
    expect(text(d18[0])).toBe('—');
    expect(reason(d18[0])).toBe('No position in the OpenF1 data');
    expect(text(d18[3])).toBe('DNF');
    expect(html.match(/No position in the OpenF1 data<\/div>/g)).toHaveLength(3);
  });

  it('says the official order includes time penalties, above the grid, and has no Q columns', () => {
    // Above the grid (#202): the three table tops line up, and the line never widens the classification's column.
    expect(renderTab(detailOf('Race', 'Race', fixture('normal')))).toContain(
      '<p class="muted">The official order includes time penalties; the gap chart&#x27;s line crossings do not.</p>' +
        '<div class="result-grid"><section><h2>Classification</h2><table class="result" aria-label="Result">',
    );
    expect(html).toContain('<th scope="col">Time / gap</th><th scope="col">Status</th>');
    expect(html).not.toContain('>Q1<');
  });

  it('gives every note a unique id', () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Owner, 2026-11-15, #202 D1: every row in the page, no scroll box, but in qualifying (Q1–Q3 do not fit 390 px).
describe('the Result tab: the scroll box', () => {
  it.each([
    ['a race', 'Race', 'Race', 'normal'],
    ['a sprint', 'Race', 'Sprint', 'sprint'],
    ['a practice', 'Practice', 'Practice 1', 'normal'],
  ])('has none in %s, and every row renders', (_, type, name, file) => {
    const rows = fixture(file);
    const html = render(detailOf(type, name, rows));
    expect(html).not.toContain('class="scroll"');
    expect(html).not.toContain('role="region"');
    expect(html).not.toContain('tabindex');
    expect(html.startsWith('<table class="result" aria-label="Result">')).toBe(true);
    expect(order(html)).toHaveLength(rows.length);
  });

  it.each(['Qualifying', 'Sprint Qualifying'])('keeps the named box in %s', (name) => {
    expect(render(detailOf('Qualifying', name, fixture('quali')))).toMatch(
      /^<div class="scroll" tabindex="0" role="region" aria-label="Result"><table class="result" aria-label="Result">/,
    );
  });
});

describe('the Result tab: a sprint (session_result-sprint, 11383)', () => {
  const html = render(detailOf('Race', 'Sprint', fixture('sprint')));

  it('shows a time under an hour as minutes, and the retirements', () => {
    expect(text(cells(html, 'D3')[2])).toBe('39:48.162');
    expect(cells(html, 'D81').map(text)).toEqual(['14', '19', '+1 lap', 'DNF']);
    expect(cells(html, 'D18').map(text)).toEqual(['—', '0', '+20 laps', 'DNF']);
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
    const [q1, q2, q3] = cells(html, 'D12').slice(2);
    expect(q1).toContain('1:35.390');
    expect(q1).toContain('<small class="margin">+0.361</small>');
    expect(q2).toContain('<small class="margin">+0.080</small>');
    expect(q3).toContain('1:34.035');
    expect(q3).toContain('<small class="margin">fastest</small>');
  });

  it('gives a missing Q time — with its reason', () => {
    const q3 = cells(html, 'D30')[4];
    expect(text(q3)).toBe('—');
    expect(reason(q3)).toBe('No Q3 time in the OpenF1 data');
  });

  it('marks an official time without a lap row, once the laps are known', () => {
    const [q1, q2, q3] = cells(html, 'D12').slice(2);
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

describe('fmtGap', () => {
  it('is signed seconds under a minute and +m:ss.SSS from it', () => {
    expect(fmtGap(7_335)).toBe('+7.335');
    expect(fmtGap(59_999)).toBe('+59.999');
    expect(fmtGap(60_000)).toBe('+1:00.000');
    expect(fmtGap(81_666)).toBe('+1:21.666');
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
    expect(text(cells(html, 'D2')[2])).toBe('—');
    expect(reason(cells(html, 'D2')[2])).toBe('No gap in the OpenF1 data');
    expect(html).not.toContain('+62 laps');
    expect(reason(cells(html, 'D3')[2])).toBe('No gap in the OpenF1 data');
    expect(text(cells(html, 'D4')[2])).toBe('+22 laps');
  });

  it('gives a winner without a time — with its reason, never +0.000', () => {
    const html = render(detailOf('Race', 'Race', [{ ...result(1, 1), laps: 62, gaps_ms: [0] }]));
    expect(text(cells(html, 'D1')[2])).toBe('—');
    expect(reason(cells(html, 'D1')[2])).toBe('No gap in the OpenF1 data');
    expect(html).not.toContain('+0.000');
  });

  it('gives practice its best lap and gaps, and a missing lap count or gap its reason', () => {
    const rows = [
      { ...result(1, 1), laps: 30, durations_ms: [75_123], gaps_ms: [0] },
      { ...result(2, 2), laps: null, durations_ms: [75_500], gaps_ms: [377] },
      { ...result(3, 3), laps: 12 },
    ];
    const html = render(detailOf('Practice', 'Practice 1', rows));
    expect(text(cells(html, 'D1')[2])).toBe('1:15.123');
    expect(text(cells(html, 'D2')[2])).toBe('+0.377');
    expect(reason(cells(html, 'D2')[1])).toBe('No lap count in the OpenF1 data');
    // No "+n laps" outside a race.
    expect(reason(cells(html, 'D3')[2])).toBe('No gap in the OpenF1 data');
  });

  it("shows the team as a line under the driver, with no Team column, and the driver cell's title is name · team", () => {
    const d = detailOf('Race', 'Race', [result(4, 1)]);
    const named = {
      ...d,
      drivers: [{ ...d.drivers[0], full_name: 'Lando Norris', team_name: 'McLaren' }],
    } as SessionDetail;
    const html = render(named);
    // Owner, 2026-11-15, #202 D2: on every session type, as the standings tables do.
    expect(html).toContain('title="Lando Norris · McLaren">D4<small class="margin">McLaren</small></th><td>');
    expect(html).not.toContain('>Team<');
    expect(html).not.toContain('class="team"');
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
