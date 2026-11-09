import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CIRCUITS } from '@f1/contracts';
import { describe, expect, test } from 'vitest';
import { centre, readOutlines } from '../../../scripts/map-extract.ts';

const root = join(import.meta.dirname, '../../..');
const fixtures = join(root, 'apps/server/src/openf1/fixtures');
const outlines = readOutlines();

const names = (file: string) =>
  (
    JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as {
      circuit_short_name: string | null;
      meeting_name: string;
    }[]
  )
    .map((m) => m.circuit_short_name)
    .filter((n): n is string => n !== null);

describe('the circuit table (P5c)', () => {
  for (const year of ['2023', '2024', '2025', 'year']) {
    test(`every circuit_short_name of meetings-${year} is a key of CIRCUITS`, () => {
      const found = names(`meetings-${year}.raw`);
      expect(found.length).toBeGreaterThan(20);
      expect(found.filter((n) => !(n in CIRCUITS))).toEqual([]);
    });
  }

  for (const [name, c] of Object.entries(CIRCUITS)) {
    test(`${name}: ${c.id} is in the GeoJSON, centred, with a map file`, () => {
      const outline = outlines.get(c.id);
      expect(outline).toBeDefined();
      expect([c.lat, c.lon]).toEqual(centre(outline ?? []));
      expect(existsSync(join(root, 'apps/web/src/map', `${c.id}.json`))).toBe(true);
    });
  }

  test('[U] coordinate order: the GeoJSON is [lon, lat] (Monza is near 45.62 N, 9.28 E)', () => {
    const monza = CIRCUITS.Monza;
    expect(monza?.id).toBe('it-1922');
    expect(Math.abs((monza?.lat ?? 0) - 45.62)).toBeLessThan(0.01);
    expect(Math.abs((monza?.lon ?? 0) - 9.28)).toBeLessThan(0.01);
  });
});
