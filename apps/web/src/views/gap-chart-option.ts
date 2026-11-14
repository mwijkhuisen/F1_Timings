import { type CrossLap, gapFromCrossings } from '../lib/crossings.ts';
import type { Driver } from '../lib/session.ts';
import { fmtDelta } from '../lib/time.ts';
import type { Period } from '../lib/track.ts';
import {
  bandSeries,
  type ChartTokens,
  endLabel,
  grid,
  lapAxis,
  lineStyles,
  plain,
  tooltip,
} from './lap-chart-option.ts';

// The gap chart (P4f): each other driver's gap to the reference, after each lap, from the times they cross the line.
// Pure: no ECharts import at runtime, no HTML.

const fmtSeconds = (v: number) => (v === 0 ? '0' : `${v < 0 ? '−' : '+'}${Math.abs(v)}`);

/**
 * The chart's accessible name (#102), each other driver's last known gap: "Gap to VER: NOR +3.2 s at lap 57, PER no
 * gap", so how the gap ended is readable without the canvas.
 */
export function gapChartLabel(drivers: readonly Driver[], laps: readonly CrossLap[]): string {
  const [ref, ...others] = drivers;
  if (!ref) return '';
  const lapsOf = (d: Driver) => laps.filter((l) => l.driver_number === d.number);
  const ends = others.map((d) => {
    const gaps = gapFromCrossings(lapsOf(ref), lapsOf(d));
    const i = gaps.findLastIndex((g) => g !== null);
    const g = gaps[i];
    return `${d.acronym} ${g == null ? 'no gap' : `${fmtDelta(g, 1)} s at lap ${i + 1}`}`;
  });
  return `Gap to ${ref.acronym}: ${ends.join(', ')}`;
}

export function gapChartOption(
  drivers: readonly Driver[],
  laps: readonly CrossLap[],
  tokens: ChartTokens,
  periods: readonly Period[],
) {
  const [ref, ...others] = drivers;
  const lapsOf = (d: Driver) => laps.filter((l) => l.driver_number === d.number);
  const refLaps = ref ? lapsOf(ref) : [];
  const gaps = others.map((d) => gapFromCrossings(refLaps, lapsOf(d)));
  const picked = new Set(drivers.map((d) => d.number));
  const last = laps.reduce((n, l) => (picked.has(l.driver_number) ? Math.max(n, l.lap_number) : n), 0);
  // The styles of the whole pick, so a driver keeps its lap-chart line.
  const styles = lineStyles(drivers, tokens).slice(1);

  const series = others.map((d, i) => {
    const { color, type } = styles[i] as (typeof styles)[number];
    const name = plain(d.acronym);
    return {
      type: 'line' as const,
      name,
      color,
      lineStyle: { type },
      symbol: 'none',
      showAllSymbol: true,
      // Dense [lap, s] up to the last lap of the pick, so the tooltip's data index is the lap; y is in seconds.
      data: Array.from({ length: last }, (_, n) => {
        const g = gaps[i]?.[n];
        return [n + 1, g == null ? null : g / 1000];
      }),
      connectNulls: false,
      clip: true,
      ...endLabel(name, tokens),
    };
  });

  return {
    backgroundColor: 'transparent',
    textStyle: { color: tokens.fg },
    grid,
    legend: { top: 0, data: series.map((s) => s.name), itemWidth: 36, textStyle: { color: tokens.fg } },
    xAxis: lapAxis(last, tokens),
    yAxis: {
      type: 'value' as const,
      scale: true,
      axisLabel: { color: tokens.muted, formatter: fmtSeconds },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    // "Lap 34", then "RUS +3.2 s" per other driver.
    tooltip: tooltip(tokens, (i) => [
      `Lap ${i + 1}`,
      ...others.map((d, k) => {
        const g = gaps[k]?.[i];
        return `${plain(d.acronym)} ${g == null ? '—' : `${fmtDelta(g, 1)} s`}`;
      }),
    ]),
    series: [...series, ...bandSeries(periods, tokens)],
  };
}
