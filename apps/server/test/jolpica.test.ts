import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { lapCandidates, matchRace, type Ours } from '../src/jolpica/attach.ts';
import { type Dump, duration, loadDump, type Round } from '../src/jolpica/dump.ts';
import { meetingKey, sessionKey, TT } from '../src/jolpica/keys.ts';
import { type RoundRows, roundRows, type SessionRows, zoneOffset } from '../src/jolpica/rows.ts';

// The Jolpica rows from the synthetic dump in fixtures/jolpica/ (the real header lines; invented ids, names, circuits
// and times, CRLF). Expected values are literals read off the fixture files.

const FIXTURES = join(import.meta.dirname, 'fixtures/jolpica');
let dump: Dump;
beforeAll(async () => {
  dump = await loadDump(FIXTURES, () => true);
});

const round = (year: number, number: number): Round => {
  const r = [...dump.rounds.values()].find((x) => x.year === year && x.number === number);
  if (!r) throw new Error('no such fixture round');
  return r;
};
const built = (year: number, number: number): RoundRows => {
  const r = roundRows(dump, round(year, number));
  if (!r.ok || r.value === undefined) throw new Error('no rows');
  return r.value;
};
const session = (rows: RoundRows, type: SessionRows['type']): SessionRows => {
  const s = rows.sessions.find((x) => x.type === type);
  if (!s) throw new Error(`no ${type}`);
  return s;
};
/** The result rows without their constant columns, by driver number. */
const results = (s: SessionRows) =>
  Object.fromEntries(s.result.map(({ session_key, source, driver_number, ...r }) => [driver_number, r]));
const final = { ingest_state: 'final', next_fetch_at: null, fetch_count: 1, fail_count: 0, last_error: null };
const noSkips = { dnq: 0, no_number: 0, lap_dup: 0, bad_pit: 0, pit_dup: 0 };

describe('keys', () => {
  it('meeting 1YYYYRR and session 1YYYYRRTT, 1950–2017 and rounds 1–99 only', () => {
    expect(TT).toEqual({ FP1: 1, FP2: 2, FP3: 3, Qualifying: 4, Race: 5 });
    expect(meetingKey(1950, 1)).toBe(1_195_001);
    expect(meetingKey(2017, 99)).toBe(1_201_799);
    expect(sessionKey(1_201_799, 'Race')).toBe(120_179_905);
    expect(sessionKey(1_195_001, 'Qualifying')).toBe(119_500_104);
    for (const [y, r] of [
      [1949, 1],
      [2018, 1],
      [1950, 0],
      [1950, 100],
      [1950.5, 1],
      [1950, Number.NaN],
    ] as const)
      expect(meetingKey(y, r)).toBeUndefined();
    expect(String(sessionKey(1_201_799, 'Race'))).toMatch(/^\d{1,9}$/);
  });

  it('a round without a number or outside the years is bad_key', () => {
    const r = round(1950, 1);
    expect(roundRows(dump, { ...r, number: null })).toEqual({ ok: false, error: 'bad_key' });
    expect(roundRows(dump, { ...r, number: 100 })).toEqual({ ok: false, error: 'bad_key' });
    expect(roundRows(dump, { ...r, year: 1949 })).toEqual({ ok: false, error: 'bad_key' });
  });
});

describe('duration and zones', () => {
  it.each([
    ['00:01:19.5', 79_500],
    ['00:01:15.123', 75_123],
    ['02:01:02.5', 7_262_500],
    ['01:35:00.1', 5_700_100],
    ['00:00:22', 22_000],
    ['00:00:22.', 22_000],
    ['1:30:00.05', 5_400_050],
  ])('%s is %i ms', (text, ms) => {
    expect(duration(text)).toBe(ms);
  });
  it.each([['1:2:3'], ['00:60:00'], ['00:00:60'], ['100:00:00'], ['00:01:19.1234'], ['-00:01:00'], ['1:19.5']])(
    '%s is no duration',
    (text) => {
      expect(duration(text)).toBeUndefined();
    },
  );
  it('null stays null, and the dump counts the one bad lap time', () => {
    expect(duration(null)).toBeNull();
    expect(dump.badTime).toBe(1);
  });
  it('offsets in OpenF1 form, without a +', () => {
    expect(zoneOffset('Asia/Kolkata', Date.parse('2010-01-01T00:00:00Z'))?.text).toBe('05:30:00');
    expect(zoneOffset('America/St_Johns', Date.parse('2010-01-01T00:00:00Z'))?.text).toBe('-03:30:00');
    expect(zoneOffset('UTC', 0)).toEqual({ text: '00:00:00', ms: 0 });
    expect(zoneOffset('Europe/Madrid', Date.parse('2014-05-11T12:00:00Z'))).toEqual({
      text: '02:00:00',
      ms: 7_200_000,
    });
    expect(zoneOffset('Nowhere/Zone', 0)).toBeUndefined();
  });
});

describe('rows', () => {
  it('1950: a results-only race without time data (E4), a shared drive and no car number (E3), a DNQ', () => {
    const rows = built(1950, 1);
    expect(rows.meeting).toEqual({
      meeting_key: 1_195_001,
      source: 'jolpica',
      year: 1950,
      name: 'Alpha Grand Prix',
      official_name: null,
      location: 'Testville',
      country_code: 'XTL',
      circuit_short_name: 'Test Ring',
      gmt_offset: null,
      date_start: '1950-05-13T00:00:00.000Z',
      date_end: '1950-05-13T00:00:00.000Z',
      is_cancelled: false,
    });
    expect(rows.sessions.map((s) => s.type)).toEqual(['Race']); // the QB without entries is no session
    const race = session(rows, 'Race');
    expect(race.session).toEqual({
      session_key: 119_500_105,
      source: 'jolpica',
      meeting_key: 1_195_001,
      type: 'Race',
      name: 'Race',
      date_start: '1950-05-13T00:00:00.000Z',
      date_end: '1950-05-13T00:00:00.000Z',
      is_cancelled: false,
      ...final,
    });
    // Entry order is by id (101 before 102), not file order: 101 keeps car 10, 102 shares it, 103 has none.
    expect(race.driver).toEqual([
      {
        session_key: 119_500_105,
        source: 'jolpica',
        driver_number: 10,
        acronym: null,
        full_name: 'Driver Alpha',
        team_name: 'Team One',
        team_colour: null,
      },
      {
        session_key: 119_500_105,
        source: 'jolpica',
        driver_number: 1001,
        acronym: 'DBR',
        full_name: 'Driver Bravo',
        team_name: 'Team Two',
        team_colour: '12AB34',
      },
      {
        session_key: 119_500_105,
        source: 'jolpica',
        driver_number: 1002,
        acronym: null,
        full_name: 'Driver Charlie',
        team_name: 'Team One',
        team_colour: null,
      },
    ]);
    const flags = { dnf: false, dns: false, dsq: false };
    expect(results(race)).toEqual({
      10: { position: 1, laps: 50, grid: 2, ...flags, durations_ms: [7_262_500], gaps_ms: [0] },
      1001: { position: 2, laps: 50, grid: 1, ...flags, durations_ms: [7_270_000], gaps_ms: [7_500] },
      1002: { position: null, laps: 20, grid: 3, ...flags, dnf: true, durations_ms: [null], gaps_ms: [null] },
    });
    expect(race.renumbered).toBe(2);
    expect(race.skipped).toEqual({ ...noSkips, dnq: 1 });
    expect(race.lap).toEqual([]);
    expect(race.pit).toEqual([]);
  });

  it('1994: two QB sessions collapse into one qualifying; the position of the last part with one', () => {
    const rows = built(1994, 3);
    const q = session(rows, 'Qualifying');
    expect(q.key).toBe(119_940_304);
    expect(q.session).toMatchObject({
      type: 'Qualifying',
      name: 'Qualifying',
      date_start: '1994-04-29T00:00:00.000Z',
      date_end: '1994-04-29T00:00:00.000Z',
    });
    const none = { laps: null, grid: null, dnf: null, dns: null, dsq: null };
    expect(results(q)).toEqual({
      1: { position: 2, ...none, durations_ms: [79_500, 79_900], gaps_ms: [0, 900] },
      2: { position: 1, ...none, durations_ms: [81_000, 79_000], gaps_ms: [1_500, 0] },
      3: { position: 3, ...none, durations_ms: [null, null], gaps_ms: [null, null] }, // only in the first part
    });
    const race = session(rows, 'Race');
    expect(results(race)).toEqual({
      1: {
        position: 1,
        laps: 60,
        grid: 2,
        dnf: false,
        dns: false,
        dsq: false,
        durations_ms: [6_000_000],
        gaps_ms: [0],
      },
      2: { position: 2, laps: 59, grid: 1, dnf: false, dns: false, dsq: false, durations_ms: [null], gaps_ms: [null] },
      3: { position: null, laps: 0, grid: 3, dnf: false, dns: true, dsq: false, durations_ms: [null], gaps_ms: [null] },
    });
    expect(rows.meeting).toMatchObject({
      gmt_offset: null,
      date_start: '1994-04-29T00:00:00.000Z',
      date_end: '1994-05-01T00:00:00.000Z',
      country_code: 'XSP',
      circuit_short_name: 'Sample Park, "East"', // a quoted field with a comma and doubled quotes
    });
  });

  it('1996: a single-QB qualifying and race laps without pit data (is_pit_out null)', () => {
    const rows = built(1996, 2);
    const q = session(rows, 'Qualifying');
    expect(q.result.map((r) => [r.driver_number, r.position, r.durations_ms, r.gaps_ms])).toEqual([
      [5, 1, [75_123], [0]],
      [6, 2, [75_456], [333]],
    ]);
    const race = session(rows, 'Race');
    expect(race.lap.map((l) => [l.driver_number, l.lap_number, l.lap_ms, l.is_pit_out])).toEqual([
      [5, 1, 100_000, null],
      [5, 2, 99_500, null],
      [6, 1, 101_000, null],
      [6, 2, 100_000, null],
    ]);
  });

  it('2005: two QA sessions in session-number order, and a race with laps, a null-number lap skipped', () => {
    const rows = built(2005, 1);
    const q = session(rows, 'Qualifying');
    expect(q.session).toMatchObject({ date_start: '2005-03-05T03:00:00.000Z', date_end: '2005-03-06T00:30:00.000Z' });
    expect(q.result.map((r) => [r.driver_number, r.position, r.durations_ms, r.gaps_ms])).toEqual([
      [7, 1, [85_000, 84_800], [500, 0]],
      [8, 2, [84_500, 85_100], [0, 300]],
      [9, 3, [86_000, null], [1_500, null]],
    ]);
    const race = session(rows, 'Race');
    expect(race.session).toMatchObject({
      date_start: '2005-03-06T03:00:00.000Z',
      date_end: '2005-03-06T05:00:00.000Z',
    });
    expect(race.lap.map((l) => [l.driver_number, l.lap_number, l.lap_ms, l.is_pit_out])).toEqual([
      [7, 1, 91_000, null],
      [7, 2, 90_500, null],
      [7, 3, 90_250, null],
      [8, 1, 91_500, null],
      [8, 2, 91_000, null],
      [8, 3, 90_900, null],
      [9, 1, null, null], // a bad time is a null lap time
    ]);
    expect(race.lap[0]).toEqual({
      session_key: 120_050_105,
      source: 'jolpica',
      driver_number: 7,
      lap_number: 1,
      date_start: null,
      lap_ms: 91_000,
      is_pit_out: null,
    });
    expect(race.skipped).toEqual({ ...noSkips, no_number: 1 });
    expect(results(race)[9]).toMatchObject({ position: null, dnf: true, durations_ms: [null], gaps_ms: [null] });
    expect(results(race)[8]).toMatchObject({ durations_ms: [5_405_250], gaps_ms: [5_250] });
    expect(rows.meeting).toMatchObject({
      gmt_offset: '11:00:00',
      date_start: '2005-03-05T03:00:00.000Z',
      date_end: '2005-03-06T05:00:00.000Z',
    });
  });

  it('2010: Q1–Q3 with per-part durations and gaps, the position of the last part', () => {
    const rows = built(2010, 4);
    const q = session(rows, 'Qualifying');
    expect(q.key).toBe(120_100_404);
    expect(q.session).toMatchObject({ date_start: '2010-04-03T08:00:00.000Z', date_end: '2010-04-03T09:50:00.000Z' });
    expect(q.result.map((r) => [r.driver_number, r.position, r.durations_ms, r.gaps_ms])).toEqual([
      [1, 2, [94_000, 93_000, 92_800], [500, 0, 300]],
      [2, 1, [93_500, 93_200, 92_500], [0, 200, 0]],
      [3, 3, [96_000, 94_100, null], [2_500, 1_100, null]],
      [4, 4, [97_000, null, null], [3_500, null, null]],
    ]);
    expect(q.result.every((r) => r.laps === null && r.dnf === null && r.dns === null && r.dsq === null)).toBe(true);
    expect(q.driver.map((d) => d.driver_number)).toEqual([1, 2, 3, 4]);
    expect(q.lap).toEqual([]);
    expect(rows.meeting.gmt_offset).toBe('08:00:00');
  });

  it('2014: laps with a pit stop (the out-lap, the pit date in UTC from local time and zone, the ms)', () => {
    const rows = built(2014, 5);
    expect(rows.sessions.map((s) => s.type)).toEqual(['Race']); // FP1 is not imported
    const race = session(rows, 'Race');
    expect(race.pit).toEqual([
      {
        session_key: 120_140_505,
        source: 'jolpica',
        driver_number: 44,
        lap_number: 2,
        date: '2014-05-11T12:25:30.000Z', // 14:25:30 in Madrid (CEST)
        pit_ms: 22_500,
        lane_ms: 22_500,
        stop_ms: null,
      },
    ]);
    expect(race.skipped).toEqual({ ...noSkips, no_number: 1, pit_dup: 1 });
    expect(race.lap.map((l) => [l.driver_number, l.lap_number, l.is_pit_out])).toEqual([
      [44, 1, false],
      [44, 2, false],
      [44, 3, true],
      [6, 1, false],
      [6, 2, false],
      [6, 3, false],
    ]);
    expect(rows.meeting.gmt_offset).toBe('02:00:00');
    expect(race.session).toMatchObject({
      date_start: '2014-05-11T12:00:00.000Z',
      date_end: '2014-05-11T14:00:00.000Z',
    });
  });

  it('a 2018 race yields no rows here', () => {
    expect(roundRows(dump, round(2018, 1))).toEqual({ ok: true, value: undefined });
  });
});

describe('the 2018+ tier', () => {
  const T = Date.parse('2018-03-25T05:10:00Z');
  const HOUR = 3_600_000;
  const race = (session_key: number, date_start: number, o: Partial<Ours> = {}): Ours => ({
    session_key,
    source: 'openf1',
    type: 'Race',
    name: 'Race',
    is_cancelled: false,
    date_start,
    ...o,
  });

  it('matches the one race within 1 h, an archive race too', () => {
    expect(matchRace(T, [race(1, T)])).toEqual({ ok: true, value: 1 });
    expect(matchRace(T, [race(1, T + HOUR)])).toEqual({ ok: true, value: 1 });
    expect(matchRace(T, [race(1, T - HOUR, { source: 'f1-archive' })])).toEqual({ ok: true, value: 1 });
  });

  it('just outside 1 h, a sprint, a cancelled race or another source is no match', () => {
    for (const s of [
      race(1, T + HOUR + 1),
      race(1, T - HOUR - 1),
      race(1, T, { name: 'Sprint' }),
      race(1, T, { name: 'Sprint Qualifying' }),
      race(1, T, { type: 'Qualifying', name: 'Qualifying' }),
      race(1, T, { is_cancelled: true }),
      race(1, T, { source: 'jolpica' }),
      race(1, T, { source: 'f1-live' }),
    ])
      expect(matchRace(T, [s])).toEqual({ ok: false, error: 'no_match' });
    expect(matchRace(T, [])).toEqual({ ok: false, error: 'no_match' });
  });

  it('a sprint at the same weekend leaves the race the only match; two races are ambiguous', () => {
    expect(matchRace(T, [race(1, T - 1800_000, { name: 'Sprint' }), race(2, T)])).toEqual({ ok: true, value: 2 });
    expect(matchRace(T, [race(1, T), race(2, T + 60_000, { source: 'f1-archive' })])).toEqual({
      ok: false,
      error: 'ambiguous',
    });
    expect(matchRace(T, [race(1, T), race(2, T, { is_cancelled: true })])).toEqual({ ok: true, value: 1 });
  });

  it('lap candidates carry the number and time of known drivers only', () => {
    const r = round(2018, 1).sessions.find((s) => s.type === 'R');
    if (!r) throw new Error('no race');
    const { lap, skipped } = lapCandidates(dump, r, 7, new Set([33, 5]));
    expect(skipped).toEqual({ unknown_driver: 2, no_number: 1, lap_dup: 0 });
    expect(lap.map((l) => [l.driver_number, l.lap_number, l.lap_ms])).toEqual([
      [33, 1, 90_000],
      [33, 2, 91_000],
      [33, 3, 92_000],
      [33, 4, 93_000],
    ]);
    for (const l of lap)
      expect(l).toEqual({
        session_key: 7,
        source: 'jolpica',
        driver_number: 33,
        lap_number: l.lap_number,
        lap_ms: l.lap_ms,
        date_start: null,
        is_pit_out: null,
      });
  });
});
