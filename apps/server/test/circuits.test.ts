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

  // #91: F1's name, length and first World Championship GP for the season page's circuit line (formula1.com).
  for (const [name, c] of Object.entries(CIRCUITS)) {
    test(`${name}: a name, a length in metres and a first GP`, () => {
      expect(c.name.trim()).not.toBe('');
      expect(Number.isInteger(c.length_m)).toBe(true);
      expect(c.length_m).toBeGreaterThanOrEqual(3000);
      expect(c.length_m).toBeLessThanOrEqual(8000);
      expect(Number.isInteger(c.first_gp)).toBe(true);
      expect(c.first_gp).toBeGreaterThanOrEqual(1950);
      expect(c.first_gp).toBeLessThanOrEqual(2026);
    });
  }

  test("formula1.com's values win over bacinger's where they differ", () => {
    const pick = (n: string) => {
      const c = CIRCUITS[n];
      return c && { name: c.name, length_m: c.length_m, first_gp: c.first_gp };
    };
    expect(pick('Lusail')).toEqual({ name: 'Lusail International Circuit', length_m: 5419, first_gp: 2021 });
    expect(pick('Singapore')).toEqual({ name: 'Marina Bay Street Circuit', length_m: 4927, first_gp: 2008 });
    expect(pick('Austin')).toEqual({ name: 'Circuit of The Americas', length_m: 5513, first_gp: 2012 });
    expect(pick('Jeddah')).toEqual({ name: 'Jeddah Corniche Circuit', length_m: 6174, first_gp: 2021 });
    expect(pick('Catalunya')).toEqual({ name: 'Circuit de Barcelona-Catalunya', length_m: 4657, first_gp: 1991 });
    expect(pick('Monte Carlo')).toEqual({ name: 'Circuit de Monaco', length_m: 3337, first_gp: 1950 });
    expect(pick('Las Vegas')).toEqual({ name: 'Las Vegas Strip Circuit', length_m: 6201, first_gp: 2023 });
    expect(pick('Spielberg')).toEqual({ name: 'Red Bull Ring', length_m: 4326, first_gp: 1970 });
    expect(pick('Madring')).toEqual({ name: 'Madring', length_m: 5414, first_gp: 2026 });
    expect(pick('Suzuka')).toEqual({ name: 'Suzuka Circuit', length_m: 5807, first_gp: 1987 });
    expect(pick('Interlagos')).toEqual({ name: 'Autódromo José Carlos Pace', length_m: 4309, first_gp: 1973 });
    expect(pick('Imola')).toEqual({
      name: 'Autodromo Internazionale Enzo e Dino Ferrari',
      length_m: 4909,
      first_gp: 1980,
    });
  });

  test('[U] coordinate order: the GeoJSON is [lon, lat] (Monza is near 45.62 N, 9.28 E)', () => {
    const monza = CIRCUITS.Monza;
    expect(monza?.id).toBe('it-1922');
    expect(Math.abs((monza?.lat ?? 0) - 45.62)).toBeLessThan(0.01);
    expect(Math.abs((monza?.lon ?? 0) - 9.28)).toBeLessThan(0.01);
  });
});
