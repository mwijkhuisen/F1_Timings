import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Lap,
  Laps,
  MAX_WEATHER_ROWS,
  Pits,
  RaceControl,
  Rain,
  Season,
  Seasons,
  SessionDetail,
  Status,
  Stints,
  sectorDeltas,
  Weather,
  weatherRow,
  withWeatherRow,
} from '../src/index.ts';

const iso = '2026-03-14T05:00:00.000Z';
const lap = (over: Partial<Lap> = {}): Lap => ({
  driver_number: 1,
  lap_number: 1,
  date_start: iso,
  lap_ms: 90_000,
  s1_ms: 30_000,
  s2_ms: 30_000,
  s3_ms: 30_000,
  i1_kph: 300,
  i2_kph: null,
  st_kph: 320,
  is_pit_out: null,
  is_pit_in: false,
  seg1: [2048, null],
  seg2: null,
  seg3: [],
  deleted: false,
  deleted_reason: null,
  quali_phase: null,
  compound: 'SOFT',
  colour: { lap: 'purple', s1: 'green', s2: 'yellow', s3: null },
  ...over,
});

const session = {
  session_key: 9000,
  meeting_key: 1200,
  type: 'Race',
  name: 'Race',
  date_start: iso,
  date_end: iso,
  ingest_state: 'final',
  is_cancelled: false,
};
const meeting = {
  meeting_key: 1200,
  year: 2026,
  name: null,
  official_name: null,
  location: null,
  country_code: null,
  circuit_short_name: null,
  gmt_offset: null,
  date_start: null,
  date_end: null,
  is_cancelled: false,
};
const { year: _year, ...seasonMeeting } = meeting;
// SessionDetail's session also says why data is missing (#99).
const detailSession = {
  ...session,
  source: 'openf1',
  fetch_count: 1,
  fail_count: 2,
  last_error: 'http_503',
  next_fetch_at: iso,
};

// [schema, valid sample, key whose value must not be null (a NOT NULL column)]
const cases = [
  ['Seasons', Seasons, [{ year: 2026, meetings: 24, sessions: 100 }], 'sessions'],
  ['Season', Season, [{ ...seasonMeeting, sessions: [{ ...session, meeting_key: undefined }] }], 'is_cancelled'],
  [
    'SessionDetail',
    SessionDetail,
    {
      session: detailSession,
      meeting,
      drivers: [{ driver_number: 1, acronym: null, full_name: null, team_name: null, team_colour: null }],
      results: [
        {
          driver_number: 1,
          position: null,
          laps: null,
          grid: 3,
          dnf: null,
          dns: null,
          dsq: null,
          durations_ms: [null, 90_000],
          gaps_ms: null,
        },
      ],
    },
    'drivers',
  ],
  ['Laps', Laps, [lap()], 'deleted'],
  [
    'Stints',
    Stints,
    [{ driver_number: 1, stint_number: 1, lap_start: null, lap_end: null, compound: null, tyre_age_at_start: null }],
    'stint_number',
  ],
  [
    'Pits',
    Pits,
    [{ driver_number: 1, lap_number: 5, date: null, pit_ms: null, lane_ms: null, stop_ms: 2300 }],
    'lap_number',
  ],
  [
    'RaceControl',
    RaceControl,
    [
      {
        date: iso,
        category: null,
        flag: null,
        scope: null,
        sector: null,
        driver_number: null,
        lap_number: null,
        qualifying_phase: null,
        message: null,
      },
    ],
    null,
  ],
  [
    'Status',
    Status,
    {
      revision: 'a'.repeat(40),
      states: { scheduled: 1, due: 0, fetched: 0, final: 2, failed: 1 },
      cancelled: 0,
      failed: [
        {
          session_key: 1,
          year: 2026,
          meeting_name: null,
          session_name: null,
          fail_count: 3,
          last_error: 'schema',
          next_fetch_at: null,
        },
      ],
      recorder: {
        state: 'recording',
        session_key: 1,
        meeting_name: null,
        session_name: 'Race',
        token_expires_at: '2026-11-01T12:00:00.000Z',
        last_error: null,
        warning: 'disk_low',
        stale: false,
        updated_at: '2026-11-01T12:00:00.000Z',
      },
      ingest: { last_sync_at: null, live_wait: false, last_tick_at: '2026-11-01T12:00:00.000Z', stale: false },
      rain: { states: { live: 0, final: 1, failed: 0 }, failed: [] },
      rc_unmatched: [{ session_key: 1, year: 2026, meeting_name: null, session_name: 'Race', rows: 2 }],
    },
    'cancelled',
  ],
] as const;

// The first object in a sample, where a key can be added or nulled.
const target = (sample: unknown): Record<string, unknown> => {
  const first = Array.isArray(sample) ? sample[0] : sample;
  return first as Record<string, unknown>;
};

describe.each(cases)('%s', (_name, schema, sample, notNull) => {
  const clone = () => structuredClone(sample) as unknown;
  // JSON round trip drops the `undefined` keys of the samples.
  const valid = () => JSON.parse(JSON.stringify(clone())) as unknown;

  it('parses a valid answer', () => {
    expect(schema.safeParse(valid()).success).toBe(true);
  });

  it('rejects an extra key', () => {
    const bad = valid();
    target(bad).extra = 1;
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it.skipIf(notNull === null)('rejects null in a NOT NULL field', () => {
    const bad = valid();
    target(bad)[notNull as string] = null;
    expect(schema.safeParse(bad).success).toBe(false);
  });
});

describe('SessionDetail', () => {
  const parse = (over: Record<string, unknown>) =>
    SessionDetail.safeParse({ session: { ...detailSession, ...over }, meeting, drivers: [], results: [] }).success;

  it('takes only a last_error of the CHECK list, never other text', () => {
    for (const code of ['http_429', 'rate_limited', 'timeout', 'network', 'schema', 'empty', 'db', 'unknown', null])
      expect(parse({ last_error: code }), String(code)).toBe(true);
    for (const text of ['http_5031', 'HTTP_503', 'boom', 'timeout ', 'schema\n', '<b>db</b>', ''])
      expect(parse({ last_error: text }), text).toBe(false);
  });

  it('takes a known source only', () => {
    for (const source of ['openf1', 'f1-archive', 'f1-live', 'jolpica']) expect(parse({ source })).toBe(true);
    expect(parse({ source: 'open-meteo' })).toBe(false);
  });
});

describe('Laps', () => {
  it('rejects an unknown colour and a non-integer duration', () => {
    expect(Laps.safeParse([lap({ colour: { lap: 'red' as 'purple', s1: null, s2: null, s3: null } })]).success).toBe(
      false,
    );
    expect(Laps.safeParse([lap({ lap_ms: 90.5 })]).success).toBe(false);
  });
});

describe('sectorDeltas', () => {
  it('sectorDeltas: b − a per sector and lap; null when either value is null or either lap is deleted', () => {
    const a = [
      lap({ lap_number: 1, s1_ms: 30_000, s2_ms: 31_000, s3_ms: null }),
      lap({ lap_number: 2, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000, deleted: true }),
      lap({ lap_number: 3, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000 }),
      lap({ lap_number: 4 }),
    ];
    const b = [
      lap({ lap_number: 1, lap_ms: 89_500, s1_ms: 29_500, s2_ms: null, s3_ms: 30_000 }),
      lap({ lap_number: 2, s1_ms: 29_000, s2_ms: 29_000, s3_ms: 29_000 }),
      lap({ lap_number: 3, s1_ms: 30_250, s2_ms: 29_000, s3_ms: 30_000, deleted: true }),
      lap({ lap_number: 5 }),
    ];
    expect(sectorDeltas(a, b)).toEqual([
      { lap_number: 1, s1: -500, s2: null, s3: null, lap: -500 },
      { lap_number: 2, s1: null, s2: null, s3: null, lap: null },
      { lap_number: 3, s1: null, s2: null, s3: null, lap: null },
    ]);
    expect(sectorDeltas(a, [lap({ lap_number: 3, s1_ms: 30_250, s2_ms: 29_000, s3_ms: 30_000 })])).toEqual([
      { lap_number: 3, s1: 250, s2: -1000, s3: 0, lap: 0 },
    ]);
    expect(sectorDeltas(a.slice(3), [lap({ lap_number: 4, s1_ms: null, lap_ms: null })])).toEqual([
      { lap_number: 4, s1: null, s2: 0, s3: 0, lap: null },
    ]);
  });
});

describe('weatherRow', () => {
  const t = Date.parse(iso);
  const air = (AirTemp: string) => weatherRow({ AirTemp }, t).air_temperature;

  it('reads a number from a non-blank string that fits the column', () => {
    expect(air('27.4')).toBe(27.4);
    expect(air('0')).toBe(0);
    expect(Object.is(air('-0'), 0)).toBe(true);
    expect(weatherRow({ WindDirection: '191' }, t).wind_direction).toBe(191);
  });

  it('is null for a blank, non-numeric, non-finite or out-of-column string', () => {
    for (const s of ['', '  ', 'abc', '1e400', '1e39', '1e-40']) expect(air(s)).toBeNull();
    expect(weatherRow({ Rainfall: '1.5' }, t).rainfall).toBeNull();
    expect(weatherRow({ WindDirection: '40000' }, t).wind_direction).toBeNull();
    expect(weatherRow({ AirTemp: '27.4' }, t).humidity).toBeNull();
  });

  it('is all null with the date for no view', () => {
    expect(weatherRow(undefined, t)).toEqual({
      date: iso,
      air_temperature: null,
      track_temperature: null,
      humidity: null,
      pressure: null,
      rainfall: null,
      wind_direction: null,
      wind_speed: null,
    });
  });

  it('never throws, and its row parses against Weather and survives JSON', () => {
    const keys = ['AirTemp', 'Humidity', 'Pressure', 'Rainfall', 'TrackTemp', 'WindDirection', 'WindSpeed'] as const;
    const value = fc.oneof(fc.string(), fc.double().map(String), fc.integer().map(String));
    fc.assert(
      fc.property(
        fc.record(Object.fromEntries(keys.map((k) => [k, value])) as Record<(typeof keys)[number], typeof value>, {
          requiredKeys: [],
        }),
        (w) => {
          const row = weatherRow(w, t);
          expect(Weather.parse([row])).toEqual([row]);
          expect(JSON.parse(JSON.stringify(row))).toEqual(row);
        },
      ),
    );
  });
});

describe('withWeatherRow', () => {
  const row = (t: number) => weatherRow(undefined, Date.parse(iso) + t);

  it('adds the row to a new array, the oldest dropped past MAX_WEATHER_ROWS', () => {
    const rows = Array.from({ length: MAX_WEATHER_ROWS }, (_, i) => row(i));
    const copy = [...rows];
    const next = withWeatherRow(rows, row(MAX_WEATHER_ROWS));
    expect(rows).toEqual(copy);
    expect(next).toHaveLength(MAX_WEATHER_ROWS);
    expect(next[0]).toEqual(row(1));
    expect(next.at(-1)).toEqual(row(MAX_WEATHER_ROWS));
    const few = [row(0)];
    expect(withWeatherRow(few, row(1))).toEqual([row(0), row(1)]);
    expect(few).toEqual([row(0)]);
    expect(withWeatherRow([], row(0))).toEqual([row(0)]);
  });
});

describe('Rain', () => {
  const grid = { map_id: 'x', centre_lat: 1.5, centre_lon: -2.5, size: 7, step_m: 1000, state: 'live' } as const;
  const frames = [{ date: iso, mm: [0, null, 0.25] }];

  it('takes a grid with frames, null elements, and no grid', () => {
    expect(Rain.parse({ grid, frames })).toEqual({ grid, frames });
    expect(Rain.parse({ grid: null, frames: [] })).toEqual({ grid: null, frames: [] });
  });

  it('rejects an unknown state, an extra key and a date that is not ISO UTC', () => {
    expect(Rain.safeParse({ grid: { ...grid, state: 'done' }, frames }).success).toBe(false);
    expect(Rain.safeParse({ grid: { ...grid, source: 'x' }, frames }).success).toBe(false);
    expect(Rain.safeParse({ grid, frames: [{ date: '2026-03-14 05:00', mm: [] }] }).success).toBe(false);
  });
});
