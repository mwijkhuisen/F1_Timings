import { describe, expect, it } from 'vitest';
import {
  type Lap,
  Laps,
  Pits,
  RaceControl,
  Season,
  Seasons,
  SessionDetail,
  Status,
  Stints,
  sectorDeltas,
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

// [schema, valid sample, key whose value must not be null (a NOT NULL column)]
const cases = [
  ['Seasons', Seasons, [{ year: 2026, meetings: 24, sessions: 100 }], 'sessions'],
  ['Season', Season, [{ ...seasonMeeting, sessions: [{ ...session, meeting_key: undefined }] }], 'is_cancelled'],
  [
    'SessionDetail',
    SessionDetail,
    {
      session,
      meeting,
      drivers: [{ driver_number: 1, acronym: null, full_name: null, team_name: null, team_colour: null }],
      results: [
        {
          driver_number: 1,
          position: null,
          laps: null,
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

describe('Laps', () => {
  it('rejects an unknown colour and a non-integer duration', () => {
    expect(Laps.safeParse([lap({ colour: { lap: 'red' as 'purple', s1: null, s2: null, s3: null } })]).success).toBe(
      false,
    );
    expect(Laps.safeParse([lap({ lap_ms: 90.5 })]).success).toBe(false);
  });
});

describe('sectorDeltas', () => {
  it('sectorDeltas: b − a; null when either value is null or either lap is deleted', () => {
    const a = [
      lap({ lap_number: 1, s1_ms: 30_000, s2_ms: 31_000, s3_ms: null }),
      lap({ lap_number: 2, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000, deleted: true }),
      lap({ lap_number: 3, s1_ms: 30_000, s2_ms: 30_000, s3_ms: 30_000 }),
      lap({ lap_number: 4 }),
    ];
    const b = [
      lap({ lap_number: 1, s1_ms: 29_500, s2_ms: null, s3_ms: 30_000 }),
      lap({ lap_number: 2, s1_ms: 29_000, s2_ms: 29_000, s3_ms: 29_000 }),
      lap({ lap_number: 3, s1_ms: 30_250, s2_ms: 29_000, s3_ms: 30_000, deleted: true }),
      lap({ lap_number: 5 }),
    ];
    expect(sectorDeltas(a, b)).toEqual([
      { lap_number: 1, s1: -500, s2: null, s3: null },
      { lap_number: 2, s1: null, s2: null, s3: null },
      { lap_number: 3, s1: null, s2: null, s3: null },
    ]);
    expect(sectorDeltas(a, [lap({ lap_number: 3, s1_ms: 30_250, s2_ms: 29_000, s3_ms: 30_000 })])).toEqual([
      { lap_number: 3, s1: 250, s2: -1000, s3: 0 },
    ]);
    expect(sectorDeltas(a.slice(3), [lap({ lap_number: 4, s1_ms: null })])).toEqual([
      { lap_number: 4, s1: null, s2: 0, s3: 0 },
    ]);
  });
});
