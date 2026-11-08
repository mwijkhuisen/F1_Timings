import type { Lap } from '@f1/contracts';
import { deltaE } from '../lib/colour.ts';
import { clampForLight, compoundOf, type Driver } from '../lib/session.ts';
import { fmtDelta, fmtLap } from '../lib/time.ts';
import { KIND_LABEL, type Period } from '../lib/track.ts';

// The lap-time chart's ECharts option (D4, E2; P4f). Pure: no ECharts import at runtime, no HTML.

/** Theme colours, read from the CSS custom properties by Chart, and whether the light theme is on. */
export type ChartTokens = {
  fg: string;
  muted: string;
  line: string;
  bg: string;
  amber: string;
  live: string;
  light: boolean;
};

/** Rich-text markup (`{style|text}`) out of a data string: the tooltip and legend render rich text. */
export const plain = (s: string) => s.replace(/[{|}]/g, '');

const LINE_TYPES = ['solid', 'dashed', 'dotted'] as const;
type LineType = (typeof LINE_TYPES)[number];

/** Close enough to need a different line type (C2): OKLab ΔE × 100, Machado 2009 for the colour-blind. */
const close = (a: string, b: string) => deltaE(a, b) < 15 || deltaE(a, b, 'deutan') < 8 || deltaE(a, b, 'protan') < 8;

/**
 * Each driver's line colour as drawn in this theme (the team colour, clamped on light; `--muted` without one) and
 * line type (C2): the first of solid, dashed and dotted that no earlier close driver uses, round again once all
 * three are taken. Greedy, in pick order. The gap chart shares it, so a driver looks the same on both.
 */
export function lineStyles(drivers: readonly Driver[], tokens: ChartTokens): { color: string; type: LineType }[] {
  const out: { color: string; type: LineType }[] = [];
  for (const d of drivers) {
    const color = d.team === null ? tokens.muted : tokens.light ? clampForLight(d.team) : d.team;
    const near = out.filter((o) => close(o.color, color));
    const free = LINE_TYPES.find((t) => !near.some((o) => o.type === t));
    out.push({ color, type: free ?? LINE_TYPES[near.length % LINE_TYPES.length] ?? 'solid' });
  }
  return out;
}

/** The lap axis (F2): a value axis, so a band can start half a lap before its first lap. Labels on whole laps. */
export const lapAxis = (last: number, tokens: ChartTokens) => ({
  type: 'value' as const,
  min: 0.5,
  max: last + 0.5,
  minInterval: 1,
  axisLine: { lineStyle: { color: tokens.line } },
  axisLabel: { color: tokens.muted, formatter: (v: number) => (Number.isInteger(v) ? String(v) : '') },
  splitLine: { show: false },
});

/** SC, VSC and red-flag bands, each from half a lap before its first lap to half a lap after its last. */
export const bands = (periods: readonly Period[], tokens: ChartTokens) => ({
  silent: true,
  label: { color: tokens.fg, position: 'insideTop' as const },
  data: periods.map((p) => [
    {
      name: KIND_LABEL[p.kind],
      xAxis: p.from - 0.5,
      itemStyle: { color: p.kind === 'red' ? tokens.live : tokens.amber, opacity: 0.15 },
    },
    { xAxis: p.to + 0.5 },
  ]),
});

/** The axis labels fit inside these margins (ECharts 6's replacement for the deprecated `containLabel`). */
export const grid = {
  left: 8,
  // Room for the end labels (three letters).
  right: 48,
  top: 40,
  bottom: 8,
  outerBoundsMode: 'same' as const,
  outerBoundsContain: 'axisLabel' as const,
};

/** The acronym at the end of the line, in --fg, moved apart from the others (F3). */
export const endLabel = (name: string, tokens: ChartTokens) => ({
  endLabel: { show: true, formatter: name, color: tokens.fg },
  labelLayout: { moveOverlap: 'shiftY' as const },
});

export const tooltip = (tokens: ChartTokens, lines: (dataIndex: number) => string[]) => ({
  trigger: 'axis' as const,
  axisPointer: { snap: true },
  renderMode: 'richText' as const,
  confine: true,
  backgroundColor: tokens.bg,
  borderColor: tokens.line,
  textStyle: { color: tokens.fg },
  formatter: (params: { dataIndex: number } | { dataIndex: number }[]) => {
    const p = Array.isArray(params) ? params[0] : params;
    return p ? lines(p.dataIndex).join('\n') : '';
  },
});

type ChartLap = Pick<
  Lap,
  'driver_number' | 'lap_number' | 'lap_ms' | 'deleted' | 'colour' | 'is_pit_in' | 'is_pit_out' | 'compound'
>;

export type LapChartView = { window: 'fit' | '107'; periods: readonly Period[] };

export function lapChartOption(
  drivers: readonly Driver[],
  laps: readonly ChartLap[],
  tokens: ChartTokens,
  { window, periods }: LapChartView,
) {
  const picked = new Set(drivers.map((d) => d.number));
  const mine = laps.filter((l) => picked.has(l.driver_number));
  const byKey = new Map(mine.map((l) => [`${l.driver_number}-${l.lap_number}`, l]));
  const last = mine.reduce((n, l) => Math.max(n, l.lap_number), 0);
  const lapNumbers = Array.from({ length: last }, (_, i) => i + 1);
  const at = (d: Driver, n: number) => byKey.get(`${d.number}-${n}`);
  const valid = (l: ChartLap) => l.colour.lap === 'purple' || l.colour.lap === 'green';

  // The window starts at the picked drivers' fastest valid lap (the server's purple or green, A§9) − 1 s, floored to
  // a second, and runs 4 s (Fit, C1) or to 107 % of that lap, ceiled to a second.
  let best = Number.POSITIVE_INFINITY;
  for (const l of mine) if (l.lap_ms !== null && valid(l)) best = Math.min(best, l.lap_ms);
  const min = Math.floor((best - 1000) / 1000) * 1000;
  const max = window === 'fit' ? min + 4000 : Math.ceil((best * 1.07) / 1000) * 1000;
  const bounded = Number.isFinite(best);
  const range = bounded ? { min, max, interval: 1000 } : { minInterval: 1000 };
  const above = (ms: number | null) => bounded && ms !== null && ms > max;

  const styles = lineStyles(drivers, tokens);
  // The own best: the lap coloured purple or green, as DeltaTable's bestOf.
  const ownBest = drivers.map((d) => mine.find((l) => l.driver_number === d.number && valid(l)));

  // showAllSymbol true on every series: the default 'auto' keeps only the symbols on labelled laps once a lap is
  // narrower than 1.5 symbols, which on a phone hid most deleted laps of a race (A§13). Every series has symbol
  // 'none'; only the laps below override it.
  const lines = drivers.map((d, i) => {
    const { color, type } = styles[i] as (typeof styles)[number];
    const name = plain(d.acronym);
    return {
      type: 'line' as const,
      name,
      color,
      lineStyle: { type },
      symbol: 'none',
      showAllSymbol: true,
      // Dense [lap, ms]: a missing lap or a lap without a time is null, so the line breaks.
      data: lapNumbers.map((n) => {
        const l = at(d, n);
        if (l?.lap_ms == null) return [n, null];
        const value = [n, l.lap_ms];
        // A deleted lap is a hollow ring. Not `emptyCircle`: ECharts fills that white (F1), a disc on the dark theme.
        if (l.deleted)
          return {
            value,
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color: tokens.bg, borderColor: color, borderWidth: 2 },
          };
        // The own best is a dot in a --bg ring: the stroke sits on the edge, so it reads as 8 px inside 2 px.
        if (l === ownBest[i])
          return {
            value,
            symbol: 'circle',
            symbolSize: 10,
            itemStyle: { color, borderColor: tokens.bg, borderWidth: 2 },
          };
        return value;
      }),
      connectNulls: false,
      clip: true,
      ...endLabel(name, tokens),
      ...(i === 0 && periods.length > 0 ? { markArea: bands(periods, tokens) } : {}),
    };
  });

  // A lap above the window is a triangle on the top edge, in the driver's colour and with the same name, so the
  // legend toggles it with the line. Unclipped, and lifted half its height to sit on the edge.
  const triangles = drivers.map((d, i) => ({
    type: 'line' as const,
    name: plain(d.acronym),
    color: (styles[i] as (typeof styles)[number]).color,
    lineStyle: { width: 0 },
    symbol: 'none',
    showAllSymbol: true,
    data: lapNumbers.map((n) =>
      above(at(d, n)?.lap_ms ?? null)
        ? { value: [n, max], symbol: 'triangle', symbolSize: 8, symbolOffset: [0, -4] }
        : [n, null],
    ),
    connectNulls: false,
    clip: false,
  }));

  const [ref] = drivers;
  const line = (d: Driver, n: number) => {
    const l = at(d, n);
    const name = plain(d.acronym);
    if (l?.lap_ms == null) return `${name} —`;
    const parts = [`${name} ${fmtLap(l.lap_ms)}`];
    const r = ref && d !== ref ? at(ref, n) : undefined;
    if (r?.lap_ms != null) parts.push(fmtDelta(l.lap_ms - r.lap_ms));
    const compound = compoundOf(l.compound);
    if (compound) parts.push(compound[0]?.toUpperCase() + compound.slice(1));
    const flags = [
      l.deleted && 'deleted',
      l.is_pit_in && 'IN',
      l.is_pit_out && 'OUT',
      above(l.lap_ms) && 'above the window',
    ].filter(Boolean);
    if (flags.length > 0) parts.push(flags.join(', '));
    return parts.join(' · ');
  };

  return {
    backgroundColor: 'transparent',
    textStyle: { color: tokens.fg },
    grid,
    // Only the names: each driver has two series (the line and the triangles) under one entry. 36 px shows a dash.
    legend: { top: 0, data: drivers.map((d) => plain(d.acronym)), itemWidth: 36, textStyle: { color: tokens.fg } },
    xAxis: lapAxis(last, tokens),
    yAxis: {
      type: 'value' as const,
      scale: true,
      ...range,
      // Whole-second ticks, labelled "1:33".
      axisLabel: { color: tokens.muted, formatter: (v: number) => fmtLap(Math.round(v / 1000) * 1000).slice(0, -4) },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    // "Lap 12", then one line per driver in pick order.
    tooltip: tooltip(tokens, (i) => [`Lap ${i + 1}`, ...drivers.map((d) => line(d, i + 1))]),
    series: [...lines, ...triangles],
  };
}
