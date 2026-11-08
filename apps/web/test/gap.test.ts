import { describe, expect, it } from 'vitest';
import type { Driver } from '../src/lib/session.ts';
import { gapChartOption, gapFromCrossings } from '../src/views/gap-chart-option.ts';
import type { ChartTokens } from '../src/views/lap-chart-option.ts';

// The gap chart (P4f): gaps from the times each driver crosses the line, never interpolated.

const T0 = Date.parse('2026-10-25T20:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

type GapLap = { driver_number: number; lap_number: number; date_start: string | null; lap_ms: number | null };
/** Laps from their start times in seconds after T0 (null: unknown) and lap times in seconds (null: none). */
const run = (driver_number: number, starts: (number | null)[], times: (number | null)[]): GapLap[] =>
  starts.map((s, i) => ({
    driver_number,
    lap_number: i + 1,
    date_start: s === null ? null : at(s),
    lap_ms: times[i] == null ? null : (times[i] as number) * 1000,
  }));

// The reference laps at 90 s from T0 + 0.
const ref = run(1, [0, 90, 180, 270, 360], [90, 90, 90, 90, 90]);

describe('gapFromCrossings', () => {
  it('takes the next lap’s start as the crossing, and the last lap’s start + time at the end', () => {
    // 1 s behind from the start, then 0.5 s a lap more.
    const other = run(4, [1, 91.5, 182, 272.5, 363], [90.5, 90.5, 90.5, 90.5, 90.5]);
    expect(gapFromCrossings(ref, other)).toEqual([1500, 2000, 2500, 3000, 3500]);
  });

  it('breaks the line at a missing lap', () => {
    // No lap 3 row, and lap 2 without a time: nothing tells when lap 2 ended. Lap 3 ends at lap 4's start.
    const other = run(4, [1, 92, 183, 274, 365], [91, null, 91, 91, 91]).filter((l) => l.lap_number !== 3);
    expect(gapFromCrossings(ref, other)).toEqual([2000, null, 4000, 5000, 6000]);
  });

  it('reads pit laps (in and out, without a lap time) from the starts', () => {
    // Lap 2 is the in-lap and lap 3 the out-lap, both without lap_ms: their crossings are the next starts.
    const other = run(4, [1, 92, 205, 296, 387], [91, null, null, 91, 91]);
    expect(gapFromCrossings(ref, other)).toEqual([2000, 25000, 26000, 27000, 28000]);
  });

  it('falls back to date_start + lap_ms when the next start is unknown', () => {
    const other = run(4, [1, 92, null, 274, 365], [91, 91, 91, 91, 91]);
    // Lap 2: no lap-3 start, and lap 2's own start + time is 183 → 3 s. Lap 3: no start, its crossing is lap 4's start.
    expect(gapFromCrossings(ref, other)).toEqual([2000, 3000, 4000, 5000, 6000]);
    // Neither: null, never interpolated.
    const bare = run(4, [1, null, null, 274], [91, null, 91, 91]);
    expect(gapFromCrossings(ref, bare)).toEqual([2000, null, 4000, 5000]);
  });

  it('shows a lapped driver over one lap behind, ending at its own last lap', () => {
    // 100 s laps against 90 s: after 4 laps it is 40 s down, the race ends while it is on lap 5.
    const slow = run(4, [0, 100, 200, 300], [100, 100, 100, 100]);
    const long = run(1, [0, 90, 180, 270, 360, 450, 540, 630, 720, 810], Array(10).fill(90));
    expect(gapFromCrossings(long, slow)).toEqual([10000, 20000, 30000, 40000]);
    // Past one lap (90 s) once the slow laps add up: 10 laps of 100 s against 90 s.
    const slower = run(
      4,
      Array.from({ length: 10 }, (_, i) => i * 100),
      Array(10).fill(100),
    );
    const longer = run(
      1,
      Array.from({ length: 11 }, (_, i) => i * 90),
      Array(11).fill(90),
    );
    expect(gapFromCrossings(longer, slower).at(-1)).toBe(100000);
    // A reference with fewer laps gives null past its own last lap.
    expect(gapFromCrossings(slow, long).slice(4)).toEqual(Array(6).fill(null));
  });
});

const tokens: ChartTokens = {
  fg: '#f0f0f5',
  muted: '#9b9ba8',
  line: '#34343f',
  bg: '#15151e',
  amber: '#ffb020',
  live: '#ff6b6b',
  light: false,
};
const driver = (number: number, acronym: string, team: string | null): Driver => ({
  number,
  acronym,
  name: null,
  team,
});
const VER = driver(1, 'VER', '#3671C6');
const PER = driver(11, 'PER', '#3671C6');
const NOR = driver(4, 'NOR', '#FF8000');

describe('gapChartOption', () => {
  const laps = [
    ...ref,
    ...run(4, [1, 91.5, 182, 272.5, 363], [90.5, 90.5, 90.5, 90.5, 90.5]),
    ...run(11, [2, 92, 182], [90, 90, null]),
  ];
  const option = gapChartOption([VER, NOR, PER], laps, tokens, [{ kind: 'vsc', from: 3, to: 3 }]);
  const lines = option.series.filter((s) => 'endLabel' in s);

  it('draws one line per other driver, in seconds, with the lap chart’s styles and end labels', () => {
    expect(lines.map((s) => [s.name, s.color, s.lineStyle.type])).toEqual([
      ['NOR', '#FF8000', 'solid'],
      // PER is VER's teammate: dashed, as on the lap chart.
      ['PER', '#3671C6', 'dashed'],
    ]);
    expect(option.series[0]?.data).toEqual([
      [1, 1.5],
      [2, 2],
      [3, 2.5],
      [4, 3],
      [5, 3.5],
    ]);
    // PER stops after lap 3, which has no time: null, padded to the last lap.
    expect(option.series[1]?.data).toEqual([
      [1, 2],
      [2, 2],
      [3, null],
      [4, null],
      [5, null],
    ]);
    for (const s of lines)
      expect(s).toMatchObject({
        symbol: 'none',
        connectNulls: false,
        endLabel: { show: true, formatter: s.name, color: tokens.fg },
        labelLayout: { moveOverlap: 'shiftY' },
      });
    expect(option.xAxis).toMatchObject({ type: 'value', min: 0.5, max: 5.5 });
    expect(option.legend.data).toEqual(['NOR', 'PER']);
  });

  it('bands the periods on a data-less series of their own, out of the legend, as the lap chart', () => {
    const [, , band] = option.series;
    expect(option.series).toHaveLength(3);
    expect(band).toMatchObject({ type: 'line', data: [], silent: true, tooltip: { show: false } });
    expect(band && 'markArea' in band && band.markArea.data).toEqual([
      [{ name: 'VSC', xAxis: 2.5, itemStyle: { color: tokens.amber, opacity: 0.15 } }, { xAxis: 3.5 }],
    ]);
    expect(option.series.slice(0, 2).some((s) => 'markArea' in s)).toBe(false);
  });

  it('labels the y-axis "+10", "0", "−10" and the tooltip "RUS +3.2 s"', () => {
    const f = option.yAxis.axisLabel.formatter;
    expect([f(10), f(0), f(-10)]).toEqual(['+10', '0', '−10']);
    expect(option.tooltip.formatter([{ dataIndex: 2 }])).toBe('Lap 3\nNOR +2.5 s\nPER —');
    expect(option.tooltip.formatter({ dataIndex: 0 })).toBe('Lap 1\nNOR +1.5 s\nPER +2.0 s');
  });
});
