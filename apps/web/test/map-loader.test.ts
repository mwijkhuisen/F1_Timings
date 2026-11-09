import { describe, expect, it } from 'vitest';
import { loadCircuitMap } from '../src/lib/api.ts';

// The loader that useCircuitMap runs: Vitest transforms import.meta.glob as Vite does, so this reads the real bundled
// files through their default exports (P5c).

describe('loadCircuitMap', () => {
  it('reads the outline string and the OSM layers of Monza (it-1922)', async () => {
    const { outline, osm } = await loadCircuitMap('it-1922');
    expect(outline).toMatch(/^M -?\d/);
    expect(osm).not.toBeNull();
    for (const k of ['water', 'coast', 'roads'] as const) expect(typeof osm?.[k], k).toBe('string');
    expect(Object.keys(osm ?? {}).sort()).toEqual(['coast', 'roads', 'water']);
  });

  it('is null and null for an unknown map id', async () => {
    await expect(loadCircuitMap('xx-0000')).resolves.toEqual({ outline: null, osm: null });
  });
});
