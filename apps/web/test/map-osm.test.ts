import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CIRCUITS } from '@f1/contracts';
import { describe, expect, test } from 'vitest';

// The OpenStreetMap layers (ADR-0008 route B): separate ODbL files, never mixed into the outline files.

const dir = join(import.meta.dirname, '../src/map/osm');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('apps/web/src/map/osm', () => {
  test('a file per circuit', () => {
    expect(files.sort()).toEqual(
      Object.values(CIRCUITS)
        .map((c) => `${c.id}.json`)
        .sort(),
    );
  });

  for (const f of files) {
    test(`${f}: size, keys, notice and path grammar`, () => {
      expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(40_960);
      const o = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(o)).toEqual(['attribution', 'licence', 'water', 'coast', 'roads']);
      expect(o.attribution).toBe('© OpenStreetMap contributors');
      expect(o.licence).toBe('ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/');
      for (const k of ['water', 'coast', 'roads']) expect(o[k]).toMatch(/^[MLZ0-9 .-]*$/);
    });
  }

  test('the README carries the ODbL notice', () => {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(readme).toContain('ODbL');
    expect(readme).toContain('https://opendatacommons.org/licenses/odbl/1-0/');
    expect(readme).toContain('https://www.openstreetmap.org/copyright');
  });
});
