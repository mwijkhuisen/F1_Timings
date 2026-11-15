import type { Lap, Stints, Weather } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { paceRuns } from '../src/lib/runs.ts';
import type { ClockPeriod } from '../src/lib/track.ts';
import { PaceTable, RunPlan } from '../src/views/Pace.tsx';
import { lap, sessionDetail } from './laps.ts';

// The run plan and the pace table (#114) on synthetic practice laps, rendered statically.

const T0 = Date.parse('2026-10-24T12:00:00Z'); // 14:00 in Amsterdam (CEST)
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (min: number, s = 0) => iso(T0 + min * MIN + s * 1000);

const base = sessionDetail('Practice', 'Practice 1', [
  [1, 'VER'],
  [4, 'NOR'],
]);
const practice = { ...base, session: { ...base.session, date_start: iso(T0), date_end: iso(T0 + 60 * MIN) } };

// NOR run 1: a garage lap 1 without a time, laps 2–7 at 90 s from 14:05, an in-lap 8 (ends 14:15:40). Run 2: an
// out-lap at 14:30, two timed laps, an in-lap (too few to rate). VER: no lap has a start time; lap 6 is slow.
const nor: Lap[] = [
  lap(4, 1, { is_pit_out: true }),
  ...Array.from({ length: 6 }, (_, i) => lap(4, 2 + i, { date_start: at(5, 90 * i), lap_ms: 90_000 })),
  lap(4, 8, { date_start: at(14), lap_ms: 100_000, is_pit_in: true }),
  lap(4, 9, { date_start: at(30), lap_ms: 95_000, is_pit_out: true }),
  lap(4, 10, { date_start: at(31, 35), lap_ms: 91_000 }),
  lap(4, 11, { date_start: at(33, 6), lap_ms: 91_500 }),
  lap(4, 12, { date_start: at(34), lap_ms: 100_000, is_pit_in: true }),
];
const ver: Lap[] = [
  lap(1, 1, { is_pit_out: true, lap_ms: 120_000 }),
  ...[88_000, 88_000, 88_000, 88_000, 99_000].map((ms, i) => lap(1, 2 + i, { lap_ms: ms })),
  lap(1, 7, { lap_ms: 110_000, is_pit_in: true }),
];
const laps = [...ver, ...nor];
const stints: Stints = [
  { driver_number: 4, stint_number: 1, lap_start: 1, lap_end: 8, compound: 'MEDIUM', tyre_age_at_start: 3 },
  { driver_number: 4, stint_number: 2, lap_start: 9, lap_end: 12, compound: 'HARD', tyre_age_at_start: 0 },
  { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 7, compound: 'SOFT', tyre_age_at_start: null },
];
const red: ClockPeriod[] = [{ kind: 'red', from: T0 + 20 * MIN, to: T0 + 25 * MIN }];
const row = (date: number, track: number | null) => ({
  date: iso(date),
  air_temperature: null,
  track_temperature: track,
  humidity: null,
  pressure: null,
  rainfall: null,
  wind_direction: null,
  wind_speed: null,
});
const weather: Weather = [row(T0 + 4 * MIN, 41), row(T0 + 29 * MIN, 43)];

const runs = paceRuns(laps, stints, 'Practice', { clock: red });
const plan = renderToStaticMarkup(<RunPlan detail={practice} laps={laps} runs={runs} clock={red} weather={weather} />);
const table = (w = weather, failed = false) =>
  renderToStaticMarkup(<PaceTable detail={practice} laps={laps} runs={runs} weather={w} failed={failed} />);
/** Each body row as its cells' text, a note's popover text apart: `— (reason)`. */
const cells = (html: string) =>
  [...html.matchAll(/<tr><th scope="row"[^>]*>(.*?)<\/th>(.*?)<\/tr>/g)].map(([, driver, rest]) => [
    driver,
    ...[...(rest ?? '').matchAll(/<td>(.*?)<\/td>/g)].map(([, td = '']) => {
      const pop = /<div popover[^>]*>([^<]*)<\/div>/.exec(td)?.[1];
      const text = td.replace(/<div popover.*?<\/div>/, '').replace(/<[^>]+>/g, '');
      return (pop === undefined ? text : `${text} (${pop})`).replace(/&#x27;/g, "'");
    }),
  ]);

describe('RunPlan', () => {
  it('draws a lane per driver in lap-table order, a segment per run with a time, and lists the rest', () => {
    // 60 min: NOR's first run from its lap 2 (the garage lap has no start) at 5/60 to 15 min 40 s.
    expect([...plan.matchAll(/<button[^>]*class="row"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'VER, 1 run: soft time unknown',
      'NOR, 2 runs: medium 14:05 to 14:15, hard 14:30 to 14:35',
    ]);
    expect(plan.match(/<span class="seg cmp-[a-z]+"[^>]*>/g)).toEqual([
      '<span class="seg cmp-medium" style="--x:8.333%;--w:17.778%">',
      '<span class="seg cmp-hard" style="--x:50.000%;--w:9.444%">',
    ]);
    // The segment says its letter and its laps; the stop column the runs.
    expect(plan).toContain('<b>M</b><small>8</small>');
    expect(plan).toContain('<span class="stop">2 runs</span>');
    expect(plan).toContain('1 run without a time of day, not drawn.');
  });

  it('puts the red flag behind the lanes and in the legend', () => {
    expect(plan).toContain('<i class="redband" style="--x:33.333%;--w:8.333%"></i>');
    expect(plan).toContain('RED: red flag, 14:20–14:25');
    expect(plan).toContain('number: laps in the run');
    expect(plan).toContain('<li><span class="cmp cmp-medium" aria-hidden="true">M</span>medium</li>');
    const none = renderToStaticMarkup(<RunPlan detail={practice} laps={laps} runs={runs} clock={[]} weather={[]} />);
    expect(none).not.toContain('redband');
    expect(none).not.toContain('RED: red flag');
  });

  it('says each run in words, with its tyre age and the track temperature at its start', () => {
    expect(plan).toContain(
      '<li>14:05–14:15, Medium, 8 laps (6 counted), 3 laps old at the start (may be wrong for a used set), track 41 °C</li>',
    );
    // A new set; the sample at 14:29 is the last one at or before the run's start.
    expect(plan).toContain('<li>14:30–14:35, Hard, 4 laps (2 counted), new set, track 43 °C</li>');
    // No start time, no track temperature, an unknown age: said, never guessed.
    expect(plan).toContain('<li>time unknown, Soft, 7 laps (4 counted), track —</li>');
  });

  it('shows a track temperature of — when no sample precedes the run', () => {
    const late = renderToStaticMarkup(
      <RunPlan detail={practice} laps={laps} runs={runs} clock={red} weather={[row(T0 + 40 * MIN, 50)]} />,
    );
    expect(late).toContain('3 laps old at the start (may be wrong for a used set), track —</li>');
  });

  it('starts the axis at the first run when it begins before the session', () => {
    const early = [lap(4, 1, { date_start: iso(T0 - 10 * MIN), lap_ms: 90_000 })];
    const html = renderToStaticMarkup(
      <RunPlan detail={practice} laps={early} runs={paceRuns(early, [], 'Practice')} clock={[]} weather={[]} />,
    );
    // 70 min from 13:50 (Amsterdam) to 15:00: the run starts at the axis' first point.
    expect(html).toContain('style="--x:0.000%;--w:2.143%"');
    expect(html).toContain('<span class="tick" style="--x:14.286%">14:00</span>');
  });
});

describe('PaceTable', () => {
  it('lists long runs first, then the short ones, each in lap-table order', () => {
    const got = cells(table());
    // NOR run 1 has 6 counted laps; VER's 4 and NOR run 2's 2 are short.
    expect(got.map(([driver, run]) => [driver, run])).toEqual([
      ['NOR', '14:05–14:15'],
      ['VER', 'time unknown'],
      ['NOR', '14:30–14:35'],
    ]);
  });

  it('shows the tyre, the counted laps, the median and the best, and the track temperature', () => {
    const [norLong, verShort] = cells(table());
    expect(norLong).toEqual([
      'NOR',
      '14:05–14:15',
      'Mmedium tyres, 3 laps old (May be wrong for a used set (OpenF1 #473))',
      '6',
      '1:30.000',
      '1:30.000',
      '2 (2 in- or out-laps)',
      '41',
    ]);
    // VER: 4 of 7 laps counted; an unknown age shows nothing; no start time, no track temperature.
    expect(verShort).toEqual([
      'VER',
      'time unknown',
      'Ssoft tyres, ',
      '4',
      '1:28.000',
      '1:28.000',
      "3 (2 in- or out-laps, 1 over 107 % of the run's median (a cool-down or traffic))",
      '— (No track temperature at the start of the run)',
    ]);
  });

  it('shows — with its reason for fewer than 3 counted laps, and says a new set is new', () => {
    const [, , norShort] = cells(table());
    expect(norShort).toEqual([
      'NOR',
      '14:30–14:35',
      'Hhard tyres, new',
      '2',
      '— (Too few clean laps)',
      '— (Too few clean laps)',
      '2 (2 in- or out-laps)',
      '43',
    ]);
  });

  it('carries the caveat line, and says when race control did not load', () => {
    const caveat =
      "Fuel loads and engine modes are unknown; yellow flags and traffic are not removed; bands mark the leader's lap.";
    expect(table().replace(/&#x27;/g, "'")).toContain(`<p class="muted">${caveat}</p>`);
    expect(table()).not.toContain('Race control did not load');
    expect(table(weather, true)).toContain('<p class="muted">Race control did not load: periods are not left out.</p>');
  });

  it('is a race: stints in driver order, the run number, no track column', () => {
    const race = sessionDetail('Race', 'Race', [
      [1, 'VER'],
      [4, 'NOR'],
    ]);
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => lap(4, i + 1, { lap_ms: 90_000 })),
      lap(1, 1, { lap_ms: 90_000 }),
    ];
    const st: Stints = [
      { driver_number: 4, stint_number: 1, lap_start: 1, lap_end: 4, compound: 'MEDIUM', tyre_age_at_start: 0 },
      { driver_number: 4, stint_number: 2, lap_start: 5, lap_end: 8, compound: 'HARD', tyre_age_at_start: 0 },
      { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 1, compound: 'SOFT', tyre_age_at_start: 0 },
    ];
    const html = renderToStaticMarkup(
      <PaceTable detail={race} laps={rows} runs={paceRuns(rows, st, 'Race')} weather={[]} failed={false} />,
    );
    expect(html).not.toContain('Track °C');
    // VER's lap 1 is left out, so its run has no counted lap; NOR's lap 1 too.
    expect(cells(html).map(([d, run, , counted, median]) => [d, run, counted, median])).toEqual([
      ['VER', '1', '0', '— (Too few clean laps)'],
      ['NOR', '1', '3', '1:30.000'],
      ['NOR', '2', '4', '1:30.000'],
    ]);
    expect(cells(html)[1]?.[6]).toBe('1 (1 lap 1)');
  });
});
