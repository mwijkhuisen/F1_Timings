import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIRCUITS } from '@f1/contracts';
import { describe, expect, it } from 'vitest';

// The circuit outline files (P5c, ADR-0008): small, path data only, and exactly one per circuit of the table. The OSM
// layers under map/osm/ have their own test (map-osm.test.ts).

const dir = fileURLToPath(new URL('../src/map', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('the outline files', () => {
  it('are one per CIRCUITS id, and no more', () => {
    const ids = new Set(Object.values(CIRCUITS).map((c) => c.id));
    expect(ids.size).toBe(Object.keys(CIRCUITS).length);
    expect(files.map((f) => f.slice(0, -'.json'.length)).sort()).toEqual([...ids].sort());
  });

  it.each(files)('%s is at most 40 KiB and holds only an outline of M, L and Z commands', (f) => {
    const path = join(dir, f);
    expect(statSync(path).size).toBeLessThanOrEqual(40_960);
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(data as object)).toEqual(['outline']);
    expect((data as { outline: unknown }).outline).toMatch(/^[MLZ0-9 .-]+$/);
  });
});
