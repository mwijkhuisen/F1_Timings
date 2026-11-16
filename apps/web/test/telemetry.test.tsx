// @vitest-environment happy-dom
import type { Telemetry } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { HttpResponse, http } from 'msw';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { REVISION } from '../src/lib/api.ts';
import { init } from '../src/lib/echarts.ts';
import { clampForLight, type Driver } from '../src/lib/session.ts';
import { Compare, Comparison } from '../src/views/Compare.tsx';
import type { ChartTokens } from '../src/views/lap-chart-option.ts';
import {
  distances,
  type TraceLap,
  traceChartOption,
  traceLabel,
  tracePoints,
} from '../src/views/trace-chart-option.ts';
import { lap, sessionDetail } from './laps.ts';

// P7c (A§13): the telemetry card's traces, on synthetic laps built here (never real or decoded telemetry, A§12.1).
// The chart's own canvas is stubbed in the mounted card tests: they are about what is asked and said, not drawn.
vi.mock('../src/views/Chart.tsx', () => ({
  Chart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));

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

type Car = Telemetry['car'];
/** A lap from its car and Position samples; the car channels default to a constant value per sample. */
const telemetry = (
  car: Partial<Omit<Car, 't'>> & { t: number[] },
  pos: { t: number[]; x: number[]; y: number[] },
): Telemetry => {
  const fill = (v: number) => car.t.map(() => v);
  return {
    source: 'f1-archive',
    date_start: '2019-07-14T13:10:00.000Z',
    top_kph: null,
    full_throttle: null,
    car: {
      t: car.t,
      rpm: car.rpm ?? fill(11000),
      speed: car.speed ?? fill(250),
      gear: car.gear ?? fill(7),
      throttle: car.throttle ?? fill(100),
      brake: car.brake ?? fill(0),
      drs: car.drs === undefined ? null : car.drs,
    },
    pos: { ...pos, z: pos.t.map(() => 0), status: pos.t.map(() => 'OnTrack' as const) },
  };
};

const VER: Driver = { number: 1, acronym: 'VER', name: null, team: '#3671C6' };
const NOR: Driver = { number: 4, acronym: 'NOR', name: null, team: '#FF8000' };

describe('distances (E2)', () => {
  // A square of 100 m sides, one corner a second (X/Y in 0.1 m).
  const square = { t: [0, 1000, 2000, 3000, 4000], x: [0, 1000, 1000, 0, 0], y: [0, 0, 1000, 1000, 0] };

  it('measures metres along the Position path from its first sample, linear in time within a step', () => {
    expect(distances(telemetry({ t: [0, 500, 1000, 2250, 4000] }, square))).toEqual([0, 50, 100, 225, 400]);
  });

  it('places nothing before the first or after the last Position sample: no extrapolation', () => {
    expect(distances(telemetry({ t: [-100, 0, 4000, 4100] }, square))).toEqual([null, 0, 400, null]);
  });

  it('places nothing inside a Position step over 1.5 s, and takes the chord across it', () => {
    const gap = { t: [0, 1000, 4000, 5000], x: [0, 1000, 2000, 3000], y: [0, 0, 0, 0] };
    expect(distances(telemetry({ t: [500, 1000, 2000, 4000, 4500] }, gap))).toEqual([50, 100, null, 200, 250]);
  });

  it('places nothing when the first Position sample comes over 1.5 s after the lap start: the zero is unknown', () => {
    const at = (t0: number) => ({ ...square, t: square.t.map((t) => t + t0) });
    expect(distances(telemetry({ t: [1500, 2000] }, at(1500)))).toEqual([0, 50]);
    expect(distances(telemetry({ t: [1600, 2100] }, at(1600)))).toEqual([null, null]);
  });

  it('places nothing with fewer than 2 Position samples', () => {
    expect(distances(telemetry({ t: [0, 500] }, { t: [0], x: [0], y: [0] }))).toEqual([null, null]);
    expect(tracePoints(telemetry({ t: [0, 500] }, { t: [], x: [], y: [] }))).toEqual([]);
  });
});

describe('tracePoints', () => {
  const straight = { t: [0, 1000, 2000, 3000], x: [0, 1000, 2000, 3000], y: [0, 0, 0, 0] };

  it('keeps the line over a car step of 1.4 s and breaks it over one of 1.6 s', () => {
    expect(tracePoints(telemetry({ t: [0, 1400, 2800] }, straight))).toEqual([
      { x: 0, i: 0 },
      { x: 140, i: 1 },
      { x: 280, i: 2 },
    ]);
    expect(tracePoints(telemetry({ t: [0, 1600, 2800] }, straight))).toEqual([
      { x: 0, i: 0 },
      null,
      { x: 160, i: 1 },
      { x: 280, i: 2 },
    ]);
  });

  it('breaks the line where an unplaced sample lies between two placed ones', () => {
    const gap = { t: [0, 1000, 4000, 5000], x: [0, 1000, 2000, 3000], y: [0, 0, 0, 0] };
    expect(tracePoints(telemetry({ t: [500, 1000, 2000, 2600, 4000, 4500] }, gap))).toEqual([
      { x: 50, i: 0 },
      { x: 100, i: 1 },
      null,
      { x: 200, i: 4 },
      { x: 250, i: 5 },
    ]);
  });
});

/**
 * A short lap on a straight at 0.1 m/ms (Position every 300 ms, X in 0.1 m), so a car sample at t ms sits at t / 10 m.
 * Car samples 1000 and 3000 ms are 2 s apart (a break); sample 1 is the 104 sentinel in throttle and brake.
 */
const DRS = [8, 10, 12, 14, 9, 8];
const short = (drs: number[] | null = DRS) =>
  telemetry(
    {
      t: [0, 250, 500, 750, 1000, 3000],
      speed: [100, 110, 120, 130, 140, 150],
      throttle: [100, 104, 50, 0, 0, 100],
      brake: [0, 104, 0, 100, 100, 0],
      gear: [3, 3, 4, 4, 5, 5],
      drs,
    },
    {
      t: Array.from({ length: 11 }, (_, k) => k * 300),
      x: Array.from({ length: 11 }, (_, k) => k * 300),
      y: Array.from({ length: 11 }, () => 0),
    },
  );
const lapsOf = (a: Telemetry, b: Telemetry, second: Driver = NOR): TraceLap[] => [
  { name: 'VER L41', driver: VER, telemetry: a, slot: 0 },
  { name: `${second.acronym} L38`, driver: second, telemetry: b, slot: 1 },
];

describe('traceChartOption', () => {
  const option = traceChartOption(lapsOf(short(), short(null)), tokens, 2019);
  type S = { name: string; xAxisIndex: number; color: string; lineStyle: { type?: string; width: number } };
  const series = option.series as unknown as (S & Record<string, unknown>)[];
  const on = (lap: string, grid: number) => series.find((s) => s.name === lap && s.xAxisIndex === grid);

  it('stacks the grids on one distance range from 0 to the longest lap rounded up to 100 m, labelled at the bottom', () => {
    expect(option.grid).toHaveLength(5);
    expect(option.xAxis).toHaveLength(5);
    for (const [g, x] of option.xAxis.entries()) {
      expect(x).toMatchObject({ type: 'value', gridIndex: g, min: 0, max: 300 });
      expect(x.axisLabel.show).toBe(g === 4);
    }
    expect(option.xAxis[4]?.axisLabel.formatter(1240)).toBe('1,240 m');
    expect(option.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] });
    expect(option.yAxis.map((y) => (y as { name: string }).name)).toEqual([
      'km/h',
      'Throttle %',
      'Brake',
      'Gear',
      'DRS',
    ]);
    const end = traceChartOption(lapsOf(short(), short()), tokens, 2019);
    // 300 m is already whole; 301 m rounds up to 400.
    const longer = telemetry({ t: [0, 3010] }, { t: [0, 1000, 3010], x: [0, 1000, 3010], y: [0, 0, 0] });
    expect(end.xAxis[0]?.max).toBe(300);
    expect(traceChartOption(lapsOf(short(), longer), tokens, 2019).xAxis[0]?.max).toBe(400);
  });

  it('draws one line per channel per lap, never thinned, never connected across a null, clipped', () => {
    // VER: speed, throttle, brake, gear and DRS; NOR (no DRS channel): the four.
    expect(series.map((s) => `${s.name} ${s.xAxisIndex}`)).toEqual([
      'VER L41 0',
      'VER L41 1',
      'VER L41 2',
      'VER L41 3',
      'VER L41 4',
      'NOR L38 0',
      'NOR L38 1',
      'NOR L38 2',
      'NOR L38 3',
    ]);
    for (const s of series) {
      expect(s).toMatchObject({ type: 'line', symbol: 'none', connectNulls: false, clip: true });
      expect(s.yAxisIndex).toBe(s.xAxisIndex);
      expect(s).not.toHaveProperty('sampling');
    }
    expect(on('VER L41', 2)?.step).toBe('end');
    expect(on('VER L41', 3)?.step).toBe('end');
  });

  it('plots [metres, value], a break as [x, null] at the previous point, and 104 as null in throttle and brake only', () => {
    expect(on('VER L41', 0)?.data).toEqual([
      [0, 100],
      [25, 110],
      [50, 120],
      [75, 130],
      [100, 140],
      [100, null],
      [300, 150],
    ]);
    expect(on('VER L41', 1)?.data).toEqual([
      [0, 100],
      [25, null],
      [50, 50],
      [75, 0],
      [100, 0],
      [100, null],
      [300, 100],
    ]);
    expect(on('VER L41', 2)?.data).toEqual([
      [0, 0],
      [25, null],
      [50, 0],
      [75, 100],
      [100, 100],
      [100, null],
      [300, 0],
    ]);
    expect(on('VER L41', 3)?.data).toEqual([
      [0, 3],
      [25, 3],
      [50, 4],
      [75, 4],
      [100, 5],
      [100, null],
      [300, 5],
    ]);
  });

  it('draws the DRS strip where 10, 12 or 14, at the lap’s row, for a lap with the channel up to 2025 (E3)', () => {
    expect(on('VER L41', 4)?.data).toEqual([
      [0, null],
      [25, 0],
      [50, 0],
      [75, 0],
      [100, null],
      [100, null],
      [300, null],
    ]);
    expect(on('VER L41', 4)?.lineStyle).toEqual({ width: 6 });
    expect(option.yAxis[4]).toMatchObject({ type: 'category', gridIndex: 4, data: ['VER L41'] });
    // Both laps with the channel: a row each, Lap 1 on top.
    const both = traceChartOption(lapsOf(short(), short()), tokens, 2021);
    expect(both.yAxis[4]).toMatchObject({ data: ['VER L41', 'NOR L38'], inverse: true });
    expect((both.series as unknown as S[]).filter((s) => s.xAxisIndex === 4).map((s) => s.name)).toEqual([
      'VER L41',
      'NOR L38',
    ]);
    expect(both.series.at(-1)?.data[1]).toEqual([25, 1]);
  });

  it('has no strip row at all without a lap with the channel, nor in 2026 even with one (E3)', () => {
    for (const o of [
      traceChartOption(lapsOf(short(null), short(null)), tokens, 2019),
      traceChartOption(lapsOf(short(), short()), tokens, 2026),
    ]) {
      expect(o.grid).toHaveLength(4);
      expect(o.yAxis.map((y) => (y as { name: string }).name)).toEqual(['km/h', 'Throttle %', 'Brake', 'Gear']);
      expect(o.series.every((s) => s.xAxisIndex < 4)).toBe(true);
      expect(o.xAxis[3]?.axisLabel.show).toBe(true);
    }
  });

  it('draws Lap 1 solid and Lap 2 dashed on every channel, in the lineStyles colour, for one driver’s two laps too (E4)', () => {
    const channels = (o: { series: unknown[] }) => (o.series as S[]).filter((s) => s.xAxisIndex < 4);
    for (const s of channels(option))
      expect([s.color, s.lineStyle.type]).toEqual(s.name === 'VER L41' ? ['#3671C6', 'solid'] : ['#FF8000', 'dashed']);
    const own = traceChartOption(lapsOf(short(), short(), VER), tokens, 2019);
    expect(channels(own).map((s) => `${s.name} ${s.color} ${s.lineStyle.type}`)).toEqual([
      ...Array.from({ length: 4 }, () => 'VER L41 #3671C6 solid'),
      ...Array.from({ length: 4 }, () => 'VER L38 #3671C6 dashed'),
    ]);
    const light = traceChartOption(lapsOf(short(), short()), { ...tokens, light: true }, 2019);
    expect(channels(light).at(-1)?.color).toBe(clampForLight('#FF8000'));
    expect(clampForLight('#FF8000')).not.toBe('#FF8000');
    // Lap 2 drawn alone stays dashed.
    const alone = traceChartOption(lapsOf(short(), short()).slice(1), tokens, 2019);
    expect(channels(alone).map((s) => s.lineStyle.type)).toEqual(['dashed', 'dashed', 'dashed', 'dashed']);
  });

  it('names the laps in the legend, 36 px wide so a dash shows, in --fg, and strips rich-text markup', () => {
    expect(option.legend).toEqual({
      top: 0,
      data: ['VER L41', 'NOR L38'],
      itemWidth: 36,
      textStyle: { color: tokens.fg },
    });
    const marked = traceChartOption([{ name: 'V{E|R} L41', driver: VER, telemetry: short(), slot: 0 }], tokens, 2019);
    expect(marked.legend.data).toEqual(['VER L41']);
    expect(marked.series.every((s) => s.name === 'VER L41')).toBe(true);
  });

  it('says the distance, then per lap speed and gear, throttle, brake and DRS, "—" for the sentinel', () => {
    const tip = option.tooltip;
    expect(tip).toMatchObject({ trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: tokens.bg });
    // VER at sample 1 (the sentinel), NOR at sample 3 (braking).
    expect(
      tip.formatter([
        { seriesIndex: 0, dataIndex: 1, axisValue: 1240.4 },
        { seriesIndex: 7, dataIndex: 3, axisValue: 1240.4 },
      ]),
    ).toBe(
      [
        '1,240 m',
        'VER L41 110 km/h · gear 3',
        'throttle — · brake — · DRS open',
        'NOR L38 130 km/h · gear 4',
        'throttle 0 % · brake',
      ].join('\n'),
    );
    // A break item shows the sample before it; a lap off the hovered range is "—".
    expect(tip.formatter([{ seriesIndex: 1, dataIndex: 5, axisValue: 100 }])).toBe(
      ['100 m', 'VER L41 140 km/h · gear 5', 'throttle 0 % · brake · DRS closed', 'NOR L38 —'].join('\n'),
    );
    expect(tip.formatter([])).toBe('');
  });

  it('names the chart by its laps', () => {
    expect(traceLabel(lapsOf(short(), short()))).toBe(
      'Telemetry: VER L41, NOR L38: speed, throttle, brake and gear by distance',
    );
  });
});

/**
 * A 90 s lap on a 5 km circle: car samples every 270 ms (334), Position every 300 ms (X/Y in 0.1 m), the speed
 * rising and falling, a brake zone every 15 s, DRS open on the back straight. `drop`: car samples left out over
 * [from, to) ms.
 */
const circleLap = (phase: number, drs: boolean, drop?: [number, number]): Telemetry => {
  const r = 5000 / (2 * Math.PI) / 0.1;
  const pt = Array.from({ length: 301 }, (_, k) => k * 300);
  const angle = (t: number) => (2 * Math.PI * t) / 90_000;
  const ct = Array.from({ length: 334 }, (_, k) => k * 270).filter((t) => !drop || t < drop[0] || t >= drop[1]);
  const wave = (t: number) => Math.sin((2 * Math.PI * (t + phase)) / 15_000);
  return telemetry(
    {
      t: ct,
      speed: ct.map((t) => Math.round(210 + 100 * wave(t))),
      gear: ct.map((t) => Math.max(2, Math.min(8, Math.round(6 + 2 * wave(t))))),
      throttle: ct.map((t) => (wave(t) > -0.6 ? 100 : 0)),
      brake: ct.map((t) => (wave(t) <= -0.6 ? 100 : 0)),
      ...(drs ? { drs: ct.map((t) => (t > 40_000 && t < 52_000 ? 12 : 8)) } : {}),
    },
    {
      t: pt,
      x: pt.map((t) => Math.round(r * Math.cos(angle(t)))),
      y: pt.map((t) => Math.round(r * Math.sin(angle(t)))),
    },
  );
};

describe('the trace chart at 390 px', () => {
  use([SVGRenderer]);
  type Box = { x: number; y: number; width: number; height: number };
  const render = (o: object) => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 390, height: 480 });
    chart.setOption({ ...o, animation: false });
    return chart;
  };
  const draw = (o: object) => {
    const chart = render(o);
    try {
      return chart
        .getZr()
        .storage.getDisplayList()
        .map((el) => {
          const e = el as unknown as {
            type: string;
            style: { stroke?: string; text?: string };
            transform?: number[];
            getBoundingRect(): { clone(): Box & { applyTransform(m: number[]): void } };
          };
          const box = e.getBoundingRect().clone();
          if (e.transform) box.applyTransform(e.transform);
          return { el: e, box };
        });
    } finally {
      chart.dispose();
    }
  };
  /** The `d` of each drawn path stroked in `colour`, in series order. */
  const paths = (o: object, colour: string) => {
    const chart = render(o);
    try {
      return [...chart.renderToSVGString().matchAll(/<path d="([^"]*)"[^>]*stroke="([^"]*)"/g)]
        .filter(([, , stroke]) => stroke === colour)
        .map(([, d = '']) => d);
    } finally {
      chart.dispose();
    }
  };
  const laps = (drs: boolean, drop?: [number, number]): TraceLap[] =>
    lapsOf(circleLap(0, drs, drop), circleLap(900, drs));

  it('draws every element inside the canvas, with the DRS strip and without', () => {
    for (const [drs, year] of [
      [true, 2019],
      [false, 2019],
      [true, 2026],
    ] as const) {
      const list = draw(traceChartOption(laps(drs, [30_000, 33_000]), tokens, year));
      const lines = list.filter(({ el }) => el.type === 'ec-polyline');
      expect(lines).toHaveLength(drs && year === 2019 ? 10 : 8);
      const texts = list.flatMap(({ el }) => (el.style.text ? [el.style.text] : []));
      expect(texts).toEqual(
        expect.arrayContaining(['km/h', 'Throttle %', 'Brake', 'Gear', 'VER L41', 'NOR L38', '0 m']),
      );
      expect(texts.includes('DRS')).toBe(drs && year === 2019);
      for (const { el, box } of list) {
        const where = `${el.type} ${el.style.text ?? ''}`;
        expect(box.x, where).toBeGreaterThanOrEqual(0);
        expect(box.y, where).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, where).toBeLessThanOrEqual(390);
        expect(box.y + box.height, where).toBeLessThanOrEqual(480);
      }
      // Every grid's plot spans the same pixels, so a distance is one x on all of them.
      const spans = new Set(lines.filter(({ box }) => box.width > 100).map(({ box }) => `${box.x} ${box.width}`));
      expect(spans.size).toBe(1);
    }
  });

  it('breaks the speed line of a lap with a 3 s dropout into two pieces, one piece without it', () => {
    const [broken] = paths(traceChartOption(laps(false, [30_000, 33_000]), tokens, 2019), VER.team as string);
    const [whole] = paths(traceChartOption(laps(false), tokens, 2019), VER.team as string);
    expect(broken?.match(/M/g)).toHaveLength(2);
    expect(whole?.match(/M/g)).toHaveLength(1);
  });
});

// The card on the session page's Compare tab (E1): what it asks and what it says, per lap.
describe('the telemetry card', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // VER's best is lap 2 (purple), NOR's lap 3 (green); NOR's lap 1 has no time. A qualifying session asks nothing else.
  const laps = [
    lap(1, 1, { lap_ms: 90_000, colour: { lap: 'yellow', s1: null, s2: null, s3: null } }),
    lap(1, 2, { lap_ms: 81_316, colour: { lap: 'purple', s1: null, s2: null, s3: null } }),
    lap(1, 3, { lap_ms: 82_000, colour: { lap: 'yellow', s1: null, s2: null, s3: null } }),
    lap(4, 1),
    lap(4, 2, { lap_ms: 82_500, colour: { lap: 'yellow', s1: null, s2: null, s3: null } }),
    lap(4, 3, { lap_ms: 81_900, colour: { lap: 'green', s1: null, s2: null, s3: null } }),
  ];
  type Answer = () => Response;
  const ok =
    (t: Telemetry = short()) =>
    () =>
      HttpResponse.json(t);
  const mount = (answers: Record<string, Answer>, rows = laps) => {
    const urls: string[] = [];
    server.use(
      http.get('*/api/v1/sessions/11000/telemetry', ({ request }) => {
        const u = new URL(request.url);
        urls.push(u.pathname + u.search);
        const answer = answers[`${u.searchParams.get('driver')}-${u.searchParams.get('lap')}`];
        return answer ? answer() : new HttpResponse(null, { status: 404 });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Compare
            session={11000}
            detail={sessionDetail('Qualifying', 'Qualifying')}
            drivers={[VER, NOR]}
            laps={rows}
            onReference={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    return urls;
  };
  const card = () => host.querySelector('section.traces') as HTMLElement;
  const chart = () => card().querySelector('[role="img"]')?.getAttribute('aria-label') ?? null;
  const words = () => [...card().querySelectorAll('p.muted')].map((p) => p.textContent);
  const select = (n: 1 | 2) => card().querySelector(`select[aria-label="Lap ${n}"]`) as HTMLSelectElement;
  const url = (driver: number, n: number) => `/api/v1/sessions/11000/telemetry?driver=${driver}&lap=${n}&v=${REVISION}`;

  it('sits after the grid and before the Reference choice, and lists every lap of the picks, grouped by driver', () => {
    mount({ '1-2': ok(), '4-3': ok() });
    expect(card().previousElementSibling?.className).toBe('cgrid');
    expect(card().nextElementSibling?.querySelector('[aria-label="Reference"]')).not.toBeNull();
    expect(card().querySelector('h2')?.textContent).toBe('Telemetry');
    for (const n of [1, 2] as const) {
      const groups = [...select(n).querySelectorAll('optgroup')].map((g) => [
        g.label,
        ...[...g.querySelectorAll('option')].map((o) => `${o.value} ${o.textContent}`),
      ]);
      expect(groups).toEqual([
        ['VER', '1-1 L1 1:30.000', '1-2 L2 1:21.316', '1-3 L3 1:22.000'],
        ['NOR', '4-1 L1 —', '4-2 L2 1:22.500', '4-3 L3 1:21.900'],
      ]);
    }
    expect(card().querySelector('.keys')?.textContent).toBe(
      "x: metres from each lap's first position sample · a gap of over 1.5 s breaks the line · ── lap 1 · ‑ ‑ lap 2",
    );
  });

  it('asks for the two own bests by default, one request each with &v=, and draws both', async () => {
    const urls = mount({ '1-2': ok(), '4-3': ok() });
    expect([select(1).value, select(2).value]).toEqual(['1-2', '4-3']);
    expect(words()).toEqual(['Loading telemetry for VER L2…', 'Loading telemetry for NOR L3…']);
    await vi.waitFor(() =>
      expect(chart()).toBe('Telemetry: VER L2, NOR L3: speed, throttle, brake and gear by distance'),
    );
    expect(words()).toEqual([]);
    expect(urls.toSorted()).toEqual([url(1, 2), url(4, 3)]);
  });

  it('asks for the lap picked as Lap 2, one of the same driver too', async () => {
    const urls = mount({ '1-2': ok(), '4-3': ok(), '1-3': ok() });
    await vi.waitFor(() => expect(chart()).toMatch(/^Telemetry: VER L2, NOR L3:/));
    act(() => {
      select(2).value = '1-3';
      select(2).dispatchEvent(new Event('change', { bubbles: true }));
    });
    await vi.waitFor(() => expect(chart()).toMatch(/^Telemetry: VER L2, VER L3:/));
    expect(select(2).value).toBe('1-3');
    expect(urls.toSorted()).toEqual([url(1, 2), url(1, 3), url(4, 3)]);
  });

  it('says "No telemetry" for a 404 and draws the other lap', async () => {
    mount({ '1-2': ok() });
    await vi.waitFor(() => expect(words()).toEqual(['No telemetry for NOR L3.']));
    expect(chart()).toMatch(/^Telemetry: VER L2:/);
  });

  it('says a failed load in fixed words, never a body, while the other lap still draws', async () => {
    mount({ '1-2': ok(), '4-3': () => HttpResponse.json({ error: 'secret body' }, { status: 500 }) });
    await vi.waitFor(() => expect(words()).toEqual(['Telemetry for NOR L3 did not load: API error']));
    expect(chart()).toMatch(/^Telemetry: VER L2:/);
    expect(host.textContent).not.toContain('secret');
  });

  it('says which lap has no car data and which no position data, and draws no chart without a lap', async () => {
    const posOnly = { ...short(), car: { t: [], rpm: [], speed: [], gear: [], throttle: [], brake: [], drs: null } };
    const carOnly = { ...short(), pos: { t: [], x: [], y: [], z: [], status: [] } };
    mount({ '1-2': ok(posOnly), '4-3': ok(carOnly) });
    await vi.waitFor(() =>
      expect(words()).toEqual([
        'No car data for VER L2.',
        'No position data for NOR L3, so no distance to draw it on.',
      ]),
    );
    expect(chart()).toBeNull();
  });

  it('says a lap whose position data starts over 1.5 s after the line is not drawn, and draws the other', async () => {
    const s = short();
    const late = { ...s, pos: { ...s.pos, t: s.pos.t.map((t) => t + 9_200 - (s.pos.t[0] ?? 0)) } };
    mount({ '1-2': ok(), '4-3': ok(late) });
    await vi.waitFor(() =>
      expect(words()).toEqual([
        'No position data in the first 9.2 s of NOR L3, so its distance cannot start at the line.',
      ]),
    );
    expect(chart()).toMatch(/^Telemetry: VER L2:/);
  });

  it('asks the driver without a best lap to pick one, and asks nothing for it', async () => {
    // Without NOR's green lap 3, NOR has no own best.
    const noBest = laps.map((l) => (l.driver_number === 4 ? { ...l, colour: { ...l.colour, lap: null } } : l));
    const urls = mount({ '1-2': ok() }, noBest);
    await vi.waitFor(() => expect(chart()).toMatch(/^Telemetry: VER L2:/));
    expect(words()).toEqual(['No best lap for NOR: pick a lap.']);
    expect(select(2).value).toBe('');
    expect(select(2).options[0]?.textContent).toBe('Pick a lap');
    expect(urls).toEqual([url(1, 2)]);
  });

  it('is not in the player’s comparison, which passes no traces', () => {
    const html = renderToStaticMarkup(
      <Comparison
        detail={sessionDetail('Race', 'Race')}
        drivers={[VER, NOR]}
        laps={laps}
        periods={[]}
        onReference={() => {}}
      />,
    );
    expect(html).toContain('<h2>Lap times</h2>');
    expect(html).not.toContain('Telemetry');
  });
});
