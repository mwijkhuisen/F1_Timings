import type { Lap } from '@f1/contracts';
import type { Driver } from '../lib/session.ts';
import { fmtLap } from '../lib/time.ts';

// The lap-time chart's ECharts option (D4, E2). Pure: no ECharts import at runtime, no HTML.

/** Theme colours, read from the CSS custom properties by LapChart. */
export type ChartTokens = { fg: string; muted: string; line: string; bg: string };

/** Rich-text markup (`{style|text}`) out of a data string: the tooltip and legend render rich text. */
const plain = (s: string) => s.replace(/[{|}]/g, '');

type ChartLap = Pick<Lap, 'driver_number' | 'lap_number' | 'lap_ms' | 'deleted' | 'colour'>;

export function lapChartOption(drivers: readonly Driver[], laps: readonly ChartLap[], tokens: ChartTokens) {
  const picked = new Set(drivers.map((d) => d.number));
  const mine = laps.filter((l) => picked.has(l.driver_number));
  const byKey = new Map(mine.map((l) => [`${l.driver_number}-${l.lap_number}`, l]));
  const last = mine.reduce((n, l) => Math.max(n, l.lap_number), 0);
  const lapNumbers = Array.from({ length: last }, (_, i) => i + 1);
  const at = (d: Driver, n: number) => byKey.get(`${d.number}-${n}`);

  // E2: the window runs from the fastest valid lap (the server's purple or green, A§9) to 107 % of it.
  let best = Number.POSITIVE_INFINITY;
  for (const l of mine)
    if (l.lap_ms !== null && (l.colour.lap === 'purple' || l.colour.lap === 'green')) best = Math.min(best, l.lap_ms);
  const range = Number.isFinite(best)
    ? { min: Math.floor((best - 1000) / 1000) * 1000, max: Math.ceil((best * 1.07) / 1000) * 1000 }
    : {};

  // Teammates share a team colour; the second line of a colour is dashed.
  const seen = new Set<string>();
  const series = drivers.map((d) => {
    const colour = d.team ?? tokens.muted;
    const dashed = seen.has(colour);
    seen.add(colour);
    return {
      type: 'line' as const,
      name: plain(d.acronym),
      color: colour,
      lineStyle: { type: dashed ? ('dashed' as const) : ('solid' as const) },
      symbol: 'circle',
      // Dense: a missing lap or a lap without a time is null, so the line breaks.
      data: lapNumbers.map((n) => {
        const l = at(d, n);
        if (l?.lap_ms == null) return null;
        return l.deleted ? { value: l.lap_ms, symbol: 'emptyCircle' } : l.lap_ms;
      }),
      connectNulls: false,
      clip: true,
    };
  });

  const line = (d: Driver, n: number) => {
    const l = at(d, n);
    const name = plain(d.acronym);
    if (l?.lap_ms == null) return `${name} —`;
    return `${name} ${fmtLap(l.lap_ms)}${l.deleted ? ' deleted' : ''}`;
  };

  return {
    backgroundColor: 'transparent',
    textStyle: { color: tokens.fg },
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: tokens.fg } },
    xAxis: {
      type: 'category' as const,
      data: lapNumbers,
      axisLine: { lineStyle: { color: tokens.line } },
      axisLabel: { color: tokens.muted },
    },
    yAxis: {
      type: 'value' as const,
      scale: true,
      ...range,
      axisLabel: { color: tokens.muted, formatter: (v: number) => fmtLap(v) },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    tooltip: {
      trigger: 'axis' as const,
      renderMode: 'richText' as const,
      confine: true,
      backgroundColor: tokens.bg,
      borderColor: tokens.line,
      textStyle: { color: tokens.fg },
      // Plain text: "Lap 12", then one line per driver in pick order.
      formatter: (params: { dataIndex: number } | { dataIndex: number }[]) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p) return '';
        const n = p.dataIndex + 1;
        return [`Lap ${n}`, ...drivers.map((d) => line(d, n))].join('\n');
      },
    },
    series,
  };
}
