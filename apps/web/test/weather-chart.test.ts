import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { describe, expect, it } from 'vitest';
import { init } from '../src/lib/echarts.ts';
import { rainPeriods, type WeatherRow } from '../src/lib/weather.ts';
import type { ChartTokens } from '../src/views/lap-chart-option.ts';
import { HALF_SAMPLE_MS, weatherChartOption } from '../src/views/weather-chart-option.ts';
import { lap } from './laps.ts';

// views/weather-chart-option.ts (P5a): two line types, rain bands, the tooltip, and an SVG render at 390 px.

const tokens: ChartTokens = {
  fg: '#f0f0f5',
  muted: '#a3a3b2',
  line: '#30303d',
  bg: '#15151e',
  amber: '#ffb020',
  live: '#ff6b6b',
  rain: '#4da6ff',
  light: false,
};
const T0 = Date.parse('2024-11-03T15:00:00Z'); // 16:00 in Amsterdam (CET)
const MIN = 60_000;
/** An hour of samples a minute apart; rain from minute 10 to 14 and at minute 40. */
const rows: WeatherRow[] = Array.from({ length: 61 }, (_, m) => ({
  date: new Date(T0 + m * MIN).toISOString(),
  air_temperature: 22 + m / 30,
  track_temperature: m === 30 ? null : 27 + m / 10,
  humidity: 86,
  pressure: 927.4,
  rainfall: (m >= 10 && m <= 14) || m === 40 ? 1 : 0,
  wind_direction: 191,
  wind_speed: 0.4,
}));
const periods = rainPeriods(rows);
// The race's leader starts lap n at minute 20 + 2n.
const laps = Array.from({ length: 10 }, (_, i) =>
  lap(1, i + 1, { date_start: new Date(T0 + (20 + 2 * (i + 1)) * MIN).toISOString() }),
);
const race = weatherChartOption(rows, tokens, { periods, laps, type: 'Race' });
const quali = weatherChartOption(rows, tokens, { periods, laps, type: 'Qualifying' });

type Series = { name?: string; lineStyle?: { type: string }; data: unknown[]; markArea?: { data: unknown[] } };
const seriesOf = (o: typeof race) => o.series as Series[];
type Formatter = (p: { dataIndex: number }[]) => string;
const tip = (o: typeof race, i: number) => (o.tooltip.formatter as Formatter)([{ dataIndex: i }]);

describe('weatherChartOption', () => {
  it('draws air solid and track dashed, so colour is never the only cue, on a time axis with UTC ticks', () => {
    const [air, track] = seriesOf(race);
    expect([air?.name, air?.lineStyle?.type]).toEqual(['Air', 'solid']);
    expect([track?.name, track?.lineStyle?.type]).toEqual(['Track', 'dashed']);
    expect(race.legend.data).toEqual(['Air', 'Track']);
    expect(race.xAxis.type).toBe('time');
    expect(race.useUTC).toBe(true);
    expect(race.xAxis.min).toBe(T0 - HALF_SAMPLE_MS);
    expect(race.xAxis.max).toBe(T0 + 60 * MIN + HALF_SAMPLE_MS);
  });

  it('plots [ms, °C] pairs; a missing value is null and breaks the line', () => {
    const [air, track] = seriesOf(race);
    expect(air?.data[0]).toEqual([T0, 22]);
    expect(track?.data[30]).toEqual([T0 + 30 * MIN, null]);
  });

  it('labels the axis in Amsterdam time, HH:mm, and the temperatures in °C', () => {
    const fmt = race.xAxis.axisLabel.formatter as (v: number) => string;
    expect(fmt(T0)).toBe('16:00');
    expect((race.yAxis.axisLabel.formatter as (v: number) => string)(25)).toBe('25 °C');
  });

  it('bands each rain period half a sample past its first and last wet sample, on its own silent series', () => {
    const bands = seriesOf(race).filter((s) => s.markArea);
    expect(bands).toHaveLength(1);
    expect(bands[0]?.data).toEqual([]);
    expect(bands[0]?.markArea?.data).toEqual([
      [{ xAxis: T0 + 10 * MIN - HALF_SAMPLE_MS }, { xAxis: T0 + 14 * MIN + HALF_SAMPLE_MS }],
      [{ xAxis: T0 + 40 * MIN - HALF_SAMPLE_MS }, { xAxis: T0 + 40 * MIN + HALF_SAMPLE_MS }],
    ]);
    expect(seriesOf(weatherChartOption(rows, tokens, { periods: [], laps, type: 'Race' }))).toHaveLength(2);
  });

  it('puts the time, both temperatures, humidity, wind and rain in the tooltip; the lap in a race only', () => {
    expect(tip(race, 12)).toBe(
      ['16:12', 'Air 22.4 °C · Track 28.2 °C', 'Humidity 86 %', 'Wind 0.4 m/s S', 'Rain', 'Before the start'].join(
        '\n',
      ),
    );
    expect(tip(race, 30).split('\n').slice(1, 2)).toEqual(['Air 23.0 °C · Track —']);
    expect(tip(race, 31).split('\n').at(-1)).toBe('Lap 5');
    expect(tip(race, 60).split('\n').at(-1)).toBe('Lap 10'); // after the flag: the last lap
    expect(tip(quali, 31)).not.toMatch(/Lap|Before the start/);
    expect(tip(weatherChartOption(rows, tokens, { periods, laps: null, type: 'Race' }), 31)).not.toMatch(/Lap/);
  });

  it('strips rich-text markup {|} from every tooltip line', () => {
    // No weather value is a string, so a data string can only arrive through a broken row: it is still stripped.
    const odd = [{ ...rows[0], wind_speed: { toFixed: () => '{a|1}' } as unknown as number } as WeatherRow];
    const text = tip(weatherChartOption(odd, tokens, { periods: [], laps, type: 'Race' }), 0);
    expect(text).toContain('Wind a1 m/s');
    expect(text).not.toMatch(/[{|}]/);
    for (let i = 0; i < rows.length; i++) expect(tip(race, i)).not.toMatch(/[{|}]/);
  });

  it('uses a rich-text tooltip, never HTML', () => {
    expect(race.tooltip.renderMode).toBe('richText');
  });
});

describe('the weather chart at 390 px', () => {
  use([SVGRenderer]);
  type Drawn = { type: string; style: { text?: string; fill?: string; opacity?: number } };
  const draw = (o: object) => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 390, height: 300 });
    try {
      chart.setOption({ ...o, animation: false });
      return chart
        .getZr()
        .storage.getDisplayList()
        .map((el) => el as unknown as Drawn);
    } finally {
      chart.dispose();
    }
  };
  const drawn = draw(race);
  const texts = drawn.map((e) => e.style.text).filter((t): t is string => typeof t === 'string');

  it('labels the time axis in Amsterdam HH:mm on round minutes, whatever the zone the test runs in', () => {
    const times = texts.filter((t) => /^\d\d:\d\d$/.test(t));
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (const t of times) {
      const [h, m] = t.split(':').map(Number) as [number, number];
      expect(h).toBeGreaterThanOrEqual(16);
      expect(h).toBeLessThanOrEqual(17);
      expect(m % 5).toBe(0);
    }
  });

  it('draws both end labels and the two rain bands in --rain at 20 %', () => {
    expect(texts).toEqual(expect.arrayContaining(['Air', 'Track']));
    const bands = drawn.filter((e) => e.type === 'polygon');
    expect(bands.map((e) => [e.style.fill, e.style.opacity])).toEqual([
      [tokens.rain, 0.2],
      [tokens.rain, 0.2],
    ]);
  });
});
