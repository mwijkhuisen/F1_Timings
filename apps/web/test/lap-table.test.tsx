import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Lap, Laps, SessionDetail } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { teamColour } from '../src/lib/session.ts';
import type { Period } from '../src/lib/track.ts';
import { LapGrid, LapTable, Legend, type Metric, missingReason, type Show } from '../src/views/LapTable.tsx';
import { rc } from './laps.ts';

// D10's cell rules on a hand-built race: 2 drivers × 3 laps, rendered statically (D4).

type C = Lap['colour']['lap'];
const lap = (driver_number: number, lap_number: number, times: [number | null, C][], extra: Partial<Lap> = {}): Lap => {
  const [
    [lap_ms, lc] = [null, null],
    [s1_ms, c1] = [null, null],
    [s2_ms, c2] = [null, null],
    [s3_ms, c3] = [null, null],
  ] = times;
  return {
    driver_number,
    lap_number,
    date_start: null,
    lap_ms,
    s1_ms,
    s2_ms,
    s3_ms,
    i1_kph: null,
    i2_kph: null,
    st_kph: null,
    is_pit_out: false,
    is_pit_in: false,
    seg1: null,
    seg2: null,
    seg3: null,
    deleted: false,
    deleted_reason: null,
    quali_phase: null,
    compound: 'SOFT',
    colour: { lap: lc, s1: c1, s2: c2, s3: c3 },
    ...extra,
  };
};

// [lap, S1, S2, S3] as [ms, colour].
const laps = Laps.parse([
  // Driver 1 comes first in the list but has no position: it sorts after 44.
  lap(1, 1, [
    [85000, 'green'],
    [28300, 'green'],
    [30500, 'yellow'],
    [25100, 'purple'],
  ]),
  lap(
    1,
    2,
    [
      [83000, 'yellow'],
      [28000, 'yellow'],
      [29800, 'yellow'],
      [25200, 'yellow'],
    ],
    { deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 16', is_pit_in: true },
  ),
  lap(
    1,
    3,
    [
      [92000, 'yellow'],
      [null, null],
      [31000, 'yellow'],
      [26000, 'yellow'],
    ],
    { is_pit_out: true, compound: 'MEDIUM' },
  ),
  lap(44, 1, [
    [null, null],
    [null, null],
    [30000, 'green'],
    [25000, 'green'],
  ]),
  lap(44, 2, [
    [83456, 'purple'],
    [28100, 'purple'],
    [29900, 'purple'],
    [25456, 'yellow'],
  ]),
  lap(
    44,
    3,
    [
      [90000, 'yellow'],
      [28500, 'yellow'],
      [31000, 'yellow'],
      [null, null],
    ],
    { is_pit_in: true },
  ),
]);

const iso = '2026-10-11T12:00:00.000Z';
const driver = (driver_number: number, acronym: string, team_colour: string) => ({
  driver_number,
  acronym,
  full_name: null,
  team_name: null,
  team_colour,
});
const result = (driver_number: number, position: number | null) => ({
  driver_number,
  position,
  laps: null,
  dnf: null,
  dns: null,
  dsq: null,
  durations_ms: null,
  gaps_ms: null,
});
const detail = SessionDetail.parse({
  session: {
    session_key: 9965,
    type: 'Race',
    name: 'Race',
    date_start: iso,
    date_end: iso,
    ingest_state: 'final',
    is_cancelled: false,
    meeting_key: 1290,
  },
  meeting: {
    meeting_key: 1290,
    name: 'Singapore Grand Prix',
    official_name: null,
    location: null,
    country_code: null,
    circuit_short_name: null,
    gmt_offset: null,
    date_start: null,
    date_end: null,
    is_cancelled: false,
    year: 2026,
  },
  // 63 has a result but no laps: it is left out.
  drivers: [driver(1, 'NOR', 'not-hex'), driver(44, 'HAM', 'E80020'), driver(63, 'RUS', '00D7B6')],
  results: [result(1, null), result(44, 1), result(63, 2)],
});

type Cell = { cls: string[]; title: string | null; body: string };
const allCells = (html: string): Cell[] =>
  [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attrs = '', body = '']) => ({
    cls: /class="([^"]*)"/.exec(attrs)?.[1]?.split(' ') ?? [],
    title: /title="([^"]*)"/.exec(attrs)?.[1] ?? null,
    body,
  }));
/** The lap cells, without the Best column. */
const cells = (html: string): Cell[] => allCells(html).filter((c) => !c.cls.includes('best'));
const grid = (metric: Metric, columns = false, show: Show = 'times', periods: Period[] = [], rows: Laps = laps) =>
  renderToStaticMarkup(
    <LapGrid detail={detail} laps={rows} metric={metric} columns={columns} show={show} periods={periods} />,
  );
const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
/** The declarations of the rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};
const colourOf = (c: Cell) => c.cls.find((n) => n.startsWith('t-'))?.slice(2) ?? null;

// Rows mode: HAM laps 1–3, then NOR laps 1–3. The server's colour per cell; only purple and green are drawn.
const COLOURS: Record<Metric, (string | null)[]> = {
  lap: [null, 'purple', 'yellow', 'green', 'yellow', 'yellow'],
  s1: [null, 'purple', 'yellow', 'green', 'yellow', null],
  s2: ['green', 'purple', 'yellow', 'yellow', 'yellow', 'yellow'],
  s3: ['green', 'yellow', null, 'purple', 'yellow', 'yellow'],
};
const TITLES = { purple: 'overall best', green: 'personal best', yellow: 'slower than personal best' };
// HAM 3 (in), NOR 2 (deleted, in) and NOR 3 (out) are not ranked: the server colours them yellow, with no title.
const UNRANKED = new Set([2, 4, 5]);

describe('the lap grid', () => {
  it.each(Object.entries(COLOURS))('colours %s by its own colour field, "other" as plain text', (metric, colours) => {
    const got = cells(grid(metric as Metric));
    expect(got.map(colourOf)).toEqual(colours.map((c) => (c === 'yellow' ? null : c)));
    got.forEach((c, i) => {
      const colour = colours[i] as keyof typeof TITLES | null;
      const ranked = colour !== null && !UNRANKED.has(i);
      expect(c.title, `cell ${i}`).toBe(ranked ? TITLES[colour] : null);
      // A screen reader hears the words only on a ranked purple or green value.
      const words = [...c.body.matchAll(/<span class="vh">, ([\w ]+)<\/span>/g)].map(([, w]) => w);
      expect(words, `cell ${i}`).toEqual(ranked && colour !== 'yellow' ? [TITLES[colour]] : []);
    });
  });

  it('leaves "other" values plain: no class, no colour', () => {
    for (const metric of ['lap', 's1', 's2', 's3'] as const) {
      const html = grid(metric);
      expect(html).not.toContain('t-yellow');
      cells(html).forEach((c, i) => {
        if (COLOURS[metric][i] === 'yellow')
          expect(
            c.cls.filter((n) => n.startsWith('t-')),
            `cell ${i}`,
          ).toEqual([]);
      });
    }
  });

  it('formats lap and sector times', () => {
    expect(cells(grid('lap'))[1]?.body).toContain('1:23.456');
    expect(cells(grid('s1'))[1]?.body).toContain('28.100');
  });

  it('strikes a deleted lap in every metric, with the reason in the title and the popover', () => {
    for (const metric of ['lap', 's1', 's2', 's3'] as const) {
      const nor2 = cells(grid(metric))[4];
      expect(nor2?.cls).toContain('deleted');
      expect(nor2?.body).toMatch(/<s>[^<]+<\/s>/);
      expect(nor2?.body).toContain(`title="Deleted: TRACK LIMITS AT TURN 16"`);
      expect(nor2?.body).toMatch(
        new RegExp(`<div popover="auto" id="n-1-2-${metric}"[^>]*>Deleted: TRACK LIMITS AT TURN 16</div>`),
      );
      expect(nor2?.body).toContain(`popoverTarget="n-1-2-${metric}" aria-describedby="n-1-2-${metric}"`);
    }
    expect(cells(grid('lap')).filter((c) => c.cls.includes('deleted'))).toHaveLength(1);
  });

  it('shows — with its reason for a null value', () => {
    const reason = (metric: Metric, i: number) => {
      const c = cells(grid(metric))[i];
      expect(c?.body).toMatch(/>—</);
      return /<div popover[^>]*>([^<]*)<\/div>/.exec(c?.body ?? '')?.[1];
    };
    expect(reason('lap', 0)).toBe('Lap 1 from the grid: no time in the OpenF1 data');
    expect(reason('s3', 2)).toBe('In-lap: no time in the OpenF1 data');
    expect(reason('s1', 5)).toBe('Out-lap: no time in the OpenF1 data');
    // A cell with a value has no note.
    expect(cells(grid('lap'))[1]?.body).not.toContain('popover');
  });

  it('gives every note a unique id', () => {
    const ids = [...grid('s1').matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(ids).toEqual(['n-44-1-s1', 'n-1-2-s1', 'n-1-3-s1']);
  });

  it('dims in- and out-laps, badges IN, and OUT only without a compound dot', () => {
    const got = cells(grid('lap'));
    const badges = got.map((c) => [...c.body.matchAll(/class="badge">(\w+)</g)].map(([, b]) => b));
    // NOR 3 is an out-lap on a new set: its medium dot says so, so no OUT.
    expect(badges).toEqual([[], [], ['IN'], [], ['IN'], []]);
    expect(got.map((c) => c.cls.includes('io'))).toEqual([false, false, true, false, true, true]);
    // An out-lap with an unknown compound has no dot, so it gets OUT.
    const out = cells(
      grid('lap', false, 'times', [], [lap(44, 1, [[90000, null]], { is_pit_out: true, compound: null })]),
    );
    expect(out[0]?.body).toContain('<span class="badge">OUT</span>');
  });

  it("rules a new run after the driver's first lap", () => {
    expect(cells(grid('lap')).map((c) => c.cls.includes('stint'))).toEqual([false, false, false, false, false, true]);
  });

  it('puts the compound dot only at the start of a run', () => {
    // The dot is hidden from a screen reader, which hears the compound's words instead.
    const dots = cells(grid('lap')).map((c) =>
      /<span class="cmp (cmp-\w+)" title="(\w+)" aria-hidden="true">(\w)<\/span><span class="vh">([\w ,]+)<\/span>/
        .exec(c.body)
        ?.slice(1),
    );
    expect(dots).toEqual([
      ['cmp-soft', 'SOFT', 'S', 'soft tyres, '],
      undefined,
      undefined,
      ['cmp-soft', 'SOFT', 'S', 'soft tyres, '],
      undefined,
      ['cmp-medium', 'MEDIUM', 'M', 'medium tyres, '],
    ]);
  });

  it('orders drivers by position, nulls last, and leaves out drivers without laps', () => {
    const html = grid('lap');
    expect([...html.matchAll(/<th scope="row"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['HAM', 'NOR']);
    expect(html).not.toContain('RUS');
    // Rows mode: the header row is the lap numbers.
    expect([...html.matchAll(/<th scope="col">(\w+)</g)].map(([, a]) => a)).toEqual(['Driver', '1', '2', '3']);
  });

  it('sets the team colour only from six hex digits', () => {
    const html = grid('lap');
    // #E80020 already reaches 3:1 on white, so its light copy is the same.
    expect(html).toMatch(/<th scope="row" class="drv" style="--team:#E80020;--team-l:#E80020"[^>]*>HAM</);
    expect(html).toMatch(/<th scope="row" class="drv">NOR</);
  });

  it('puts drivers in columns and laps in rows when switched', () => {
    const html = grid('lap', true);
    expect([...html.matchAll(/<th scope="col"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['Lap', 'HAM', 'NOR']);
    expect([...html.matchAll(/<th scope="row">(\d+)</g)].map(([, n]) => n)).toEqual(['1', '2', '3']);
    // Lap 1 of HAM and NOR, then lap 2, then lap 3.
    expect(cells(html).map(colourOf)).toEqual([null, 'green', 'purple', null, null, null]);
    expect(html).toContain(
      '<div class="scroll" tabindex="0" role="region" aria-label="Lap times"><table class="laps cols"',
    );
    expect(grid('s2')).toContain('aria-label="S2 times"><table class="laps" aria-label="S2 times">');
  });

  it('starts on the lap time, drivers as rows, and says when there are no laps', () => {
    const html = renderToStaticMarkup(<LapTable detail={detail} laps={laps} />);
    expect(html).toMatch(/<button type="button" aria-pressed="true">Lap<\/button>/);
    expect(html).toMatch(/aria-pressed="false">Drivers as columns</);
    expect(html).toContain(
      '<div class="scroll" tabindex="0" role="region" aria-label="Lap times"><table class="laps" aria-label="Lap times">',
    );
    // The non-colour cues are explained next to the switches (styles.css boxes purple and bolds green); "other" is plain.
    expect(html).toContain(
      '<ul class="legend" aria-label="Legend"><li><span class="t-purple">overall best</span></li><li><span class="t-green">personal best</span></li><li>other</li><li><span class="io">in-lap</span><span class="badge">IN</span></li><li><span class="cmp cmp-hard" aria-hidden="true">H</span>new stint</li><li><s>deleted</s></li></ul>',
    );
    expect(html).toMatch(
      /aria-pressed="true">Times<\/button><button type="button" aria-pressed="false">Δ to own best</,
    );
    expect(renderToStaticMarkup(<LapTable detail={detail} laps={[]} />)).toBe('<p>No laps yet.</p>');
  });
});

describe('the P4b cues', () => {
  it('boxes and tints purple, bolds green and leaves other plain', () => {
    const got = cells(grid('lap'));
    expect(got[1]?.cls).toContain('t-purple');
    expect(got[3]?.cls).toContain('t-green');
    expect(got[0]?.cls.filter((n) => n.startsWith('t-'))).toEqual([]);
    const purple = rule('.t-purple');
    expect(purple).toContain('color: var(--purple);');
    expect(purple).toContain('background: var(--purple-wash);');
    expect(purple).toContain('outline: 2px solid currentColor;');
    expect(purple).toContain('outline-offset: -2px;');
    expect(rule('.t-green')).toContain('font-weight: 700;');
  });

  it('freezes the driver and their own best in rows mode', () => {
    const html = grid('lap');
    expect(html).toContain('<th scope="col">Driver</th><th scope="col" class="best">Best</th>');
    // The own best right after the driver, in the server colour, with its lap.
    expect(html).toMatch(
      /HAM<\/th><td class="best" title="Lap 2"><span class="t-purple">1:23.456<\/span><small>L2<\/small><\/td>/,
    );
    expect(html).toMatch(
      /NOR<\/th><td class="best" title="Lap 1"><span class="t-green">1:25.000<\/span><small>L1<\/small><\/td>/,
    );
    // Sticky right of a fixed-width driver column.
    const width = /\bwidth: (\d+px);/.exec(rule('.laps:not(.cols) tbody th'))?.[1];
    expect(rule('.laps:not(.cols) tbody th')).toContain(`min-width: ${width};`);
    const best = rule('.laps:not(.cols) .best');
    expect(best).toContain('position: sticky;');
    expect(best).toContain(`left: ${width};`);
    expect(best).toContain('background: var(--bg);');
  });

  it('shows — with a reason when a driver has no valid value', () => {
    const outOnly = [lap(44, 1, [[90000, null]], { is_pit_out: true })];
    const html = grid('lap', false, 'times', [], outOnly);
    expect(html).toMatch(/<td class="best"><button[^>]*popoverTarget="nb-44-lap"[^>]*>—<\/button>/);
    expect(html).toContain('>No valid lap time</div>');
    expect(grid('s1', false, 'times', [], outOnly)).toContain('>No valid S1 time</div>');
  });

  it('puts the Best row in the sticky thead in columns mode', () => {
    const html = grid('lap', true);
    const thead = /<thead>([\s\S]*)<\/thead>/.exec(html)?.[1] ?? '';
    expect(thead).toMatch(
      /<tr><th scope="row" class="best">Best<\/th><td class="best" title="Lap 2"><span class="t-purple">1:23.456<\/span><small>L2<\/small><\/td><td class="best" title="Lap 1">/,
    );
    expect(rule('.laps.cols thead')).toContain('position: sticky;');
    expect(css).toMatch(/\.scroll:has\(\.laps\.cols\) \{\s*scroll-padding-top: 88px;/);
  });

  it('bands VSC, SC and red-flag laps in the header, the most severe first', () => {
    const vsc = grid('lap', false, 'times', [{ kind: 'vsc', from: 2, to: 2 }]);
    expect(vsc).toContain('<th scope="col" class="band band-vsc" title="Virtual safety car">2<small> VSC</small></th>');
    expect(vsc).toContain('<th scope="col">3</th>');
    const red = grid('lap', false, 'times', [{ kind: 'red', from: 3, to: 3 }]);
    expect(red).toContain('<th scope="col" class="band band-red" title="Red flag">3<small> RED</small></th>');
    const both: Period[] = [
      { kind: 'vsc', from: 1, to: 2 },
      { kind: 'sc', from: 2, to: 3 },
    ];
    expect(grid('lap', false, 'times', both)).toContain(
      '<th scope="col" class="band band-sc" title="Safety car, virtual safety car">2<small> SC</small></th>',
    );
    // Columns mode bands the lap row headers.
    expect(grid('lap', true, 'times', both)).toContain(
      '<th scope="row" class="band band-vsc" title="Virtual safety car">1<small> VSC</small></th>',
    );
    expect(rule('.band')).toContain('border-bottom: 3px solid var(--band);');
  });
});

describe('Δ to own best', () => {
  // Own best 40.000 s; the steps are < 0.5 %, < 1 %, < 2 % and ≥ 2 % (owner D3).
  const run = [
    lap(44, 1, [[40000, 'purple']]),
    lap(44, 2, [[40410, 'yellow']]),
    lap(44, 3, [[40150, 'yellow']]),
    lap(44, 4, [[41000, 'yellow']]),
    lap(44, 5, [[50000, 'yellow']]),
  ];

  it('shows the gap with its step, and best in the server colour', () => {
    const html = grid('lap', false, 'delta', [{ kind: 'vsc', from: 5, to: 5 }], run);
    const got = cells(html);
    expect(got.map((c) => c.body.replace(/<span class="cmp[\s\S]*?tyres, <\/span>/, ''))).toEqual([
      'best<span class="vh">, overall best</span>',
      '+0.41',
      '+0.15',
      '+1.00',
      '<span class="muted">VSC</span>',
    ]);
    expect(got.map((c) => c.cls.filter((n) => n.startsWith('heat-') || n.startsWith('t-')))).toEqual([
      ['t-purple'],
      ['heat-2'],
      [],
      ['heat-3'],
      [],
    ]);
    expect(html).toContain('aria-label="Lap Δ to own best"><table class="laps" aria-label="Lap Δ to own best">');
  });

  it('says deleted, in or out instead, and keeps the reasons', () => {
    const got = cells(grid('lap', false, 'delta'));
    // HAM 1 (no time), HAM 2 (best), HAM 3 (in), NOR 1 (best), NOR 2 (deleted), NOR 3 (out).
    expect(got[0]?.body).toContain('>Lap 1 from the grid: no time in the OpenF1 data</div>');
    expect(got[1]?.body).toContain('best');
    expect(got[2]?.body).toContain('<span class="muted">in</span>');
    expect(got[3]?.cls).toContain('t-green');
    expect(got[4]?.body).toContain('<span class="muted">deleted</span>');
    expect(got[4]?.body).toContain('>Deleted: TRACK LIMITS AT TURN 16</div>');
    expect(got[5]?.body).toContain('<span class="muted">out</span>');
    expect(got.some((c) => c.body.includes('badge'))).toBe(false);
  });

  it('has a legend of the steps', () => {
    expect(renderToStaticMarkup(<Legend show="delta" periods={[]} />)).toBe(
      '<ul class="legend" aria-label="Legend"><li><span class="sw" aria-hidden="true"></span>&lt; 0.5 %</li><li><span class="sw heat-1" aria-hidden="true"></span>&lt; 1 %</li><li><span class="sw heat-2" aria-hidden="true"></span>&lt; 2 %</li><li><span class="sw heat-3" aria-hidden="true"></span>≥ 2 % slower than own best</li></ul>',
    );
  });
});

describe('the legend and the unplaced rows', () => {
  it('lists the bands only when there are periods', () => {
    const vsc = renderToStaticMarkup(<Legend show="times" periods={[{ kind: 'vsc', from: 1, to: 2 }]} />);
    expect(vsc).toContain('<li><span class="band band-sc">SC / VSC lap</span></li>');
    expect(vsc).not.toContain('red-flag');
    const red = renderToStaticMarkup(<Legend show="times" periods={[{ kind: 'red', from: 1, to: 2 }]} />);
    expect(red).toContain('<li><span class="band band-red">red-flag lap</span></li>');
    expect(red).not.toContain('SC / VSC');
  });

  it('lists race-control rows without a lap number as text', () => {
    const unplaced = [rc(null, 'SAFETY CAR DEPLOYED <b>', { date: '2026-10-11T12:34:56.000Z' })];
    const html = renderToStaticMarkup(<LapTable detail={detail} laps={laps} track={{ periods: [], unplaced }} />);
    expect(html).toContain(
      '<div class="muted"><p>No lap number in the data, not banded:</p><ul><li>14:34:56 SAFETY CAR DEPLOYED &lt;b&gt;</li></ul></div>',
    );
  });
});

describe('missingReason', () => {
  const at = (lap_number: number, is_pit_out: boolean | null, is_pit_in: boolean) => ({
    lap_number,
    is_pit_out,
    is_pit_in,
  });

  it.each([
    // Out-laps lack S1; lap 1 out of the garage also lacks its lap time.
    [at(5, true, false), 's1', 'Practice', 'Out-lap: no time in the OpenF1 data'],
    [at(1, true, false), 'lap', 'Qualifying', 'Out-lap: no time in the OpenF1 data'],
    [at(1, true, false), 'lap', 'Race', 'Out-lap: no time in the OpenF1 data'],
    [at(5, true, false), 'lap', 'Practice', 'No time in the OpenF1 data'],
    [at(5, true, false), 's3', 'Practice', 'No time in the OpenF1 data'],
    // In-laps, any metric.
    [at(9, false, true), 's3', 'Qualifying', 'In-lap: no time in the OpenF1 data'],
    [at(9, null, true), 'lap', 'Race', 'In-lap: no time in the OpenF1 data'],
    // Lap 1 of a race or sprint from the grid; not elsewhere.
    [at(1, false, false), 's2', 'Race', 'Lap 1 from the grid: no time in the OpenF1 data'],
    [at(1, null, false), 'lap', 'Race', 'Lap 1 from the grid: no time in the OpenF1 data'],
    [at(1, true, false), 's3', 'Race', 'No time in the OpenF1 data'],
    [at(1, false, false), 'lap', 'Practice', 'No time in the OpenF1 data'],
    [at(2, false, false), 'lap', 'Race', 'No time in the OpenF1 data'],
    [at(2, false, false), 's1', null, 'No time in the OpenF1 data'],
  ] as const)('%o %s in a %s: %s', (l, metric, type, reason) => {
    expect(missingReason(l, metric, type)).toBe(reason);
  });
});

describe('teamColour', () => {
  it.each([
    ['E80020', '#E80020'],
    ['00d7b6', '#00d7b6'],
    ['#E80020', null],
    ['E8002', null],
    ['E800200', null],
    ['E80020;color:red', null],
    ['url(x)', null],
    ['', null],
    [null, null],
  ])('%s → %s', (colour, css) => {
    expect(teamColour(colour)).toBe(css);
  });
});
