import type { Lap } from '@f1/contracts';
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

type GapLap = Pick<Lap, 'driver_number' | 'lap_number' | 'date_start' | 'lap_ms'>;

/**
 * When a driver crossed the line after each of its laps, in epoch ms: lap n+1's `date_start`, else lap n's
 * `date_start + lap_ms`, else null. `date_start` is approximate (A§6.1); on the dev DB it is null only on lap 1
 * (6 of 525 laps) and agrees with the previous start + lap time to a median of 51 ms.
 */
function crossings(laps: readonly GapLap[]): (number | null)[] {
  const start = new Map<number, number>();
  const time = new Map<number, number>();
  let last = 0;
  for (const l of laps) {
    last = Math.max(last, l.lap_number);
    if (l.date_start !== null) start.set(l.lap_number, Date.parse(l.date_start));
    if (l.lap_ms !== null) time.set(l.lap_number, l.lap_ms);
  }
  return Array.from({ length: last }, (_, i) => {
    const next = start.get(i + 2);
    if (next !== undefined) return next;
    const s = start.get(i + 1);
    const t = time.get(i + 1);
    return s !== undefined && t !== undefined ? s + t : null;
  });
}

/**
 * The driver's gap to the reference after each of its laps, in ms (index n − 1 for lap n): its crossing − the
 * reference's crossing at the same lap count, so a lapped driver shows a gap over one lap. Nothing is interpolated:
 * null where either crossing is unknown, which breaks the line.
 */
export function gapFromCrossings(reference: readonly GapLap[], driver: readonly GapLap[]): (number | null)[] {
  const ref = crossings(reference);
  return crossings(driver).map((c, i) => {
    const r = ref[i];
    return c === null || r == null ? null : c - r;
  });
}

const fmtSeconds = (v: number) => (v === 0 ? '0' : `${v < 0 ? '−' : '+'}${Math.abs(v)}`);

export function gapChartOption(
  drivers: readonly Driver[],
  laps: readonly GapLap[],
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
