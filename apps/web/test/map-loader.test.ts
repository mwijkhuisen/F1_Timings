import { describe, expect, it } from 'vitest';
import { loadCircuitMap, loadOutline } from '../src/lib/api.ts';

// The loaders that useCircuitMap and useOutlines run: Vitest transforms import.meta.glob as Vite does, so this reads
// the real bundled files through their default exports (P5c, #91).

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

describe('loadOutline', () => {
  it("reads Silverstone's outline file: the outline, its viewBox and the start/finish bar", async () => {
    const o = await loadOutline('gb-1948');
    expect(Object.keys(o ?? {})).toEqual(['outline', 'viewBox', 'start']);
    expect(o?.outline).toBe((await loadCircuitMap('gb-1948')).outline);
    expect(o?.start).toMatch(/^M -?[\d.]+ -?[\d.]+ L -?[\d.]+ -?[\d.]+$/);
  });

  it('has no bar for a circuit without a sourced start/finish (Monza)', async () => {
    expect(Object.keys((await loadOutline('it-1922')) ?? {})).toEqual(['outline', 'viewBox']);
  });

  it('is null for an unknown map id', async () => {
    await expect(loadOutline('xx-0000')).resolves.toBeNull();
  });
});
