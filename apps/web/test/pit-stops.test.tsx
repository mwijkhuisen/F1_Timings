import { readFileSync } from 'node:fs';
import { Laps, Pits, Stints } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { orderDrivers } from '../src/lib/session.ts';
import { PitStops, pitStops, StintBars } from '../src/views/Stints.tsx';
import { lap, sessionDetail } from './laps.ts';

// The Stints tab's pit stops (#111, A§13) on the pit-normal fixture: five rows of race 11388, seconds to ms.

type Raw = { driver_number: number; lap_number: number; date: string; pit_duration: number; lane_duration: number };
const golden = JSON.parse(
  readFileSync(new URL('../../server/src/openf1/fixtures/pit-normal.golden.json', import.meta.url), 'utf8'),
) as (Raw & { stop_duration: null })[];
const ms = (s: number | null) => (s === null ? null : Math.round(s * 1000));
const pits = Pits.parse(
  golden.map((r) => ({
    driver_number: r.driver_number,
    lap_number: r.lap_number,
    date: new Date(r.date).toISOString(),
    pit_ms: ms(r.pit_duration),
    lane_ms: ms(r.lane_duration),
    stop_ms: ms(r.stop_duration),
    source: 'openf1',
    filled: {},
  })),
);

const stint = (
  driver_number: number,
  stint_number: number,
  lap_start: number,
  lap_end: number,
  compound: string,
  age = 0,
) => ({ driver_number, stint_number, lap_start, lap_end, compound, tyre_age_at_start: age }) as const;
// Four stops: 23 after laps 22 and 37, 16 after lap 24, 1 after lap 32. 16's lap 39 has no new stint: a pit-lane pass.
const stints = Stints.parse([
  stint(23, 1, 1, 22, 'MEDIUM'),
  stint(23, 2, 23, 37, 'HARD'),
  stint(23, 3, 38, 50, 'MEDIUM', 4),
  stint(16, 1, 1, 24, 'MEDIUM'),
  stint(16, 2, 25, 50, 'HARD'),
  stint(1, 1, 1, 32, 'MEDIUM'),
  stint(1, 2, 33, 50, 'HARD'),
]);
const detail = sessionDetail('Race', 'Race', [
  [23, 'ALB'],
  [16, 'LEC'],
  [1, 'VER'],
]);
const laps = Laps.parse([23, 16, 1].flatMap((d) => [lap(d, 1), lap(d, 50)]));
const drivers = orderDrivers(detail, laps);
const periods = [{ kind: 'sc', from: 20, to: 24 }] as const;

describe('pitStops', () => {
  const rows = pitStops(drivers, pits, stints, periods);

  it('has one row per pit row, in API order, with the lane time in ms', () => {
    expect(rows.map((r) => [r.driver.acronym, r.n, r.laneMs, r.stopMs])).toEqual([
      ['ALB', 22, 24000, null],
      ['LEC', 24, 24600, null],
      ['VER', 32, 23900, null],
      ['ALB', 37, 25800, null],
      ['LEC', 39, 24100, null],
    ]);
  });

  it('finds four stops and one pit-lane pass, and the fastest stop', () => {
    expect(rows.map((r) => r.pass)).toEqual([false, false, false, false, true]);
    expect(rows.filter((r) => r.fastest).map((r) => r.driver.acronym)).toEqual(['VER']);
    expect(rows[3]?.before?.compound).toBe('HARD');
    expect(rows[3]?.after?.compound).toBe('MEDIUM');
  });

  it('lets a stint be matched by one row only: the second row on it is a pass', () => {
    const own = Stints.parse([stint(23, 1, 1, 20, 'MEDIUM'), stint(23, 2, 21, 50, 'HARD')]);
    const two = Pits.parse([
      { ...pits[0], lap_number: 20 },
      { ...pits[0], lap_number: 21 },
    ]);
    expect(pitStops(drivers, two, own, []).map((r) => r.pass)).toEqual([false, true]);
  });

  it('finds under sc inside a period', () => {
    expect(rows.map((r) => r.under)).toEqual(['sc', 'sc', undefined, undefined, undefined]);
  });

  it('never makes a pass the fastest, however short', () => {
    const quick = Pits.parse([...pits, { ...pits[0], lap_number: 45, lane_ms: 5000, pit_ms: 5000 }]);
    expect(
      pitStops(drivers, quick, stints, [])
        .filter((r) => r.fastest)
        .map((r) => r.n),
    ).toEqual([32]);
  });
});

describe('PitStops', () => {
  const html = renderToStaticMarkup(<PitStops detail={detail} rows={pitStops(drivers, pits, stints, periods)} />);

  it('lists the stops with the lane times and boxes only the fastest', () => {
    expect(html).toContain('<h2>Pit stops</h2>');
    for (const t of ['24.0 s', '24.6 s', '25.8 s', '24.1 s']) expect(html).toContain(t);
    expect(html.match(/t-purple/g)).toHaveLength(1);
    expect(html).toContain('<span class="t-purple">23.9 s<span class="vh">, fastest</span></span>');
    expect(html).toContain('under SC');
    expect(html).toContain('Medium → Hard, new set');
    // The age of a used set is a tap note with the #473 caveat.
    expect(html).toContain('Hard → Medium, used set, <button');
    expect(html).toContain('title="May be wrong for a used set (OpenF1 #473)">4 laps old</button>');
  });

  it('shows a dash with its reason for the stationary time, and labels the pass', () => {
    expect(html.match(/No stop time in the OpenF1 data or the F1 archive/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain('OpenF1 #484');
    expect(html).toContain('Pit-lane pass: no tyre change in the stints data');
    expect(html.match(/Pit-lane pass/g)).toHaveLength(1);
  });
});

describe('StintBars popovers', () => {
  const html = renderToStaticMarkup(
    <StintBars
      detail={detail}
      laps={laps}
      stints={stints}
      pitRows={pitStops(drivers, pits, stints, periods)}
      periods={periods}
    />,
  );

  it('adds one line per pit row to a driver', () => {
    expect(html).toContain('<li>Stop after lap 22: 24.0 s in the pit lane</li>');
    expect(html).toContain('<li>Stop after lap 37: 25.8 s in the pit lane</li>');
    expect(html).toContain(
      '<li>Pit-lane pass after lap 39: 24.1 s in the pit lane, no tyre change in the stints data</li>',
    );
  });

  it('says so when a row has no lane time', () => {
    const none = Pits.parse([{ ...pits[0], lane_ms: null, pit_ms: null }]);
    expect(
      renderToStaticMarkup(
        <StintBars detail={detail} laps={laps} stints={stints} pitRows={pitStops(drivers, none, stints, [])} />,
      ),
    ).toContain('<li>Stop after lap 22: no pit-lane time in the OpenF1 data</li>');
  });

  it('adds nothing without pit rows', () => {
    expect(renderToStaticMarkup(<StintBars detail={detail} laps={laps} stints={stints} />)).not.toContain('Stop after');
  });
});

describe('the stop time notes (#219)', () => {
  // Three stops with a stationary time, each from another source, and one without.
  const stop = (i: number, source: 'openf1' | 'f1-archive' | 'f1-live', filled: Record<string, string>) => ({
    ...pits[i],
    stop_ms: 2400 + i * 100,
    source,
    filled,
  });
  const mixed = Pits.parse([
    stop(0, 'openf1', { stop_ms: 'f1-archive' }), // OpenF1's row, the archive's stop time
    stop(1, 'openf1', {}),
    stop(2, 'f1-live', {}),
    pits[3],
  ]);
  const rows = pitStops(drivers, mixed, stints, periods);
  const html = renderToStaticMarkup(<PitStops detail={detail} rows={rows} />);
  /** The stop cell's note text and what it wraps, per row. */
  const cells = [...html.matchAll(/<td><button[^>]*title="((?:From|No stop)[^"]*)">([^<]*)<\/button>/g)].map((m) => [
    m[1],
    m[2],
  ]);

  it('a stop time carries its source: filled.stop_ms over the row source', () => {
    expect(rows.map((r) => r.stopSource)).toEqual(['f1-archive', 'openf1', 'f1-live', null]);
    expect(cells).toEqual([
      ['From the F1 archive', '2.4 s'],
      ['From the OpenF1 data', '2.5 s'],
      ['From the F1 live feed', '2.6 s'],
      ['No stop time in the OpenF1 data or the F1 archive', '—'],
    ]);
  });

  it('keeps the note id and its popover for each stop cell', () => {
    expect(html).toContain('popoverTarget="pit-stop-0"');
    expect(html).toContain('<div popover="auto" id="pit-stop-0" class="pop">From the F1 archive</div>');
    expect(html).toContain(
      '<div popover="auto" id="pit-stop-3" class="pop">No stop time in the OpenF1 data or the F1 archive</div>',
    );
  });

  it('a missing stop time says what was looked at, by the session source', () => {
    const none = pitStops(drivers, pits, stints, []);
    const say = (source?: 'openf1' | 'f1-archive' | 'f1-live' | 'jolpica') =>
      renderToStaticMarkup(<PitStops detail={detail} rows={none} {...(source && { source })} />);
    expect(say()).toContain('title="No stop time in the OpenF1 data or the F1 archive"');
    expect(say('f1-archive')).toContain('title="No stop time in the F1 archive: it has none before 2025"');
    expect(say('f1-live')).toContain('title="No stop time in the F1 live feed"');
    expect(say('jolpica')).toContain('title="No stop time in the Jolpica data"');
    // The session's own source is the default.
    const archive = { ...detail, session: { ...detail.session, source: 'f1-archive' as const } };
    expect(renderToStaticMarkup(<PitStops detail={archive} rows={none} />)).toContain(
      'title="No stop time in the F1 archive: it has none before 2025"',
    );
    expect(say('f1-live')).not.toContain('OpenF1 data');
  });

  it('the popover line says what the lane time was looked up in, by source', () => {
    const none = pitStops(drivers, Pits.parse([{ ...pits[0], lane_ms: null, pit_ms: null }]), stints, []);
    const line = (pitSource?: 'f1-live') =>
      renderToStaticMarkup(
        <StintBars detail={detail} laps={laps} stints={stints} pitRows={none} {...(pitSource && { pitSource })} />,
      );
    expect(line()).toContain('<li>Stop after lap 22: no pit-lane time in the OpenF1 data</li>');
    expect(line('f1-live')).toContain('<li>Stop after lap 22: no pit-lane time in the F1 live feed</li>');
  });
});
