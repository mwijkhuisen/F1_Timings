import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIRCUITS } from '@f1/contracts';
import { describe, expect, it } from 'vitest';

// The circuit outline files (P5c, ADR-0008; #91): small, path data and a viewBox only, and exactly one per circuit of
// the table. The OSM layers under map/osm/ have their own test (map-osm.test.ts).

const dir = fileURLToPath(new URL('../src/map', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
const PATH = /^[MLZ0-9 .-]+$/;

type Pt = [number, number];
/** The points of path data (M/L commands), in order. */
const points = (d: string): Pt[] =>
  [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)] as Pt);
/** Where the segments a–b and c–d cross, if they do. */
function cross([a, b]: [Pt, Pt], [c, d]: [Pt, Pt]): Pt | undefined {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (den === 0) return undefined;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : undefined;
}

describe('the outline files', () => {
  it('are one per CIRCUITS id, and no more', () => {
    const ids = new Set(Object.values(CIRCUITS).map((c) => c.id));
    expect(ids.size).toBe(Object.keys(CIRCUITS).length);
    expect(files.map((f) => f.slice(0, -'.json'.length)).sort()).toEqual([...ids].sort());
  });

  it.each(files)('%s is at most 40 KiB: an outline of M, L and Z, a viewBox, a start/finish bar at most', (f) => {
    expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(40_960);
    const data = read(f);
    expect(Object.keys(data)).toEqual(
      data.start === undefined ? ['outline', 'viewBox'] : ['outline', 'viewBox', 'start'],
    );
    expect(data.outline).toMatch(PATH);
    expect(data.viewBox).toMatch(/^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/);
    if (data.start !== undefined) expect(data.start).toMatch(/^M -?[\d.]+ -?[\d.]+ L -?[\d.]+ -?[\d.]+$/);
  });

  it.each(files)('%s: the viewBox holds every point of the outline and the bar', (f) => {
    const data = read(f);
    const [x, y, w, h] = (data.viewBox as string).split(' ').map(Number) as [number, number, number, number];
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    for (const [px, py] of [...points(data.outline as string), ...points(data.start ?? '')]) {
      expect(px).toBeGreaterThanOrEqual(x - 1e-9);
      expect(px).toBeLessThanOrEqual(x + w + 1e-9);
      expect(py).toBeGreaterThanOrEqual(y - 1e-9);
      expect(py).toBeLessThanOrEqual(y + h + 1e-9);
    }
  });

  const barred = files.filter((f) => read(f).start !== undefined);
  it('has at least one start/finish bar (the sourced table, #91)', () => {
    expect(barred.length).toBeGreaterThan(0);
  });

  it.each(barred)('%s: the start/finish bar crosses the outline within 50 m of its middle, across the track', (f) => {
    const data = read(f);
    const ring = points(data.outline as string);
    const [a, b] = points(data.start as string) as [Pt, Pt];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const hits = ring.flatMap((p, i) => {
      const q = ring[(i + 1) % ring.length] as Pt;
      const at = cross([a, b], [p, q]);
      return at ? [{ at, seg: [q[0] - p[0], q[1] - p[1]] as Pt }] : [];
    });
    // A bar through a vertex crosses both of its segments at one point: the nearest crossing counts.
    const dist = ({ at }: { at: Pt }) => Math.hypot(at[0] - mid[0], at[1] - mid[1]);
    const near = hits.filter((hit) => dist(hit) <= 0.05).sort((x, y) => dist(x) - dist(y));
    expect(near.length).toBeGreaterThan(0);
    // Within 15° of perpendicular to the segment it crosses.
    const { seg } = near[0] as { seg: Pt };
    const cos =
      Math.abs((b[0] - a[0]) * seg[0] + (b[1] - a[1]) * seg[1]) /
      Math.hypot(b[0] - a[0], b[1] - a[1]) /
      Math.hypot(...seg);
    expect(cos).toBeLessThan(Math.sin((15 * Math.PI) / 180));
  });
});
