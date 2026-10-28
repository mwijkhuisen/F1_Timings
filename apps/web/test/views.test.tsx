import { Laps, Season, SessionDetail, Status, Stints } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { findLatest, latestPath, Meetings } from '../src/views/Picker.tsx';
import { StatusPanel } from '../src/views/Status.tsx';
import { StintBars } from '../src/views/Stints.tsx';

// The picker (D13), the stints bars (D11) and the status panel (D12), on hand-built data.

const meeting = {
  official_name: null,
  location: 'Marina Bay',
  country_code: null,
  circuit_short_name: null,
  gmt_offset: null,
  date_start: null,
  date_end: null,
  is_cancelled: false,
};
const session = (session_key: number, name: string, date_start: string, is_cancelled = false) => ({
  session_key,
  type: 'Race',
  name,
  date_start,
  date_end: date_start,
  ingest_state: 'final',
  is_cancelled,
});
const season = Season.parse([
  {
    ...meeting,
    meeting_key: 1290,
    name: 'Singapore Grand Prix',
    sessions: [
      session(9963, 'Qualifying', '2026-10-10T13:00:00.000Z'),
      session(9964, 'Sprint', '2026-10-10T09:00:00.000Z', true),
      session(9965, 'Race', '2026-10-11T12:00:00.000Z'),
    ],
  },
]);

describe('the season picker', () => {
  const html = renderToStaticMarkup(<Meetings year={2026} season={season} />);

  it('links each session to its lap table, with the start in Amsterdam time', () => {
    expect(html).toContain('<a href="/2026/1290-singapore/9965-race/laps">Race</a>');
    expect(html).toContain('<time dateTime="2026-10-11T12:00:00.000Z">Sun 11 Oct 2026, 14:00</time>');
  });

  it('strikes a cancelled session and does not link it', () => {
    expect(html).toContain('<s title="Cancelled">Sprint</s>');
    expect(html).not.toContain('9964');
  });

  it('finds the last started session that is not cancelled', () => {
    expect(latestPath(2026, season, Date.parse('2026-10-11T12:00:00Z'))).toBe('/2026/1290-singapore/9965-race/laps');
    expect(latestPath(2026, season, Date.parse('2026-10-11T11:59:59Z'))).toBe(
      '/2026/1290-singapore/9963-qualifying/laps',
    );
    expect(latestPath(2026, season, Date.parse('2026-10-10T12:00:00Z'))).toBeNull();
  });

  it('sends / to the newest season with a started session, else to the newest season', async () => {
    // 2027 is listed before its first session.
    const next = Season.parse([
      {
        ...meeting,
        meeting_key: 1400,
        name: 'Australian Grand Prix',
        sessions: [session(9999, 'Race', '2027-03-07T05:00:00.000Z')],
      },
    ]);
    const loaded: number[] = [];
    const load = async (year: number) => {
      loaded.push(year);
      return year === 2027 ? next : season;
    };
    expect(await findLatest([2027, 2026], load, Date.parse('2026-10-28T00:00:00Z'))).toBe(
      '/2026/1290-singapore/9965-race/laps',
    );
    expect(loaded).toEqual([2027, 2026]);
    // A season that has one is the last one loaded.
    loaded.length = 0;
    expect(await findLatest([2026, 2025], load, Date.parse('2026-10-28T00:00:00Z'))).toBe(
      '/2026/1290-singapore/9965-race/laps',
    );
    expect(loaded).toEqual([2026]);
    expect(await findLatest([2027, 2026], load, Date.parse('2026-01-01T00:00:00Z'))).toBe('/2027');
  });
});

describe('the stints bars', () => {
  const lapsOf = (driver_number: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      driver_number,
      lap_number: i + 1,
      date_start: null,
      lap_ms: null,
      s1_ms: null,
      s2_ms: null,
      s3_ms: null,
      i1_kph: null,
      i2_kph: null,
      st_kph: null,
      is_pit_out: null,
      is_pit_in: false,
      seg1: null,
      seg2: null,
      seg3: null,
      deleted: false,
      deleted_reason: null,
      quali_phase: null,
      compound: null,
      colour: { lap: null, s1: null, s2: null, s3: null },
    }));
  const iso = '2026-10-11T12:00:00.000Z';
  const detail = SessionDetail.parse({
    session: { ...session(9965, 'Race', iso), meeting_key: 1290 },
    meeting: { ...meeting, meeting_key: 1290, name: 'Singapore Grand Prix', year: 2026 },
    drivers: [{ driver_number: 4, acronym: 'NOR', full_name: null, team_name: null, team_colour: 'F47600' }],
    results: [],
  });
  const stint = (
    driver_number: number,
    stint_number: number,
    lap_start: number,
    lap_end: number,
    compound: string,
  ) => ({
    driver_number,
    stint_number,
    lap_start,
    lap_end,
    compound,
    tyre_age_at_start: 0,
  });
  const html = renderToStaticMarkup(
    <StintBars
      detail={detail}
      laps={Laps.parse([...lapsOf(81, 40), ...lapsOf(4, 40)])}
      stints={Stints.parse([stint(4, 1, 1, 10, 'MEDIUM'), stint(4, 2, 11, 40, 'HARD'), stint(81, 1, 1, 40, 'NEW')])}
    />,
  );

  it('sizes each stint by its laps over the session laps', () => {
    expect(html).toContain(
      '<span class="seg cmp-medium" style="--x:0.000%;--w:25.000%" title="MEDIUM, laps 1–10, tyre age 0 at start (may be wrong for a used set)"><b>M</b> <span class="range">1–10</span></span>',
    );
    expect(html).toContain(
      'style="--x:25.000%;--w:75.000%" title="HARD, laps 11–40, tyre age 0 at start (may be wrong for a used set)"><b>H</b>',
    );
  });

  it('marks an unknown compound and orders the drivers as the lap table does', () => {
    expect(html).toContain('<span class="seg cmp-unknown"');
    expect([...html.matchAll(/class="drv"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['NOR', '81']);
  });
});

describe('the status panel', () => {
  const html = renderToStaticMarkup(
    <StatusPanel
      status={Status.parse({
        states: { scheduled: 25, due: 0, fetched: 1, final: 454, failed: 1 },
        cancelled: 15,
        failed: [
          {
            session_key: 9965,
            year: 2026,
            meeting_name: 'Singapore Grand Prix',
            session_name: 'Race',
            fail_count: 3,
            last_error: '<b>http_500</b>',
            next_fetch_at: '2026-10-11T12:00:00.000Z',
          },
        ],
      })}
    />,
  );

  it('counts sessions per state and the cancelled ones', () => {
    expect(html).toContain('<dt>final</dt><dd>454</dd>');
    expect(html).toContain('<dt>cancelled</dt><dd>15</dd>');
  });

  it('lists failed sessions with the error as text', () => {
    expect(html).toContain('<td>&lt;b&gt;http_500&lt;/b&gt;</td><td>Sun 11 Oct 2026, 14:00</td>');
  });
});
