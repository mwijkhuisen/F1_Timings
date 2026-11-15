import type { Evolution } from '../lib/evolution.ts';
import { fmtHm, fmtLap } from '../lib/time.ts';
import { type ChartTokens, grid, plain, tooltip } from './lap-chart-option.ts';

// The track evolution chart's ECharts option (#114, A§13). Pure: no ECharts import at runtime, no HTML. Each timed lap
// is a dot at its start, the running best a step line, the phases (qualifying) or red flags (practice) bands.

/** The y window in ms: 1 s under the fastest valid lap, floored to a second, up to 107 % of it, ceiled to a second. */
export type EvolutionWindow = { min: number; max: number; above: number; below: number };

/** Null when no valid (non-deleted) lap has a time; `above` and `below` count the laps outside it. */
export function evolutionWindow(evo: Evolution): EvolutionWindow | null {
  const best = evo.steps.at(-1)?.ms;
  if (best === undefined) return null;
  const min = Math.floor((best - 1000) / 1000) * 1000;
  const max = Math.ceil((best * 1.07) / 1000) * 1000;
  return {
    min,
    max,
    above: evo.points.filter((p) => p.ms > max).length,
    below: evo.points.filter((p) => p.ms < min).length,
  };
}

/** `name` is a driver's acronym by number. */
export function evolutionChartOption(evo: Evolution, tokens: ChartTokens, name: (driver: number) => string) {
  const window = evolutionWindow(evo);
  const times = [...evo.points.map((p) => p.t), ...evo.bands.flatMap((b) => [b.from, b.to])];
  // Phases shade in two steps of --line, so neighbours differ; a red flag is --live. Colour is never the only cue: the
  // band carries its label.
  const bands = evo.bands.map((b, i) => [
    {
      name: b.label,
      xAxis: b.from,
      itemStyle: b.red
        ? { color: tokens.live, opacity: 0.15 }
        : { color: tokens.line, opacity: i % 2 === 0 ? 0.5 : 0.25 },
    },
    { xAxis: b.to },
  ]);
  const line = (p: Evolution['points'][number]) =>
    `${fmtHm(p.t)} · ${plain(name(p.driver))} L${p.lap} ${fmtLap(p.ms)}${p.deleted ? ' · deleted' : ''}`;
  return {
    backgroundColor: 'transparent',
    // Round UTC minutes are round in Amsterdam too; the labels are Amsterdam time through lib/time.ts.
    useUTC: true,
    textStyle: { color: tokens.fg },
    grid,
    xAxis: {
      type: 'time' as const,
      min: times.length > 0 ? Math.min(...times) : undefined,
      max: times.length > 0 ? Math.max(...times) : undefined,
      axisLine: { lineStyle: { color: tokens.line } },
      axisLabel: { color: tokens.muted, hideOverlap: true, formatter: (v: number) => fmtHm(v) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      scale: true,
      ...(window ? { min: window.min, max: window.max, interval: 1000 } : { minInterval: 1000 }),
      axisLabel: { color: tokens.muted, formatter: (v: number) => fmtLap(Math.round(v / 1000) * 1000).slice(0, -4) },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    // One dot at a time: the nearest lap, not every series at an instant.
    tooltip: { ...tooltip(tokens, (i) => (evo.points[i] ? [line(evo.points[i])] : [])), trigger: 'item' as const },
    series: [
      {
        type: 'scatter' as const,
        name: 'Laps',
        color: tokens.muted,
        symbol: 'circle',
        symbolSize: 6,
        clip: true,
        // A deleted lap is a hollow ring. Not `emptyCircle`: ECharts fills that white, a disc on the dark theme.
        data: evo.points.map((p) =>
          p.deleted
            ? {
                value: [p.t, p.ms],
                symbol: 'circle',
                symbolSize: 10,
                itemStyle: { color: tokens.bg, borderColor: tokens.muted, borderWidth: 2 },
              }
            : [p.t, p.ms],
        ),
      },
      {
        type: 'line' as const,
        name: 'Best so far',
        color: tokens.fg,
        step: 'end' as const,
        symbol: 'none',
        lineStyle: { width: 2 },
        clip: true,
        silent: true,
        tooltip: { show: false },
        data: evo.steps.map((s) => [s.t, s.ms]),
      },
      ...(bands.length === 0
        ? []
        : [
            {
              type: 'line' as const,
              data: [],
              silent: true,
              tooltip: { show: false },
              markArea: { silent: true, label: { color: tokens.fg, position: 'insideTop' as const }, data: bands },
            },
          ]),
    ],
  };
}
