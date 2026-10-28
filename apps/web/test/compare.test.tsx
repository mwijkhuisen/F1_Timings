import type { Lap } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Driver } from '../src/lib/session.ts';
import { fmtDelta } from '../src/lib/time.ts';
import { Compare } from '../src/views/Compare.tsx';
import { DeltaTable } from '../src/views/DeltaTable.tsx';
import { DriverPicker } from '../src/views/DriverPicker.tsx';
import { lapChartOption } from '../src/views/lap-chart-option.ts';

// The comparison (E1–E4, D2, D4, D5) on hand-built laps, rendered statically (A§15).

type C = Lap['colour']['lap'];
const lap = (
  driver_number: number,
  lap_number: number,
  lap_ms: number | null,
  [s1_ms, s2_ms, s3_ms]: (number | null)[],
  colour: C,
  extra: Partial<Lap> = {},
): Lap => ({
  driver_number,
  lap_number,
  date_start: null,
  lap_ms,
  s1_ms: s1_ms ?? null,
  s2_ms: s2_ms ?? null,
  s3_ms: s3_ms ?? null,
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
  colour: { lap: colour, s1: null, s2: null, s3: null },
  ...extra,
});

const driver = (number: number, acronym: string, team: string | null): Driver => ({
  number,
  acronym,
  name: null,
  team,
});
const VER = driver(1, 'VER', '#3671C6');
const PER = driver(11, 'PER', '#3671C6');
const NOR = driver(4, 'NOR', '#FF8000');

const laps = [
  // VER: an out-lap, the best lap 2, lap 3 without a time, lap 4 deleted, no lap 5.
  lap(1, 1, 100000, [40000, 31000, 29000], 'yellow', { is_pit_out: true }),
  lap(1, 2, 80500, [28000, 30000, 22500], 'purple'),
  lap(1, 3, null, [28200, null, 22600], null),
  lap(1, 4, 80000, [27900, 29800, 22300], 'yellow', { deleted: true }),
  // NOR: lap 3 deleted, lap 5 the best.
  lap(4, 1, 95000, [35000, 31000, 29000], 'yellow'),
  lap(4, 2, 81000, [28100, null, 22400], 'yellow'),
  lap(4, 3, 81200, [28000, 30000, 22500], 'yellow', { deleted: true }),
  lap(4, 4, 82000, [28300, 30200, 22600], 'yellow'),
  lap(4, 5, 80900, [28050, 30150, 22700], 'green'),
  // PER: one lap.
  lap(11, 2, 81500, [28300, 30300, 22900], 'green'),
];
const tokens = { fg: '#f0f0f5', muted: '#9b9ba8', line: '#34343f', bg: '#15151e' };

describe('lapChartOption', () => {
  const option = lapChartOption([VER, NOR, PER], laps, tokens);
  const series = (acronym: string) => option.series.find((s) => s.name === acronym);

  it('plots every lap on a category axis, with null for a missing lap or a lap without a time', () => {
    expect(option.xAxis).toMatchObject({ type: 'category', data: [1, 2, 3, 4, 5] });
    expect(series('VER')?.data).toEqual([
      100000,
      80500,
      null,
      { value: 80000, symbol: 'emptyCircle', symbolSize: 8 },
      null,
    ]);
    expect(series('PER')?.data).toEqual([null, 81500, null, null, null]);
    for (const s of option.series) expect(s).toMatchObject({ connectNulls: false, clip: true, symbol: 'circle' });
  });

  it('marks a deleted lap with a hollow symbol', () => {
    expect(series('VER')?.data[3]).toEqual({ value: 80000, symbol: 'emptyCircle', symbolSize: 8 });
    expect(series('NOR')?.data[2]).toEqual({ value: 81200, symbol: 'emptyCircle', symbolSize: 8 });
  });

  it('windows the y-axis from the best valid lap − 1 s to 107 %, in whole seconds', () => {
    // Best valid lap: VER lap 2, 80.5 s (the deleted 80.0 s does not count); 80.5 × 1.07 = 86.135.
    expect(option.yAxis).toMatchObject({ min: 79000, max: 87000 });
    // Without a purple or green lap the axis scales by itself.
    const auto = lapChartOption([VER], [laps[0] as Lap], tokens).yAxis;
    expect(auto).not.toHaveProperty('min');
    expect(auto).not.toHaveProperty('max');
  });

  it('colours a line by its team and dashes a teammate', () => {
    expect(option.series.map((s) => [s.name, s.color, s.lineStyle.type])).toEqual([
      ['VER', '#3671C6', 'solid'],
      ['NOR', '#FF8000', 'solid'],
      ['PER', '#3671C6', 'dashed'],
    ]);
    expect(lapChartOption([driver(9, 'XXX', null)], laps, tokens).series[0]?.color).toBe(tokens.muted);
  });

  it('cycles solid, dashed, dotted per repeated colour, drivers without a team colour included', () => {
    const plain = [1, 2, 3, 4].map((n) => driver(n, `D${n}`, null));
    expect(lapChartOption([...plain, NOR], laps, tokens).series.map((s) => [s.color, s.lineStyle.type])).toEqual([
      [tokens.muted, 'solid'],
      [tokens.muted, 'dashed'],
      [tokens.muted, 'dotted'],
      [tokens.muted, 'solid'],
      ['#FF8000', 'solid'],
    ]);
  });

  it('labels the y-axis in whole milliseconds, also on a fractional tick', () => {
    expect(option.yAxis.axisLabel.formatter(80499.6)).toBe('1:20.500');
    expect(option.yAxis.axisLabel.formatter(79000)).toBe('1:19.000');
  });

  it('uses a rich-text tooltip with a plain-text formatter, and no HTML anywhere', () => {
    expect(option.tooltip).toMatchObject({ trigger: 'axis', renderMode: 'richText', confine: true });
    expect(option.tooltip.formatter([{ dataIndex: 3 }])).toBe('Lap 4\nVER 1:20.000 deleted\nNOR 1:22.000\nPER —');
    expect(option.tooltip.formatter([{ dataIndex: 1 }])).toBe('Lap 2\nVER 1:20.500\nNOR 1:21.000\nPER 1:21.500');
    expect(JSON.stringify(option)).not.toMatch(/[<>]/);
  });

  it('strips rich-text markup {|} from data strings', () => {
    const odd = lapChartOption([driver(1, '{a|VER}', null)], laps, tokens);
    expect(odd.series[0]?.name).toBe('aVER');
    expect(odd.tooltip.formatter({ dataIndex: 1 })).toBe('Lap 2\naVER 1:20.500');
  });
});

describe('fmtDelta', () => {
  it.each([
    [123, '+0.123'],
    [-45, '−0.045'],
    [0, '+0.000'],
    [-1500, '−1.500'],
  ])('%d → %s', (ms, text) => {
    expect(fmtDelta(ms)).toBe(text);
  });
});

/** The table's rows as [row header, ...cells]. */
const rows = (html: string) =>
  [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(([, row = '']) => [...row.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/g)].map(([, , text]) => text))
    .filter((r) => r.length > 0);
const table = (drivers: Driver[]) => renderToStaticMarkup(<DeltaTable drivers={drivers} laps={laps} />);

describe('the delta table', () => {
  const html = table([VER, NOR]);
  const body = rows(html).slice(2);

  it('names the reference, the first selected driver, in the header', () => {
    expect(html).toContain('aria-label="Sector deltas"');
    expect(html).toMatch(/<div class="scroll"><table/);
    expect(rows(html).slice(0, 2)).toEqual([
      ['Lap', 'NOR Δ vs VER'],
      ['S1', 'S2', 'S3'],
    ]);
  });

  it('heads the table with the best laps (green or purple) of each driver', () => {
    // VER lap 2 (purple) against NOR lap 5 (green): 28050 − 28000, 30150 − 30000, 22700 − 22500.
    expect(body[0]).toEqual(['Best lap<br/>L2 vs L5', '+0.050', '+0.150', '+0.200']);
  });

  it('signs a delta as the other driver − the reference, per lap', () => {
    expect(body[1]).toEqual(['1', '−5.000', '+0.000', '+0.000']);
  });

  it('sector deltas are skipped when either value is null or the lap is deleted', () => {
    // Lap 2: NOR S2 is null. Lap 3: VER S2 is null and NOR's lap is deleted. Lap 4: VER's lap is deleted.
    expect(body.slice(2)).toEqual([
      ['2', '+0.100', '—', '−0.100'],
      ['3', '—', '—', '—'],
      ['4', '—', '—', '—'],
    ]);
    // NOR lap 5 has no VER lap 5: no row.
    expect(body).toHaveLength(5);
  });

  it('makes the first selected the reference', () => {
    const swapped = rows(table([NOR, VER]));
    expect(swapped[0]).toEqual(['Lap', 'VER Δ vs NOR']);
    expect(swapped[2]).toEqual(['Best lap<br/>L5 vs L2', '−0.050', '−0.150', '−0.200']);
    expect(swapped[3]).toEqual(['1', '+5.000', '+0.000', '+0.000']);
  });

  it('keeps the Best-lap row with — where a driver has no best lap', () => {
    // Without NOR lap 5 (its only green lap), NOR has no best lap.
    const noBest = laps.filter((l) => !(l.driver_number === 4 && l.lap_number === 5));
    const r = rows(renderToStaticMarkup(<DeltaTable drivers={[VER, NOR]} laps={noBest} />));
    expect(r[2]).toEqual(['Best lap<br/>L2 vs L—', '—', '—', '—']);
    expect(r[3]?.[0]).toBe('1');
  });

  it('says so when the reference has no laps, and still shows the Best-lap row', () => {
    const html = table([driver(99, 'ZZZ', null), VER]);
    expect(html).toMatch(/^<p class="muted">ZZZ has no laps in this session: no deltas.<\/p><div class="scroll">/);
    expect(rows(html).slice(2)).toEqual([['Best lap<br/>L— vs L2', '—', '—', '—']]);
    expect(table([VER, NOR])).toMatch(/^<div class="scroll">/);
  });

  it('gives every other driver its own column group', () => {
    const three = rows(table([VER, NOR, PER]));
    expect(three[0]).toEqual(['Lap', 'NOR Δ vs VER', 'PER Δ vs VER']);
    expect(three[1]).toEqual(['S1', 'S2', 'S3', 'S1', 'S2', 'S3']);
    expect(three[2]).toEqual(['Best lap<br/>L2 vs L5, L2', '+0.050', '+0.150', '+0.200', '+0.300', '+0.300', '+0.400']);
    // Lap 1: PER has none.
    expect(three[3]).toEqual(['1', '−5.000', '+0.000', '+0.000', '—', '—', '—']);
  });
});

describe('the comparison', () => {
  it('asks for a second driver', () => {
    expect(renderToStaticMarkup(<Compare drivers={[VER]} laps={laps} />)).toBe('<p>Pick at least 2 drivers.</p>');
  });

  it('shows the chart box, sized by CSS, and the delta table', () => {
    const html = renderToStaticMarkup(<Compare drivers={[VER, NOR]} laps={laps} />);
    expect(html).toContain('<div class="chart" role="img" aria-label="Lap times: VER, NOR"></div>');
    expect(html).toContain('Loading…');
    expect(html).toContain('aria-label="Sector deltas"');
  });
});

describe('the driver picker', () => {
  it('toggles each driver with aria-pressed, in the given order, with the team bar', () => {
    const html = renderToStaticMarkup(<DriverPicker drivers={[VER, NOR, PER]} selected={[4, 1]} onToggle={() => {}} />);
    expect(html).toMatch(/^<fieldset class="picker"><legend>Drivers<\/legend>/);
    expect([...html.matchAll(/aria-pressed="(\w+)"[^>]*>(\w+)</g)].map(([, p, a]) => [a, p])).toEqual([
      ['VER', 'true'],
      ['NOR', 'true'],
      ['PER', 'false'],
    ]);
    expect(html).toContain('class="drv" style="--team:#3671C6"');
  });
});
