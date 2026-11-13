import type { Lap, RaceControl, Stints } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { init } from '../src/lib/echarts.ts';
import type { Driver } from '../src/lib/session.ts';
import { fmtDelta } from '../src/lib/time.ts';
import { Compare } from '../src/views/Compare.tsx';
import { DeltaTable, Duel } from '../src/views/DeltaTable.tsx';
import { DriverPicker } from '../src/views/DriverPicker.tsx';
import { type ChartTokens, lapChartOption, lineStyles } from '../src/views/lap-chart-option.ts';
import { sessionDetail } from './laps.ts';

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
const tokens: ChartTokens = {
  fg: '#f0f0f5',
  muted: '#9b9ba8',
  line: '#34343f',
  bg: '#15151e',
  amber: '#ffb020',
  live: '#ff6b6b',
  rain: '#4da6ff',
  light: false,
};
const fit = { window: 'fit', periods: [] } as const;

describe('lapChartOption', () => {
  const option = lapChartOption([VER, NOR, PER], laps, tokens, fit);
  // Each driver has its line, then (after all the lines) its triangles under the same name; the bands' series (none
  // here) has no line style.
  const drawn = option.series.filter((s) => 'lineStyle' in s);
  const [verLine, norLine, perLine, verUp, norUp, perUp] = drawn;
  const items = (s: (typeof option.series)[number] | undefined) => s?.data ?? [];

  it('plots dense [lap, ms] pairs on a value axis from lap 0.5 to the last lap + 0.5 (F2)', () => {
    expect(option.xAxis).toMatchObject({ type: 'value', min: 0.5, max: 5.5, splitLine: { show: false } });
    // A band edge sits half a lap off a whole lap, so the labels skip anything but whole laps.
    expect(option.xAxis.axisLabel.formatter(3)).toBe('3');
    expect(option.xAxis.axisLabel.formatter(0.5)).toBe('');
    expect(items(perLine)).toEqual([
      [1, null],
      expect.objectContaining({ value: [2, 81500] }),
      [3, null],
      [4, null],
      [5, null],
    ]);
    for (const s of [verLine, norLine, perLine]) expect(s).toMatchObject({ connectNulls: false, clip: true });
  });

  it("has symbol 'none' and showAllSymbol true on every series; only the laps below override the symbol", () => {
    // 'auto' thins symbols on a category axis only (LineView getIsIgnoreFunc); true keeps that so (A§13).
    expect(option.series).toHaveLength(6);
    for (const s of option.series) expect(s).toMatchObject({ symbol: 'none', showAllSymbol: true });
  });

  it('rings the own best (purple or green) and draws a deleted lap as a 10 px ring filled with --bg (F1)', () => {
    const best = (color: string) => ({
      symbol: 'circle',
      symbolSize: 10,
      itemStyle: { color, borderColor: tokens.bg, borderWidth: 2 },
    });
    const hollow = (color: string) => ({
      symbol: 'circle',
      symbolSize: 10,
      itemStyle: { color: tokens.bg, borderColor: color, borderWidth: 2 },
    });
    expect(items(verLine)).toEqual([
      [1, 100000],
      { value: [2, 80500], ...best('#3671C6') },
      [3, null],
      { value: [4, 80000], ...hollow('#3671C6') },
      [5, null],
    ]);
    expect(items(norLine)).toEqual([
      [1, 95000],
      [2, 81000],
      { value: [3, 81200], ...hollow('#FF8000') },
      [4, 82000],
      { value: [5, 80900], ...best('#FF8000') },
    ]);
  });

  it('puts a triangle on the top edge for exactly the laps above the window, in the line colour and name', () => {
    // The window is 1:19–1:23: VER lap 1 (1:40) and NOR lap 1 (1:35) are above it.
    const up = { symbol: 'triangle', symbolSize: 8, symbolOffset: [0, -4] };
    expect(items(verUp)).toEqual([{ value: [1, 83000], ...up }, [2, null], [3, null], [4, null], [5, null]]);
    expect(items(norUp)).toEqual([{ value: [1, 83000], ...up }, [2, null], [3, null], [4, null], [5, null]]);
    expect(items(perUp).every((d) => Array.isArray(d) && d[1] === null)).toBe(true);
    for (const [line, tri] of [
      [verLine, verUp],
      [norLine, norUp],
      [perLine, perUp],
    ])
      expect(tri).toMatchObject({ name: line?.name, color: line?.color, lineStyle: { width: 0 }, clip: false });
    expect(verUp).not.toHaveProperty('endLabel');
    // No laps above the 107 % window (1:19–1:27) but the two out-laps either; none without a window.
    const wide = lapChartOption([VER, NOR], laps, tokens, { window: '107', periods: [] });
    expect(wide.series[2]?.data[0]).toMatchObject({ value: [1, 87000] });
    expect(wide.series[3]?.data.slice(1).every((d) => Array.isArray(d) && d[1] === null)).toBe(true);
    const none = lapChartOption([VER], [laps[0] as Lap], tokens, fit);
    expect(none.series[1]?.data).toEqual([[1, null]]);
  });

  it('windows Fit (C1) from the best valid lap − 1 s, floored to a second, over 4 s', () => {
    // Best valid lap: VER lap 2, 1:20.500 (the deleted 1:20.000 does not count).
    expect(option.yAxis).toMatchObject({ min: 79000, max: 83000, interval: 1000 });
    // 1:20.000 exactly: − 1 s is already whole.
    const whole = lapChartOption([PER], [{ ...(laps.at(-1) as Lap), lap_ms: 80000 }], tokens, fit);
    expect(whole.yAxis).toMatchObject({ min: 79000, max: 83000 });
  });

  it('windows 107 % from the same floor to 107 % of the best lap, ceiled to a second', () => {
    // 80.5 × 1.07 = 86.135.
    const wide = lapChartOption([VER, NOR, PER], laps, tokens, { window: '107', periods: [] });
    expect(wide.yAxis).toMatchObject({ min: 79000, max: 87000, interval: 1000 });
  });

  it('scales by itself, in whole seconds, without a purple or green lap', () => {
    const auto = lapChartOption([VER], [laps[0] as Lap], tokens, fit).yAxis;
    expect(auto).toMatchObject({ minInterval: 1000 });
    for (const key of ['min', 'max', 'interval']) expect(auto).not.toHaveProperty(key);
  });

  it('labels the y-axis in whole seconds, "1:33"', () => {
    expect(option.yAxis.axisLabel.formatter(93000)).toBe('1:33');
    expect(option.yAxis.axisLabel.formatter(79000)).toBe('1:19');
    expect(option.yAxis.axisLabel.formatter(119999.6)).toBe('2:00');
  });

  it('bands SC and VSC in --amber and red in --live, from half a lap before to half a lap after (F2)', () => {
    const periods = [
      { kind: 'sc', from: 2, to: 3 },
      { kind: 'vsc', from: 4, to: 4 },
      { kind: 'red', from: 5, to: 5 },
    ] as const;
    const banded = lapChartOption([VER, NOR], laps, tokens, { window: 'fit', periods });
    const area = (c: string) => ({ color: c, opacity: 0.15 });
    // On a series of their own after the lines and triangles: no data, silent, no tooltip, not in the legend, so
    // hiding the reference in the legend keeps the bands.
    expect(banded.series).toHaveLength(5);
    expect(banded.series[4]).toEqual({
      type: 'line',
      data: [],
      silent: true,
      tooltip: { show: false },
      markArea: {
        silent: true,
        label: { color: tokens.fg, position: 'insideTop' },
        data: [
          [{ name: 'SC', xAxis: 1.5, itemStyle: area(tokens.amber) }, { xAxis: 3.5 }],
          // A one-lap VSC is a lap wide.
          [{ name: 'VSC', xAxis: 3.5, itemStyle: area(tokens.amber) }, { xAxis: 4.5 }],
          [{ name: 'RED', xAxis: 4.5, itemStyle: area(tokens.live) }, { xAxis: 5.5 }],
        ],
      },
    });
    expect(banded.legend.data).toEqual(['VER', 'NOR']);
    // On no driver's series, and no band series without a period.
    expect(banded.series.slice(0, 4).some((s) => 'markArea' in s)).toBe(false);
    expect(option.series.some((s) => 'markArea' in s)).toBe(false);
  });

  it('names only the drivers in the legend, 36 px wide so a dash shows, in --fg', () => {
    expect(option.legend).toEqual({
      top: 0,
      data: ['VER', 'NOR', 'PER'],
      itemWidth: 36,
      textStyle: { color: tokens.fg },
    });
  });

  it('ends each line with its acronym in --fg, moved apart on overlap, inside a 48 px right margin (F3)', () => {
    for (const s of [verLine, norLine, perLine])
      expect(s).toMatchObject({
        endLabel: { show: true, formatter: s?.name, color: tokens.fg },
        labelLayout: { moveOverlap: 'shiftY' },
      });
    expect(option.grid).toEqual({
      left: 8,
      right: 48,
      top: 40,
      bottom: 8,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    });
  });

  it("drops the end label when the driver's last lap with a time is outside the window; the legend keeps the name", () => {
    // VER's last lap with a time is lap 4 (lap 5 is missing), inside the window: labelled, as above.
    const endOn = (ms: number) => {
      // A yellow lap 6, so the window stays 1:19–1:23.
      const six = lap(4, 6, ms, [null, null, null], 'yellow');
      const o = lapChartOption([VER, NOR], [...laps, six], tokens, fit);
      return [o.series[1], o.legend.data];
    };
    expect(endOn(82000)).toMatchObject([{ endLabel: { show: true } }, ['VER', 'NOR']]);
    expect(endOn(90000)).toMatchObject([{ endLabel: { show: false } }, ['VER', 'NOR']]);
    expect(endOn(78000)).toMatchObject([{ endLabel: { show: false } }, ['VER', 'NOR']]);
    // A later lap without a time does not count.
    const untimed = lapChartOption([NOR], [...laps, lap(4, 6, null, [null, null, null], null)], tokens, fit);
    expect(untimed.series[0]).toMatchObject({ endLabel: { show: true } });
  });

  it('uses a rich-text tooltip: the lap, then per driver its time, Δ to the reference, compound and flags', () => {
    expect(option.tooltip).toMatchObject({
      trigger: 'axis',
      renderMode: 'richText',
      confine: true,
      axisPointer: { snap: true },
    });
    const marked = laps.map((l) =>
      l.driver_number === 4 && l.lap_number === 4 ? { ...l, is_pit_in: true, compound: 'MEDIUM' } : l,
    );
    const tip = lapChartOption([VER, NOR, PER], marked, tokens, fit).tooltip.formatter;
    // Lap 1: both out of the window; no Δ on the reference line.
    expect(tip([{ dataIndex: 0 }])).toBe(
      'Lap 1\nVER 1:40.000 · Soft · OUT, above the window\nNOR 1:35.000 · −5.000 · Soft · above the window\nPER —',
    );
    // Lap 3: the reference has no time, so no Δ.
    expect(tip([{ dataIndex: 2 }])).toBe('Lap 3\nVER —\nNOR 1:21.200 · Soft · deleted\nPER —');
    expect(tip({ dataIndex: 3 })).toBe(
      'Lap 4\nVER 1:20.000 · Soft · deleted\nNOR 1:22.000 · +2.000 · Medium · IN\nPER —',
    );
    expect(tip([{ dataIndex: 1 }])).toBe(
      'Lap 2\nVER 1:20.500 · Soft\nNOR 1:21.000 · +0.500 · Soft\nPER 1:21.500 · +1.000 · Soft',
    );
    // A deleted lap more than 1 s faster than the best valid lap is below the window.
    const fast = laps.map((l) => (l.driver_number === 4 && l.lap_number === 3 ? { ...l, lap_ms: 78500 } : l));
    expect(lapChartOption([VER, NOR], fast, tokens, fit).tooltip.formatter({ dataIndex: 2 })).toBe(
      'Lap 3\nVER —\nNOR 1:18.500 · Soft · deleted, below the window',
    );
    // An unknown compound is left out.
    const odd = lapChartOption([PER], [{ ...(laps.at(-1) as Lap), compound: 'UNKNOWN' }], tokens, fit);
    expect(odd.tooltip.formatter([{ dataIndex: 1 }])).toBe('Lap 2\nPER 1:21.500');
    expect(JSON.stringify(option)).not.toMatch(/[<>]/);
  });

  it('strips rich-text markup {|} from data strings', () => {
    const odd = lapChartOption([driver(1, '{a|VER}', null)], laps, tokens, fit);
    expect(odd.series[0]).toMatchObject({ name: 'aVER', endLabel: { formatter: 'aVER' } });
    expect(odd.series.filter((s) => 'lineStyle' in s)[1]?.name).toBe('aVER');
    expect(odd.legend.data).toEqual(['aVER']);
    expect(odd.tooltip.formatter({ dataIndex: 1 })).toBe('Lap 2\naVER 1:20.500 · Soft');
  });

  it('draws each line with lineStyles', () => {
    expect(drawn.slice(0, 3).map((s) => [s.name, s.color, s.lineStyle])).toEqual([
      ['VER', '#3671C6', { type: 'solid' }],
      ['NOR', '#FF8000', { type: 'solid' }],
      ['PER', '#3671C6', { type: 'dashed' }],
    ]);
  });
});

describe('lineStyles (C2)', () => {
  const styles = (teams: (string | null)[], light = false) =>
    lineStyles(
      teams.map((t, i) => driver(i + 1, `D${i}`, t)),
      { ...tokens, light },
    ).map((s) => [s.color, s.type]);

  it('dashes the second of two equal colours', () => {
    expect(styles(['#3671C6', '#3671C6'])).toEqual([
      ['#3671C6', 'solid'],
      ['#3671C6', 'dashed'],
    ]);
  });

  it('dashes a close but unequal pair', () => {
    // Red Bull 2025 against 2026: ΔE 5.2 (deutan 5.3, protan 5.3), under 15.
    expect(styles(['#3671C6', '#4781D7'])).toEqual([
      ['#3671C6', 'solid'],
      ['#4781D7', 'dashed'],
    ]);
  });

  it('dashes a pair that is close only after the light clamp, and only on light', () => {
    // Mercedes #00D7B6 against Aston Martin #229971: ΔE 18.0 (deutan 17.5, protan 19.0) as drawn on dark;
    // the clamp darkens Mercedes to #00a88d, ΔE 5.0 (deutan 4.8, protan 5.3).
    expect(styles(['#00D7B6', '#229971'])).toEqual([
      ['#00D7B6', 'solid'],
      ['#229971', 'solid'],
    ]);
    expect(styles(['#00D7B6', '#229971'], true)).toEqual([
      ['#00a88d', 'solid'],
      ['#229971', 'dashed'],
    ]);
  });

  it('keeps a far pair solid', () => {
    // Red Bull against McLaren: ΔE 37.0 (deutan 36.9, protan 27.8).
    expect(styles(['#3671C6', '#FF8000'])).toEqual([
      ['#3671C6', 'solid'],
      ['#FF8000', 'solid'],
    ]);
  });

  it('gives three close drivers solid, dashed and dotted, then goes round again', () => {
    // #3671C6, #4781D7 and Williams #1868DB: every pair under ΔE 8.1.
    expect(styles(['#3671C6', '#4781D7', '#1868DB']).map(([, t]) => t)).toEqual(['solid', 'dashed', 'dotted']);
    // Drivers without a team colour share --muted.
    expect(styles([null, null, null, null, '#FF8000'])).toEqual([
      [tokens.muted, 'solid'],
      [tokens.muted, 'dashed'],
      [tokens.muted, 'dotted'],
      [tokens.muted, 'solid'],
      ['#FF8000', 'solid'],
    ]);
  });

  it('takes the first type no close earlier driver uses, so a far driver in between changes nothing', () => {
    expect(styles(['#3671C6', '#FF8000', '#3671C6', '#FF8000']).map(([, t]) => t)).toEqual([
      'solid',
      'solid',
      'dashed',
      'dashed',
    ]);
  });
});

// The chart laid out by ECharts itself, at phone width, through server-side rendering (F4): what is drawn, not
// what the option asks for.
describe('the lap chart at 390 px', () => {
  use([SVGRenderer]);
  const RED_BULL = '#3671C6';
  const MCLAREN = '#FF8000';
  const DELETED = [12, 25, 38, 44];
  // 57 laps each: pit laps 20 and 21 above the window, the bests on laps 30 and 33, both ending on 1:33.000.
  const race = [1, 4].flatMap((d) =>
    Array.from({ length: 57 }, (_, i) => {
      const n = i + 1;
      const ms = n === 57 ? 93000 : n === 20 || n === 21 ? 99000 + d : 93300 + ((n * d) % 7) * 100;
      const best = d === 1 ? n === 30 : n === 33;
      return lap(d, n, ms, [null, null, null], best ? (d === 1 ? 'purple' : 'green') : null, {
        deleted: DELETED.includes(n) && (d === 1 ? n < 30 : n > 30),
        is_pit_in: n === 20,
        is_pit_out: n === 21,
      });
    }),
  );
  const pick = [driver(1, 'VER', RED_BULL), driver(4, 'NOR', MCLAREN)];
  const option = lapChartOption(pick, race, tokens, fit);

  type Drawn = {
    type: string;
    shape?: { symbolType?: string };
    style: { fill?: string; stroke?: string; text?: string };
  };
  type Box = { x: number; y: number; width: number; height: number };
  const draw = (o: object) => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 390, height: 300 });
    try {
      chart.setOption({ ...o, animation: false });
      return chart
        .getZr()
        .storage.getDisplayList()
        .map((el) => {
          const e = el as unknown as Drawn & {
            parent?: { __hostTarget?: { type: string } };
            transform?: number[];
            getBoundingRect(): { clone(): Box & { applyTransform(m: number[]): void } };
          };
          const box = e.getBoundingRect().clone();
          if (e.transform) box.applyTransform(e.transform);
          return { el: e, box, endLabel: e.parent?.__hostTarget?.type === 'ec-polyline' };
        });
    } finally {
      chart.dispose();
    }
  };
  const symbols = (o: object) => {
    const list = draw(o).filter(({ el }) => el.shape?.symbolType !== undefined);
    const team = new Set([RED_BULL, MCLAREN]);
    const of = (type: string, fill: (f: string) => boolean, stroke: (s: string) => boolean) =>
      list.filter(
        ({ el }) => el.shape?.symbolType === type && fill(el.style.fill ?? '') && stroke(el.style.stroke ?? ''),
      ).length;
    return {
      hollow: of(
        'circle',
        (f) => f === tokens.bg,
        (s) => team.has(s),
      ),
      best: of(
        'circle',
        (f) => team.has(f),
        (s) => s === tokens.bg,
      ),
      triangles: of(
        'triangle',
        (f) => team.has(f),
        () => true,
      ),
    };
  };

  it('fills ECharts’ emptyCircle white, a disc on the dark theme (F1)', () => {
    const empty = {
      backgroundColor: tokens.bg,
      xAxis: { type: 'value' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          color: RED_BULL,
          symbol: 'none',
          data: [[1, 93000], { value: [2, 93500], symbol: 'emptyCircle', symbolSize: 10 }],
        },
      ],
    };
    // An emptyCircle is drawn as a circle with an "empty brush": ringed in the line colour, filled with tokens' #fff.
    const fills = draw(empty)
      .filter(({ el }) => el.shape?.symbolType === 'circle')
      .map(({ el }) => [el.style.fill, el.style.stroke]);
    expect(fills).toEqual([['#fff', RED_BULL]]);
  });

  it('draws all 4 deleted laps hollow, both own bests and the 4 laps above the window', () => {
    expect(race.filter((l) => l.deleted)).toHaveLength(4);
    expect(symbols(option)).toEqual({ hollow: 4, best: 2, triangles: 4 });
  });

  it('would thin the deleted laps on a category axis with showAllSymbol auto, the P4d layout', () => {
    // On the value axis 'auto' changes nothing (it thins on a category axis only), so the old axis shows it can fail.
    const auto = { ...option, series: option.series.map((s) => ({ ...s, showAllSymbol: 'auto' })) };
    expect(symbols(auto).hollow).toBe(4);
    const category = { ...auto, xAxis: { type: 'category', data: Array.from({ length: 58 }, (_, i) => i) } };
    expect(symbols(category).hollow).toBeLessThan(4);
  });

  it('keeps the bands when the reference is hidden in the legend, as they sit on their own series', () => {
    const periods = [{ kind: 'sc', from: 34, to: 35 }] as const;
    const banded = lapChartOption(pick, race, tokens, { window: 'fit', periods });
    const hideVer = (o: { legend: object }) => ({ ...o, legend: { ...o.legend, selected: { VER: false } } });
    const bandsDrawn = (o: object) => draw(o).filter(({ el }) => el.style.fill === tokens.amber).length;
    expect(bandsDrawn(banded)).toBe(1);
    expect(bandsDrawn(hideVer(banded))).toBe(1);
    // The P4d-era place, on the first driver's series, loses them: the test can fail.
    const [verLine, ...rest] = banded.series;
    const band = rest.at(-1);
    const onFirst = {
      ...banded,
      series: [{ ...verLine, markArea: band && 'markArea' in band ? band.markArea : undefined }, ...rest.slice(0, -1)],
    };
    expect(bandsDrawn(onFirst)).toBe(1);
    expect(bandsDrawn(hideVer(onFirst))).toBe(0);
  });

  it('keeps the two end labels apart when both drivers end on the same time (F3)', () => {
    const labels = (o: object) =>
      draw(o)
        .filter((d) => d.endLabel)
        .map((d) => d.box);
    const apart = ([a, b]: Box[]) =>
      a !== undefined &&
      b !== undefined &&
      (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    expect(labels(option)).toHaveLength(2);
    expect(apart(labels(option))).toBe(true);
    // Without moveOverlap they sit on each other, so the check can fail.
    const stacked = { ...option, series: option.series.map((s) => ({ ...s, labelLayout: undefined })) };
    expect(apart(labels(stacked))).toBe(false);
  });

  it('drops the end label of a driver whose last lap is outside the window, which would sit off the plot', () => {
    // ECharts places an endLabel with ignoreClip: NOR's last lap, 2:00, far above the Fit window.
    const off = race.map((l) => (l.driver_number === 4 && l.lap_number === 57 ? { ...l, lap_ms: 120000 } : l));
    const labels = (o: object) =>
      draw(o)
        .filter((d) => d.endLabel)
        .map((d) => ({ text: d.el.style.text, y: d.box.y }));
    const o = lapChartOption(pick, off, tokens, fit);
    // Drawn anyway, it sits above the grid's 40 px top: the test can fail.
    const forced = {
      ...o,
      series: o.series.map((s) => ('endLabel' in s ? { ...s, endLabel: { ...s.endLabel, show: true } } : s)),
    };
    expect(labels(forced).find((l) => l.text === 'NOR')?.y).toBeLessThan(40);
    expect(labels(o).map((l) => l.text)).toEqual(['VER']);
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
    .map(([, row = '']) =>
      // The delta bars (<i>, aria-hidden) are checked on their own below.
      [...row.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/g)].map(([, , text = '']) =>
        text.replace(/<i [^>]*><\/i>/g, ''),
      ),
    )
    .filter((r) => r.length > 0);
const table = (drivers: Driver[]) => renderToStaticMarkup(<DeltaTable drivers={drivers} laps={laps} />);

describe('the delta table', () => {
  const html = table([VER, NOR]);
  const body = rows(html).slice(2);

  it('names the reference, the first selected driver, in the header', () => {
    expect(html).toContain('aria-label="Sector deltas"');
    // A focusable, named scroll region (ui/Scroll.tsx).
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Sector deltas"><table');
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
    expect(html).toMatch(/^<p class="muted">ZZZ has no laps in this session: no deltas.<\/p><div class="scroll" /);
    expect(rows(html).slice(2)).toEqual([['Best lap<br/>L— vs L2', '—', '—', '—']]);
    expect(table([VER, NOR])).toMatch(/^<div class="scroll" /);
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

describe('the delta-cell bars', () => {
  const html = table([VER, NOR]);
  const cells = [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attrs, inner]) => [attrs, inner]);

  it('draws a bar from the centre, left (neg) when faster than the reference, 500 ms to the half, capped', () => {
    // Best lap: NOR − VER = +0.050 S1, so right (pos), 50 / 500 × 50 % = 5 %.
    expect(cells[0]).toEqual([' class="dc"', '+0.050<i class="db pos" aria-hidden="true" style="--w:5.0%"></i>']);
    // Lap 1 S1: −5.000, left and capped at the half.
    expect(cells[3]).toEqual([' class="dc"', '−5.000<i class="db neg" aria-hidden="true" style="--w:50.0%"></i>']);
  });

  it('has no bar for a zero and none, nor the dc class, for —', () => {
    expect(cells[4]).toEqual([' class="dc"', '+0.000']);
    // Lap 2 S2: NOR has no S2.
    expect(cells[7]).toEqual(['', '—']);
  });
});

const duel = (drivers: Driver[], l: Lap[] = laps) => renderToStaticMarkup(<Duel drivers={drivers} laps={l} />);
/** Each duel row as [sector, fill class or null, --w or null, the fill's --team or null, value]. */
const duelRows = (html: string) =>
  [
    ...html.matchAll(
      /<div><dt>(S\d)<\/dt><dd class="track" aria-hidden="true">(?:<span class="([^"]+)" style="--team:([^;]+);[^"]*--w:([^"]+)"><\/span>)?<\/dd><dd class="val">([^<]+)<\/dd><\/div>/g,
    ),
  ].map(([, s, cls = null, team = null, w = null, v]) => [s, cls, w, team, v]);

describe('the duel (C7)', () => {
  it('heads each block with both best laps, coloured as the server did, the other driver first', () => {
    const html = duel([VER, NOR]);
    expect(html).toContain(
      '<h3>NOR L5 <span class="t-green">1:20.900</span> vs VER L2 <span class="t-purple">1:20.500</span></h3>',
    );
    expect(html).toContain('<p class="duelaxis"><span>◀ VER faster</span><span>NOR faster ▶</span></p>');
    expect(html).toContain('<p class="foot">Lap +0.400</p>');
  });

  it('grows the bar toward the faster driver, in its colour, 300 ms to the half', () => {
    // NOR − VER: +50, +150, +200 ms: VER is faster, so left, in VER's colour.
    expect(duelRows(duel([VER, NOR]))).toEqual([
      ['S1', 'fill l', '8.3%', '#3671C6', '+0.050'],
      ['S2', 'fill l', '25.0%', '#3671C6', '+0.150'],
      ['S3', 'fill l', '33.3%', '#3671C6', '+0.200'],
    ]);
    // VER − PER: −300, −300, −400 ms: VER is faster, now on the right, capped at the half.
    expect(duelRows(duel([PER, VER]))).toEqual([
      ['S1', 'fill r', '50.0%', '#3671C6', '−0.300'],
      ['S2', 'fill r', '50.0%', '#3671C6', '−0.300'],
      ['S3', 'fill r', '50.0%', '#3671C6', '−0.400'],
    ]);
  });

  it('shows — and no bar for a missing sector, and the other side in the other colour', () => {
    const l = [lap(1, 1, 80000, [28000, null, 22000], 'purple'), lap(4, 1, 80100, [28100, 30000, 21900], 'green')];
    expect(duelRows(duel([VER, NOR], l))).toEqual([
      ['S1', 'fill l', '16.7%', '#3671C6', '+0.100'],
      ['S2', null, null, null, '—'],
      ['S3', 'fill r', '16.7%', '#FF8000', '−0.100'],
    ]);
  });

  it('gives one block per other driver, and one muted line where a best lap is missing', () => {
    expect([...duel([VER, NOR, PER]).matchAll(/<h3>(\w+)/g)].map(([, a]) => a)).toEqual(['NOR', 'PER']);
    const noBest = laps.filter((l) => !(l.driver_number === 4 && l.lap_number === 5));
    expect(duel([VER, NOR], noBest)).toBe('<p class="muted">NOR vs VER: no best lap to compare.</p>');
  });
});

const compare = (drivers: Driver[]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Compare
        session={11000}
        detail={sessionDetail('Practice', 'Practice 1')}
        drivers={drivers}
        laps={laps}
        onReference={() => {}}
      />
    </QueryClientProvider>,
  );

describe('the comparison', () => {
  it('asks for a second driver', () => {
    expect(compare([VER])).toBe('<p>Pick at least 2 drivers.</p>');
  });

  it('shows the lap chart beside the gap chart and the duel, then the delta table', () => {
    const html = compare([VER, NOR]);
    expect(html).toMatch(/^<div class="cgrid"><section class="card"><div class="panel-title"><h2>Lap times<\/h2>/);
    expect(html).toContain('<div class="chart" role="img" aria-label="Lap times: VER, NOR"></div>');
    expect(html).toContain('<div class="side"><section class="card"><div class="panel-title"><h2>Gap to VER</h2>');
    expect(html).toContain('<div class="chart" role="img" aria-label="Gap to VER: NOR"></div>');
    expect(html).toContain('<h2>Best laps, sector by sector</h2>');
    expect(html).toContain('Loading…');
    expect(html).toContain('aria-label="Sector deltas"');
    // The symbols are not read; the words are.
    expect(html).toContain(
      '<p class="keys"><span aria-hidden="true">●</span> own best · <span aria-hidden="true">○</span> deleted · <span aria-hidden="true">▲</span> above the window</p>',
    );
  });

  it('starts on the Fit window and marks the reference, the first driver, pressed', () => {
    const html = compare([NOR, VER, PER]);
    const pressed = (label: string) =>
      [
        ...(
          html.match(new RegExp(`<fieldset class="segmented" aria-label="${label}">(.*?)</fieldset>`))?.[1] ?? ''
        ).matchAll(/aria-pressed="(\w+)">([^<]+)</g),
      ].map(([, p, text]) => [text, p]);
    expect(pressed('Window')).toEqual([
      ['Fit', 'true'],
      ['107 %', 'false'],
    ]);
    expect(pressed('Reference')).toEqual([
      ['NOR', 'true'],
      ['VER', 'false'],
      ['PER', 'false'],
    ]);
    expect(html).toContain('<h2>Gap to NOR</h2>');
  });
});

describe('the pit cycles card', () => {
  const T0 = Date.parse('2026-10-25T20:00:00Z');
  /** Car d's laps 1..last at 90 s from `start` s, in-laps as given. */
  const run = (d: number, start: number, last: number, ins: number[]): Lap[] =>
    Array.from({ length: last }, (_, i) =>
      lap(d, i + 1, 90000 + (i % 2) * 10, [null], null, {
        date_start: new Date(T0 + (start + 90 * i) * 1000).toISOString(),
        is_pit_in: ins.includes(i + 1),
      }),
    );
  // VER stops L4 and L20, NOR L6 and L21: L4/L6 is comparable; NOR has no lap 22, so L20/L21 has no crossing after.
  const raceLaps = [...run(1, 0, 25, [4, 20]), ...run(4, 5, 21, [6, 21])];
  const stints: Stints = [
    [1, [1, 5, 21]],
    [4, [1, 7, 22]],
  ].flatMap(([d, starts]) =>
    (starts as number[]).map((lap_start, i) => ({
      driver_number: d as number,
      stint_number: i + 1,
      lap_start,
      lap_end: null,
      compound: 'HARD',
      tyre_age_at_start: 0,
    })),
  );
  const control: RaceControl = [];

  type Seed = { stints?: Stints | 'error'; rc?: RaceControl | 'error' };
  const render = (type: string, { stints: st, rc: control }: Seed = {}) => {
    const client = new QueryClient();
    const seed = (key: string, v: unknown) => {
      // An errored query that once had data stays an error on a static render (without data it would refetch: pending).
      if (v === 'error')
        client
          .getQueryCache()
          .build(client, { queryKey: [key, 11000] })
          .setState({ status: 'error', error: new Error('x'), data: [], dataUpdatedAt: Date.now() });
      else if (v !== undefined) client.setQueryData([key, 11000], v);
    };
    seed('stints', st);
    seed('race-control', control);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Compare
          session={11000}
          detail={sessionDetail(type, type)}
          drivers={[VER, NOR]}
          laps={raceLaps}
          onReference={() => {}}
        />
      </QueryClientProvider>,
    );
  };
  const card = (html: string) => html.match(/<section class="card"><h2>Pit cycles<\/h2>.*?<\/section>/)?.[0];

  it('lists one sentence per cycle of every picked pair, comparable or not', () => {
    const html = card(render('Race', { stints, rc: control }));
    expect(html).toBe(
      '<section class="card"><h2>Pit cycles</h2><ul class="cycles">' +
        '<li>VER pitted L4, NOR L6: VER 5.0 s ahead before, 5.0 s ahead after</li>' +
        '<li>VER pitted L20, NOR L21: not comparable (a line crossing is missing)</li>' +
        '</ul></section>',
    );
  });

  it('says it is loading while the stints or race control load, and that they failed', () => {
    expect(card(render('Race'))).toContain('<p class="muted">Loading pit cycles…</p>');
    expect(card(render('Race', { stints }))).toContain('Loading pit cycles…');
    expect(card(render('Race', { stints: 'error', rc: control }))).toContain(
      '<p class="muted">Pit cycles need the stints and race control, which did not load.</p>',
    );
    expect(card(render('Race', { stints, rc: 'error' }))).toContain('which did not load.');
  });

  it('says so when no stop pairs up', () => {
    expect(card(render('Race', { stints: stints.filter((s) => s.driver_number === 1), rc: control }))).toContain(
      '<p class="muted">No pit cycles within 3 laps for the picked drivers.</p>',
    );
  });

  it('is absent outside races', () => {
    expect(render('Practice', { stints, rc: control })).not.toContain('Pit cycles');
  });
});

describe('the driver picker', () => {
  const picker = (selected: number[], showReference = false) =>
    renderToStaticMarkup(
      <DriverPicker drivers={[VER, NOR, PER]} selected={selected} onToggle={() => {}} showReference={showReference} />,
    );

  it('shows the picked drivers as chips in pick order, each with a Remove button and the team bar', () => {
    const html = picker([4, 1]);
    expect(html).toMatch(/^<fieldset class="picked" aria-label="Drivers"><span class="chip drv"/);
    expect([...html.matchAll(/<span class="chip drv"[^>]*>(\w+)/g)].map(([, a]) => a)).toEqual(['NOR', 'VER']);
    expect([...html.matchAll(/aria-label="(Remove \w+)"/g)].map(([, a]) => a)).toEqual(['Remove NOR', 'Remove VER']);
    // Papaya is below 3:1 on white: the light theme gets a darker copy.
    expect(html).toContain('<span class="chip drv" style="--team:#FF8000;--team-l:#e97400">NOR<button type="button"');
    expect(html).not.toContain('reference');
  });

  it('says "reference" on the first chip only, and only on Compare', () => {
    const html = picker([4, 1], true);
    expect(html).toContain('NOR<span class="ref">reference</span><button');
    expect(html.match(/reference/g)).toHaveLength(1);
  });

  it('keeps every driver as an aria-pressed toggle, in the given order, inside "Add driver"', () => {
    const html = picker([4, 1]);
    const add =
      html.match(/<details class="add"><summary>Add driver<\/summary>(.*)<\/details><\/fieldset>$/)?.[1] ?? '';
    expect(add).toMatch(/^<fieldset class="picker"><legend>All drivers<\/legend>/);
    expect([...add.matchAll(/aria-pressed="(\w+)"[^>]*>(\w+)</g)].map(([, p, a]) => [a, p])).toEqual([
      ['VER', 'true'],
      ['NOR', 'true'],
      ['PER', 'false'],
    ]);
    expect(add).toContain('class="drv" style="--team:#3671C6;--team-l:#3671C6"');
  });
});
