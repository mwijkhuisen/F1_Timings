import type { Lap } from '@f1/contracts';
import { fmtHm } from '../lib/time.ts';
import { compass, leaderLap, type RainPeriod, reading, type WeatherRow } from '../lib/weather.ts';
import { type ChartTokens, endLabel, grid, plain, tooltip } from './lap-chart-option.ts';

// The weather chart's ECharts option (P5a, A§13). Pure: no ECharts import at runtime, no HTML. Air and track
// temperature on one °C axis over Amsterdam time, rain as bands, the rest in a rich-text tooltip.

/** A band reaches half a sample (about a minute apart) past its first and last wet sample, so one sample shows. */
export const HALF_SAMPLE_MS = 30_000;

export type WeatherChartView = {
  periods: readonly RainPeriod[];
  /** The laps already loaded, for the leader's lap in a race; null while they load. */
  laps: readonly Pick<Lap, 'lap_number' | 'date_start'>[] | null;
  type: string | null;
};

const shown = (v: number | null, digits: number, unit: string) => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`);

/** The rain bands, on a data-less series of their own: silent, and out of the legend and the tooltip. */
const rainSeries = (periods: readonly RainPeriod[], tokens: ChartTokens) =>
  periods.length === 0
    ? []
    : [
        {
          type: 'line' as const,
          color: tokens.rain,
          data: [],
          silent: true,
          tooltip: { show: false },
          markArea: {
            silent: true,
            itemStyle: { color: tokens.rain, opacity: 0.2 },
            data: periods.map((p) => [{ xAxis: p.from - HALF_SAMPLE_MS }, { xAxis: p.to + HALF_SAMPLE_MS }]),
          },
        },
      ];

export function weatherChartOption(samples: readonly WeatherRow[], tokens: ChartTokens, view: WeatherChartView) {
  // A dropout (a 0 temperature) is no reading, so it breaks the line instead of dropping it to 0 (lib/weather.ts).
  const rows = samples.map(reading);
  const t = rows.map((r) => Date.parse(r.date));
  const race = view.type === 'Race' && view.laps !== null && view.laps.length > 0;
  const first = t.length > 0 ? Math.min(...t) : 0;
  const last = t.length > 0 ? Math.max(...t) : 0;

  // Two line types, so colour is never the only cue: air solid, track dashed (owner, 2026-11-07).
  const line = (name: string, color: string, type: 'solid' | 'dashed', value: (r: WeatherRow) => number | null) => ({
    type: 'line' as const,
    name,
    color,
    lineStyle: { type, width: 2 },
    symbol: 'none',
    showAllSymbol: true,
    data: rows.map((r, i) => [t[i], value(r)]),
    connectNulls: false,
    clip: true,
    ...endLabel(name, tokens),
  });

  // The time, both temperatures, humidity, wind, rain and, in a race, the leader's lap. Every line is stripped of
  // rich-text markup, so no data string can open a style.
  const lines = (i: number): string[] => {
    const r = rows[i];
    if (!r) return [];
    const wind = [r.wind_speed === null ? '—' : `${r.wind_speed.toFixed(1)} m/s`];
    if (r.wind_direction !== null) wind.push(compass(r.wind_direction));
    const out = [
      fmtHm(t[i] ?? 0),
      `Air ${shown(r.air_temperature, 1, '°C')} · Track ${shown(r.track_temperature, 1, '°C')}`,
      `Humidity ${shown(r.humidity, 0, '%')}`,
      `Wind ${wind.join(' ')}`,
      r.rainfall === null ? 'Rain —' : r.rainfall > 0 ? 'Rain' : 'Dry',
    ];
    if (race && view.laps) {
      const lap = leaderLap(view.laps, t[i] ?? 0, view.type);
      out.push(lap === null ? 'Before the start' : `Lap ${lap}`);
    }
    return out.map(plain);
  };

  return {
    backgroundColor: 'transparent',
    // Ticks fall on round UTC minutes and hours, which are round in Amsterdam too (a whole-hour offset); the labels
    // are Amsterdam time through lib/time.ts, whatever the browser's zone.
    useUTC: true,
    textStyle: { color: tokens.fg },
    grid: { ...grid, right: 56 },
    legend: { top: 0, data: ['Air', 'Track'], itemWidth: 36, textStyle: { color: tokens.fg } },
    xAxis: {
      type: 'time' as const,
      min: first - HALF_SAMPLE_MS,
      max: last + HALF_SAMPLE_MS,
      axisLine: { lineStyle: { color: tokens.line } },
      axisLabel: { color: tokens.muted, hideOverlap: true, formatter: (v: number) => fmtHm(v) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      scale: true,
      minInterval: 1,
      axisLabel: { color: tokens.muted, formatter: (v: number) => `${v} °C` },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    tooltip: tooltip(tokens, lines),
    series: [
      line('Air', tokens.fg, 'solid', (r) => r.air_temperature),
      line('Track', tokens.muted, 'dashed', (r) => r.track_temperature),
      ...rainSeries(view.periods, tokens),
    ],
  };
}
