import type { Telemetry } from '@f1/contracts';
import type { Driver } from '../lib/session.ts';
import { type ChartTokens, lineStyles, plain, tooltip } from './lap-chart-option.ts';

// The telemetry card's traces (P7c, A§13): two laps' speed, throttle, brake and gear, and a DRS strip, along each
// car's own Position path (T3). Pure: no ECharts import at runtime, no HTML.

/** A gap between two samples over this breaks the line (T3); a longer Position step places no car sample (E2). */
export const GAP_MS = 1500;

/** The feed's "no value" for throttle and brake (A§6.2): null in those two series, the sample's speed and gear kept. */
const SENTINEL = 104;
/** FastF1's "open" DRS values, a reference only (E3). */
const DRS_OPEN = new Set([10, 12, 14]);

const at = (a: readonly number[], i: number) => a[i] as number;

/**
 * E2: each car sample's metres along the lap's own Position path (2D, X/Y in 0.1 m) from its first Position sample,
 * linear in time between the two Position samples around it when they are at most GAP_MS apart; null outside the
 * Position span or inside a longer step (nothing is extrapolated). Fewer than 2 Position samples place nothing.
 */
export function distances(t: Telemetry): (number | null)[] {
  const { t: pt, x, y } = t.pos;
  const last = pt.length - 1;
  if (last < 1) return t.car.t.map(() => null);
  const cum = [0];
  for (let j = 1; j <= last; j++)
    cum.push(at(cum, j - 1) + Math.hypot(at(x, j) - at(x, j - 1), at(y, j) - at(y, j - 1)) * 0.1);
  let j = 0;
  return t.car.t.map((tc) => {
    if (tc < at(pt, 0) || tc > at(pt, last)) return null;
    // Both are sorted: the step only moves forward.
    while (j < last - 1 && at(pt, j + 1) < tc) j++;
    // A sample on a Position sample is placed there, even beside a long step.
    if (tc === at(pt, j + 1)) return at(cum, j + 1);
    if (tc === at(pt, j)) return at(cum, j);
    const dt = at(pt, j + 1) - at(pt, j);
    if (dt > GAP_MS) return null;
    return at(cum, j) + ((at(cum, j + 1) - at(cum, j)) * (tc - at(pt, j))) / dt;
  });
}

/**
 * The drawn points of a lap: `{x, i}` per placed car sample (i is its car index), and null for a break, where the
 * car samples are more than GAP_MS apart or an unplaced sample lies between.
 */
export function tracePoints(t: Telemetry): ({ x: number; i: number } | null)[] {
  const out: ({ x: number; i: number } | null)[] = [];
  let prev = -1;
  distances(t).forEach((x, i) => {
    if (x === null) return;
    if (prev >= 0 && (i !== prev + 1 || at(t.car.t, i) - at(t.car.t, prev) > GAP_MS)) out.push(null);
    out.push({ x, i });
    prev = i;
  });
  return out;
}

/** `name`: "VER L41". */
export type TraceLap = { name: string; driver: Driver; telemetry: Telemetry };

/** The chart's accessible name. */
export const traceLabel = (laps: readonly TraceLap[]): string =>
  `Telemetry: ${laps.map((l) => l.name).join(', ')}: speed, throttle, brake and gear by distance`;

const metres = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** E3: the strip only for a lap with the DRS channel, in a session up to 2025 (never 2026). */
const hasDrs = (l: TraceLap, year: number) => l.telemetry.car.drs !== null && year <= 2025;

/**
 * Stacked grids on one distance range: speed, throttle, brake, gear and (E3) the DRS strip, each lap on every grid
 * in its `lineStyles` colour, Lap 1 solid and Lap 2 dashed (E4). A break is an `[x, null]` item; nothing is thinned.
 */
export function traceChartOption(laps: readonly TraceLap[], tokens: ChartTokens, year: number) {
  const points = laps.map((l) => tracePoints(l.telemetry));
  // Per lap, the car index behind each data item; a break item stands at the previous point, so it shows that sample.
  const index = points.map((ps) => {
    let i = 0;
    return ps.map((p) => {
      if (p !== null) i = p.i;
      return i;
    });
  });
  const colours = lineStyles(
    laps.map((l) => l.driver),
    tokens,
  ).map((s) => s.color);
  const names = laps.map((l) => plain(l.name));
  const drs = laps.flatMap((l, k) => (hasDrs(l, year) ? [k] : []));
  const end = points.reduce((m, ps) => Math.max(m, ps.findLast((p) => p !== null)?.x ?? 0), 0);
  const max = Math.max(100, Math.ceil(end / 100) * 100);

  // Each grid's top and bottom in % of the height, under the legend and above the distance labels. Fixed left and
  // right margins, never shrunk to fit a label, so every grid's plot spans the same pixels.
  const panels = drs.length > 0 ? [0, 40, 42, 57, 59, 69, 71, 84, 86, 100] : [0, 44, 46, 63, 65, 76, 78, 100];
  const bottom = panels.length / 2 - 1;
  const grids = Array.from({ length: bottom + 1 }, (_, g) => ({
    left: 56,
    right: 24,
    top: g === 0 ? 32 : `${panels[2 * g]}%`,
    bottom: g === bottom ? 28 : `${100 - (panels[2 * g + 1] as number)}%`,
    outerBoundsMode: 'none' as const,
  }));
  const xAxis = grids.map((_, g) => ({
    type: 'value' as const,
    gridIndex: g,
    min: 0,
    max,
    axisLine: { lineStyle: { color: tokens.line } },
    axisTick: { show: g === bottom },
    axisLabel: {
      show: g === bottom,
      color: tokens.muted,
      formatter: (v: number) => `${metres.format(v)} m`,
      alignMinLabel: 'left' as const,
      alignMaxLabel: 'right' as const,
    },
    splitLine: { lineStyle: { color: tokens.line } },
  }));
  const value = (g: number, name: string, extra: object) => ({
    type: 'value' as const,
    gridIndex: g,
    name,
    nameLocation: 'middle' as const,
    nameGap: 36,
    nameTextStyle: { color: tokens.muted },
    axisLabel: { color: tokens.muted },
    splitLine: { lineStyle: { color: tokens.line } },
    ...extra,
  });
  const yAxis: object[] = [
    value(0, 'km/h', { scale: true }),
    value(1, 'Throttle %', { min: 0, max: 100, interval: 50 }),
    value(2, 'Brake', { min: 0, max: 100, interval: 100 }),
    value(3, 'Gear', { min: 0, max: 8, interval: 4 }),
  ];
  if (drs.length > 0)
    yAxis.push({
      type: 'category' as const,
      gridIndex: 4,
      name: 'DRS',
      nameLocation: 'middle' as const,
      nameGap: 36,
      nameTextStyle: { color: tokens.muted },
      // One row per lap, Lap 1 on top; the colour and the line type name the lap, as on the other grids.
      data: drs.map((k) => names[k]),
      inverse: true,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
    });

  const line = (k: number, g: number, data: (number | null)[][], extra: object = {}) => ({
    type: 'line' as const,
    name: names[k],
    xAxisIndex: g,
    yAxisIndex: g,
    color: colours[k],
    lineStyle: { type: k === 0 ? ('solid' as const) : ('dashed' as const), width: 1.5 },
    symbol: 'none',
    connectNulls: false,
    clip: true,
    data,
    ...extra,
  });
  const lapOf: number[] = [];
  const series = laps.flatMap((l, k) => {
    const ps = points[k] ?? [];
    const car = l.telemetry.car;
    let x = 0;
    const of = (v: (i: number) => number | null) =>
      ps.map((p) => {
        if (p === null) return [x, null];
        x = p.x;
        return [p.x, v(p.i)];
      });
    const real = (a: readonly number[]) => (i: number) => (at(a, i) === SENTINEL ? null : at(a, i));
    const out = [
      line(
        k,
        0,
        of((i) => at(car.speed, i)),
      ),
      line(k, 1, of(real(car.throttle))),
      line(k, 2, of(real(car.brake)), { step: 'end' }),
      line(
        k,
        3,
        of((i) => at(car.gear, i)),
        { step: 'end' },
      ),
    ];
    const row = drs.indexOf(k);
    if (row >= 0 && car.drs !== null) {
      const open = car.drs;
      out.push(
        line(
          k,
          4,
          of((i) => (DRS_OPEN.has(at(open, i)) ? row : null)),
          { lineStyle: { width: 6 } },
        ),
      );
    }
    lapOf.push(...out.map(() => k));
    return out;
  });

  const sample = (k: number, i: number) => {
    const car = (laps[k] as TraceLap).telemetry.car;
    const pct = (word: string, v: number) => (v === SENTINEL ? `${word} —` : `${word} ${v} %`);
    const brake = at(car.brake, i);
    const parts = [
      pct('throttle', at(car.throttle, i)),
      brake === SENTINEL ? 'brake —' : brake === 0 ? null : brake === 100 ? 'brake' : `brake ${brake} %`,
      drs.includes(k) && car.drs !== null ? (DRS_OPEN.has(at(car.drs, i)) ? 'DRS open' : 'DRS closed') : null,
    ];
    return [
      `${names[k]} ${at(car.speed, i)} km/h · gear ${at(car.gear, i)}`,
      parts.filter((p) => p !== null).join(' · '),
    ];
  };

  type Param = { seriesIndex: number; dataIndex: number; axisValue?: number };
  return {
    backgroundColor: 'transparent',
    textStyle: { color: tokens.fg },
    grid: grids,
    legend: { top: 0, data: names, itemWidth: 36, textStyle: { color: tokens.fg } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis,
    yAxis,
    // "1,240 m", then per lap its speed and gear, then throttle, brake and (with the strip) DRS; "—" off its range.
    tooltip: {
      ...tooltip(tokens, () => []),
      formatter: (params: Param | Param[]) => {
        const list = Array.isArray(params) ? params : [params];
        const [first] = list;
        if (!first) return '';
        const lines = [`${metres.format(first.axisValue ?? 0)} m`];
        laps.forEach((_, k) => {
          const p = list.find((q) => lapOf[q.seriesIndex] === k);
          const i = p && index[k]?.[p.dataIndex];
          lines.push(...(i === undefined ? [`${names[k]} —`] : sample(k, i)));
        });
        return lines.join('\n');
      },
    },
    series,
  };
}
