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
    const none = { drivers: [], laps: [], pit: [], race_control: [] };
    const { rows: out } = normaliseSession(11388, { ...none, stints, session_result: results });
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
    const [driver] = rows('drivers-normal.raw');
    const nul = parse('drivers', [{ ...driver, full_name: 'a\u0000b' }]);
    expect(nul.ok ? [] : nul.error.issues.map((i) => i.path)).toEqual(['[0].full_name']); // text without NUL
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
