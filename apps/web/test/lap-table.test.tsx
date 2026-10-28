import { type Lap, Laps, SessionDetail } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { teamColour } from '../src/lib/session.ts';
import { LapGrid, LapTable, type Metric, missingReason } from '../src/views/LapTable.tsx';

// D10's cell rules on a hand-built race: 2 drivers × 3 laps, rendered statically (D4).

type C = Lap['colour']['lap'];
const lap = (driver_number: number, lap_number: number, times: [number | null, C][], extra: Partial<Lap> = {}): Lap => {
  const [
    [lap_ms, lc] = [null, null],
    [s1_ms, c1] = [null, null],
    [s2_ms, c2] = [null, null],
    [s3_ms, c3] = [null, null],
  ] = times;
  return {
    driver_number,
    lap_number,
    date_start: null,
    lap_ms,
    s1_ms,
    s2_ms,
    s3_ms,
    i1_kph: null,
    i2_kph: null,
    st_kph: null,
    is_pit_out: false,
    is_pit_in: false,
    seg1: null,
    seg2: null,
    seg3: null,
    deleted: false,
    deleted_reason: null,
    quali_phase: null,
    compound: 'SOFT',
    colour: { lap: lc, s1: c1, s2: c2, s3: c3 },
    ...extra,
  };
};

// [lap, S1, S2, S3] as [ms, colour].
const laps = Laps.parse([
  // Driver 1 comes first in the list but has no position: it sorts after 44.
  lap(1, 1, [
    [85000, 'green'],
    [28300, 'green'],
    [30500, 'yellow'],
    [25100, 'purple'],
  ]),
  lap(
    1,
    2,
    [
      [83000, 'yellow'],
      [28000, 'yellow'],
      [29800, 'yellow'],
      [25200, 'yellow'],
    ],
    { deleted: true, deleted_reason: 'TRACK LIMITS AT TURN 16', is_pit_in: true },
  ),
  lap(
    1,
    3,
    [
      [92000, 'yellow'],
      [null, null],
      [31000, 'yellow'],
      [26000, 'yellow'],
    ],
    { is_pit_out: true, compound: 'MEDIUM' },
  ),
  lap(44, 1, [
    [null, null],
    [null, null],
    [30000, 'green'],
    [25000, 'green'],
  ]),
  lap(44, 2, [
    [83456, 'purple'],
    [28100, 'purple'],
    [29900, 'purple'],
    [25456, 'yellow'],
  ]),
  lap(
    44,
    3,
    [
      [90000, 'yellow'],
      [28500, 'yellow'],
      [31000, 'yellow'],
      [null, null],
    ],
    { is_pit_in: true },
  ),
]);

const iso = '2026-10-11T12:00:00.000Z';
const driver = (driver_number: number, acronym: string, team_colour: string) => ({
  driver_number,
  acronym,
  full_name: null,
  team_name: null,
  team_colour,
});
const result = (driver_number: number, position: number | null) => ({
  driver_number,
  position,
  laps: null,
  dnf: null,
  dns: null,
  dsq: null,
  durations_ms: null,
  gaps_ms: null,
});
const detail = SessionDetail.parse({
  session: {
    session_key: 9965,
    type: 'Race',
    name: 'Race',
    date_start: iso,
    date_end: iso,
    ingest_state: 'final',
    is_cancelled: false,
    meeting_key: 1290,
  },
  meeting: {
    meeting_key: 1290,
    name: 'Singapore Grand Prix',
    official_name: null,
    location: null,
    country_code: null,
    circuit_short_name: null,
    gmt_offset: null,
    date_start: null,
    date_end: null,
    is_cancelled: false,
    year: 2026,
  },
  // 63 has a result but no laps: it is left out.
  drivers: [driver(1, 'NOR', 'not-hex'), driver(44, 'HAM', 'E80020'), driver(63, 'RUS', '00D7B6')],
  results: [result(1, null), result(44, 1), result(63, 2)],
});

type Cell = { cls: string[]; title: string | null; body: string };
const cells = (html: string): Cell[] =>
  [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attrs = '', body = '']) => ({
    cls: /class="([^"]*)"/.exec(attrs)?.[1]?.split(' ') ?? [],
    title: /title="([^"]*)"/.exec(attrs)?.[1] ?? null,
    body,
  }));
const grid = (metric: Metric, columns = false) =>
  renderToStaticMarkup(<LapGrid detail={detail} laps={laps} metric={metric} columns={columns} />);
const colourOf = (c: Cell) => c.cls.find((n) => n.startsWith('t-'))?.slice(2) ?? null;

// Rows mode: HAM laps 1–3, then NOR laps 1–3.
const COLOURS: Record<Metric, (string | null)[]> = {
  lap: [null, 'purple', 'yellow', 'green', 'yellow', 'yellow'],
  s1: [null, 'purple', 'yellow', 'green', 'yellow', null],
  s2: ['green', 'purple', 'yellow', 'yellow', 'yellow', 'yellow'],
  s3: ['green', 'yellow', null, 'purple', 'yellow', 'yellow'],
};
const TITLES = { purple: 'overall best', green: 'personal best', yellow: 'slower than personal best' };

describe('the lap grid', () => {
  it.each(Object.entries(COLOURS))('colours %s by its own colour field, none for null', (metric, colours) => {
    const got = cells(grid(metric as Metric));
    expect(got.map(colourOf)).toEqual(colours);
    for (const c of got) {
      const colour = colourOf(c);
      expect(c.title).toBe(colour === null ? null : TITLES[colour as keyof typeof TITLES]);
    }
  });

  it('formats lap and sector times', () => {
    expect(cells(grid('lap'))[1]?.body).toContain('1:23.456');
    expect(cells(grid('s1'))[1]?.body).toContain('28.100');
  });

  it('strikes a deleted lap in every metric, with the reason in the title and the popover', () => {
    for (const metric of ['lap', 's1', 's2', 's3'] as const) {
      const nor2 = cells(grid(metric))[4];
      expect(nor2?.cls).toContain('deleted');
      expect(nor2?.body).toMatch(/<s>[^<]+<\/s>/);
      expect(nor2?.body).toContain(`title="Deleted: TRACK LIMITS AT TURN 16"`);
      expect(nor2?.body).toMatch(
        new RegExp(`<div popover="auto" id="n-1-2-${metric}"[^>]*>Deleted: TRACK LIMITS AT TURN 16</div>`),
      );
      expect(nor2?.body).toContain(`popoverTarget="n-1-2-${metric}"`);
    }
    expect(cells(grid('lap')).filter((c) => c.cls.includes('deleted'))).toHaveLength(1);
  });

  it('shows — with its reason for a null value', () => {
    const reason = (metric: Metric, i: number) => {
      const c = cells(grid(metric))[i];
      expect(c?.body).toMatch(/>—</);
      return /<div popover[^>]*>([^<]*)<\/div>/.exec(c?.body ?? '')?.[1];
    };
    expect(reason('lap', 0)).toBe('Lap 1 from the grid: no time in the OpenF1 data');
    expect(reason('s3', 2)).toBe('In-lap: no time in the OpenF1 data');
    expect(reason('s1', 5)).toBe('Out-lap: no time in the OpenF1 data');
    // A cell with a value has no note.
    expect(cells(grid('lap'))[1]?.body).not.toContain('popover');
  });

  it('gives every note a unique id', () => {
    const ids = [...grid('s1').matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(ids).toEqual(['n-44-1-s1', 'n-1-2-s1', 'n-1-3-s1']);
  });

  it('badges in-laps IN and out-laps OUT', () => {
    const badges = cells(grid('lap')).map((c) => [...c.body.matchAll(/class="badge">(\w+)</g)].map(([, b]) => b));
    expect(badges).toEqual([[], [], ['IN'], [], ['IN'], ['OUT']]);
  });

  it('puts the compound dot only at the start of a run', () => {
    const dots = cells(grid('lap')).map((c) =>
      /<span class="cmp (cmp-\w+)" title="(\w+)">(\w)</.exec(c.body)?.slice(1),
    );
    expect(dots).toEqual([
      ['cmp-soft', 'SOFT', 'S'],
      undefined,
      undefined,
      ['cmp-soft', 'SOFT', 'S'],
      undefined,
      ['cmp-medium', 'MEDIUM', 'M'],
    ]);
  });

  it('orders drivers by position, nulls last, and leaves out drivers without laps', () => {
    const html = grid('lap');
    expect([...html.matchAll(/<th scope="row"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['HAM', 'NOR']);
    expect(html).not.toContain('RUS');
    // Rows mode: the header row is the lap numbers.
    expect([...html.matchAll(/<th scope="col">(\w+)</g)].map(([, a]) => a)).toEqual(['Driver', '1', '2', '3']);
  });

  it('sets the team colour only from six hex digits', () => {
    const html = grid('lap');
    expect(html).toMatch(/<th scope="row" class="drv" style="--team:#E80020"[^>]*>HAM</);
    expect(html).toMatch(/<th scope="row" class="drv">NOR</);
  });

  it('puts drivers in columns and laps in rows when switched', () => {
    const html = grid('lap', true);
    expect([...html.matchAll(/<th scope="col"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['Lap', 'HAM', 'NOR']);
    expect([...html.matchAll(/<th scope="row">(\d+)</g)].map(([, n]) => n)).toEqual(['1', '2', '3']);
    // Lap 1 of HAM and NOR, then lap 2, then lap 3.
    expect(cells(html).map(colourOf)).toEqual([null, 'green', 'purple', 'yellow', 'yellow', 'yellow']);
    expect(html).toContain('class="laps cols"');
  });

  it('starts on the lap time, drivers as rows, and says when there are no laps', () => {
    const html = renderToStaticMarkup(<LapTable detail={detail} laps={laps} />);
    expect(html).toMatch(/<button type="button" aria-pressed="true">Lap<\/button>/);
    expect(html).toMatch(/aria-pressed="false">Drivers as columns</);
    expect(html).toContain('class="laps"');
    expect(renderToStaticMarkup(<LapTable detail={detail} laps={[]} />)).toBe('<p>No laps yet.</p>');
  });
});

describe('missingReason', () => {
  const at = (lap_number: number, is_pit_out: boolean | null, is_pit_in: boolean) => ({
    lap_number,
    is_pit_out,
    is_pit_in,
  });

  it.each([
    // Out-laps lack S1; lap 1 out of the garage also lacks its lap time.
    [at(5, true, false), 's1', 'Practice', 'Out-lap: no time in the OpenF1 data'],
    [at(1, true, false), 'lap', 'Qualifying', 'Out-lap: no time in the OpenF1 data'],
    [at(1, true, false), 'lap', 'Race', 'Out-lap: no time in the OpenF1 data'],
    [at(5, true, false), 'lap', 'Practice', 'No time in the OpenF1 data'],
    [at(5, true, false), 's3', 'Practice', 'No time in the OpenF1 data'],
    // In-laps, any metric.
    [at(9, false, true), 's3', 'Qualifying', 'In-lap: no time in the OpenF1 data'],
    [at(9, null, true), 'lap', 'Race', 'In-lap: no time in the OpenF1 data'],
    // Lap 1 of a race or sprint from the grid; not elsewhere.
    [at(1, false, false), 's2', 'Race', 'Lap 1 from the grid: no time in the OpenF1 data'],
    [at(1, null, false), 'lap', 'Race', 'Lap 1 from the grid: no time in the OpenF1 data'],
    [at(1, true, false), 's3', 'Race', 'No time in the OpenF1 data'],
    [at(1, false, false), 'lap', 'Practice', 'No time in the OpenF1 data'],
    [at(2, false, false), 'lap', 'Race', 'No time in the OpenF1 data'],
    [at(2, false, false), 's1', null, 'No time in the OpenF1 data'],
  ] as const)('%o %s in a %s: %s', (l, metric, type, reason) => {
    expect(missingReason(l, metric, type)).toBe(reason);
  });
});

describe('teamColour', () => {
  it.each([
    ['E80020', '#E80020'],
    ['00d7b6', '#00d7b6'],
    ['#E80020', null],
    ['E8002', null],
    ['E800200', null],
    ['E80020;color:red', null],
    ['url(x)', null],
    ['', null],
    [null, null],
  ])('%s → %s', (colour, css) => {
    expect(teamColour(colour)).toBe(css);
  });
});
