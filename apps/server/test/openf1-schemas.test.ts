import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normaliseSession } from '../src/ingest/normalise.ts';
import { ENDPOINTS, type Endpoint, type Lap, type Pit, parse, schemas } from '../src/openf1/schemas.ts';

const FIXTURES = join(import.meta.dirname, '../src/openf1/fixtures');
const names = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.raw'))
  .map((file) => file.slice(0, -'.raw'.length));
const read = (file: string): unknown => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
const endpointOf = (name: string) => name.slice(0, name.lastIndexOf('-')) as Endpoint;

describe('fixtures', () => {
  it('every endpoint has a normal and an empty fixture', () => {
    for (const endpoint of ENDPOINTS) {
      expect(names).toEqual(expect.arrayContaining([`${endpoint}-normal`, `${endpoint}-empty`]));
    }
  });

  it.each(names)('%s parses to its golden', (name) => {
    expect(parse(endpointOf(name), read(`${name}.raw`))).toEqual({ ok: true, value: read(`${name}.golden.json`) });
  });
});

describe('parse', () => {
  const fields = [...new Set(Object.values(schemas).flatMap((schema) => Object.keys(schema.element.shape)))];

  it('never throws on arbitrary JSON: a typed value or a typed shape error', () => {
    const body = fc.oneof(fc.jsonValue(), fc.array(fc.dictionary(fc.constantFrom(...fields), fc.jsonValue())));
    fc.assert(
      fc.property(fc.constantFrom(...ENDPOINTS), body, (endpoint, value) => {
        const result = parse(endpoint, value);
        if (result.ok) {
          expect(Array.isArray(result.value)).toBe(true);
          return;
        }
        expect(result.error.code).toBe('shape');
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues.length).toBeLessThanOrEqual(10);
        for (const issue of result.error.issues) {
          expect(Object.keys(issue)).toEqual(['path', 'code']);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('names the field but never its value', () => {
    const [lap] = read('laps-normal.raw') as Lap[];
    const result = parse('laps', [{ ...lap, lap_duration: 'value-from-the-body' }]);
    expect(result).toEqual({
      ok: false,
      error: { code: 'shape', issues: [{ path: '[0].lap_duration', code: 'invalid_type' }] },
    });
  });
});

// Values the P1b backfill met in real 2023–2026 data, outside the four scanned sessions:
// 11384 a string position, 11246/11342 a null compound, 11275 a null number_of_laps.
describe('real-data values beyond the scan (synthetic rows from the fixtures)', () => {
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  const rows = (file: string) => read(file) as Record<string, unknown>[];

  it('a string position, a null or missing number_of_laps and a null compound parse and normalise', () => {
    const [p1, p2, p3, p4] = rows('session_result-normal.raw');
    const { number_of_laps: _, ...p4WithoutLaps } = p4 ?? {};
    const results = value(
      parse('session_result', [
        { ...p1, position: '1' },
        { ...p2, position: 'DQ', number_of_laps: null },
        { ...p3, position: null },
        p4WithoutLaps,
      ]),
    );
    const stints = value(parse('stints', [{ ...rows('stints-normal.raw')[0], compound: null }]));
    const none = { drivers: [], laps: [], pit: [], race_control: [], weather: [] };
    const { rows: out } = normaliseSession(11388, { ...none, stints, session_result: results }, 'Race');
    expect(out.result.map((r) => [r.driver_number, r.position, r.laps])).toEqual([
      [3, 1, 62],
      [16, null, null],
      [12, null, 62],
      [1, 4, null],
    ]);
    expect(out.stint).toEqual([expect.objectContaining({ driver_number: 23, stint_number: 1, compound: null })]);
  });

  it('rejects, by path, a value its column could not hold', () => {
    const [lap] = rows('laps-normal.raw');
    const issues = (body: unknown) => {
      const result = parse('laps', body);
      return result.ok ? [] : result.error.issues.map((i) => i.path);
    };
    expect(issues([{ ...lap, lap_number: 1.5 }])).toEqual(['[0].lap_number']); // smallint
    expect(issues([{ ...lap, i1_speed: 40_000 }])).toEqual(['[0].i1_speed']); // smallint km/h
    expect(issues([{ ...lap, lap_duration: 3e6 }])).toEqual(['[0].lap_duration']); // int ms
    expect(issues([{ ...lap, session_key: null }])).toEqual(['[0].session_key']); // a key
    // timestamptz: year ≥ 0001 and an offset within ±15:59
    const at = (date_start: string) => issues([{ ...lap, date_start }]);
    expect(at('0000-01-01T00:00:00Z')).toEqual(['[0].date_start']);
    expect(at('2026-10-11T12:00:00+23:59')).toEqual(['[0].date_start']);
    expect(at('2026-10-11T12:00:00-16:00')).toEqual(['[0].date_start']);
    expect(at('2026-10-11T12:00:00+15:59')).toEqual([]);
    expect(at('2026-10-11T12:00:00-15:59')).toEqual([]);
    expect(at('0001-01-01T00:00:00Z')).toEqual([]);
    expect(at('2023-09-15T09:30:00.095000+00:00')).toEqual([]);
    const [driver] = rows('drivers-normal.raw');
    const nul = parse('drivers', [{ ...driver, full_name: 'a\u0000b' }]);
    expect(nul.ok ? [] : nul.error.issues.map((i) => i.path)).toEqual(['[0].full_name']); // text without NUL
  });

  // P5a: real columns (float4) refuse ±3.4e38 and beyond, and a non-zero value that would round to 0.
  it('weather: rejects, by path, a value its real or smallint column could not hold; nulls stay null', () => {
    const [w] = rows('weather-normal.raw');
    const issues = (body: unknown) => {
      const result = parse('weather', body);
      return result.ok ? [] : result.error.issues.map((i) => i.path);
    };
    expect(issues([{ ...w, rainfall: 0.5 }])).toEqual(['[0].rainfall']); // smallint
    expect(issues([{ ...w, wind_direction: 40_000 }])).toEqual(['[0].wind_direction']); // smallint
    expect(issues([{ ...w, air_temperature: 1e39 }])).toEqual(['[0].air_temperature']); // real overflow
    expect(issues([{ ...w, track_temperature: -1e-40 }])).toEqual(['[0].track_temperature']); // real underflow
    expect(issues([{ ...w, humidity: '69.1' }])).toEqual(['[0].humidity']);
    expect(issues([{ ...w, date: null }])).toEqual(['[0].date']); // the row key
    expect(issues([{ ...w, pressure: 3.4e38, wind_speed: 1e-37, air_temperature: 0 }])).toEqual([]);
    const { humidity: _, ...missing } = w ?? {};
    const parsed = parse('weather', [{ ...missing, rainfall: null }]);
    expect(parsed.ok && parsed.value[0]).toMatchObject({ humidity: null, rainfall: null });
  });
});

// [U] facts of the weather endpoint (A§6.1), pinned on the fixtures: about one sample a minute, rows before the
// session's date_start, rainfall 0 or 1, and the JSON types of humidity and wind_direction.
describe('[U] the weather fixtures', () => {
  type W = { date: string; humidity: unknown; wind_direction: unknown; rainfall: unknown };
  const weather = (name: string) => read(`weather-${name}.raw`) as W[];
  const CASES = [
    // [fixture, session date_start, rows before it, rainfall 1 rows]
    ['normal', '2026-10-11T12:00:00Z', 53, 0],
    ['wet', '2024-11-03T15:30:00Z', 52, 117],
    ['quali', '2026-10-24T21:00:00Z', 13, 0],
    ['sprint', '2026-10-10T09:00:00Z', 43, 20],
  ] as const;

  it.each(CASES)('%s: a sample every 60 ± 0.5 s, %s', (name, start, before, wet) => {
    const rows = weather(name);
    const t = rows.map((r) => Date.parse(r.date));
    for (let i = 1; i < t.length; i++) expect(Math.abs((t[i] ?? 0) - (t[i - 1] ?? 0) - 60_000)).toBeLessThan(500);
    expect(t.filter((x) => x < Date.parse(start))).toHaveLength(before);
    expect(new Set(rows.map((r) => r.rainfall))).toEqual(new Set(wet > 0 ? [0, 1] : [0]));
    expect(rows.filter((r) => r.rainfall === 1)).toHaveLength(wet);
    for (const r of rows) {
      expect(typeof r.humidity).toBe('number');
      expect(Number.isInteger(r.wind_direction)).toBe(true);
    }
  });

  // A dropout comes as 0, not null: the web reads a 0 temperature, humidity or pressure as no reading (A§6.1, A§13).
  it('normal: one track temperature of 0 between 43 °C samples, a sensor dropout; no other zero reading', () => {
    type V = Record<'date' | 'air_temperature' | 'track_temperature' | 'humidity' | 'pressure', unknown>;
    const zeros = CASES.flatMap(([name]) =>
      (read(`weather-${name}.raw`) as V[]).flatMap((r, i, all) =>
        (['air_temperature', 'track_temperature', 'humidity', 'pressure'] as const)
          .filter((k) => r[k] === 0)
          .map((k) => [name, r.date, k, all[i - 1]?.[k], all[i + 1]?.[k]]),
      ),
    );
    expect(zeros).toEqual([['normal', '2026-10-11T11:32:56.866000+00:00', 'track_temperature', 43.1, 43.4]]);
  });
});

// [U] facts of the starting_grid endpoint (#115, A§6.1), pinned on the fixtures recorded 2026-11-13: the grid is linked
// to the qualifying session (the race's own key has none, br-g/openf1#356), positions 1…22 without a gap, and a car
// without a qualifying time still has a position.
describe('[U] the starting_grid fixtures', () => {
  type G = { session_key: number; position: number | null; lap_duration: number | null };
  const grid = (name: string) => read(`starting_grid-${name}.raw`) as G[];

  it.each(['racekey', 'empty'])('%s is empty (404 "No results found.")', (name) => {
    expect(grid(name)).toEqual([]);
  });

  it.each([
    // [fixture, its qualifying's session_key, null lap_duration rows]
    ['normal', 11384, 1],
    ['sprint', 11379, 2],
    ['edge', 11400, 1],
  ] as const)('%s: 22 rows of session %i, positions 1…22, %i without a lap time', (name, key, untimed) => {
    const rows = grid(name);
    expect(rows).toHaveLength(22);
    expect(new Set(rows.map((r) => r.session_key))).toEqual(new Set([key]));
    expect(rows.map((r) => r.position).toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    expect(rows.filter((r) => r.lap_duration === null)).toHaveLength(untimed);
  });
});

// [U] pit.lap_number = in-lap (A§6.1, A§9). Proven per session type over the fixture rows:
// in a race or sprint the out-lap is pit.lap_number + 1, in qualifying it is pit.lap_number itself.
describe('[U] pit.lap_number against the out-laps', () => {
  it.each([
    ['normal', 1],
    ['sprint', 1],
    ['quali', 0],
  ])('%s: the out-lap is pit.lap_number + %i', (name, offset) => {
    const laps = read(`laps-${name}.golden.json`) as Lap[];
    const pits = read(`pit-${name}.golden.json`) as Pit[];
    const key = (driver: number, lap: number) => `${driver}/${lap}`;
    const recorded = new Set(laps.map((l) => key(l.driver_number, l.lap_number)));
    const outLaps = new Set(laps.filter((l) => l.is_pit_out_lap).map((l) => key(l.driver_number, l.lap_number)));

    const checked = pits.filter((p) => recorded.has(key(p.driver_number, p.lap_number + offset)));
    expect(checked.length).toBeGreaterThan(0);
    for (const p of checked) expect(outLaps.has(key(p.driver_number, p.lap_number + offset))).toBe(true);
  });
});
