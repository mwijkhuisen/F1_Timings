import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
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
