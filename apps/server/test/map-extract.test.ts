import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import {
  assembleRings,
  clipLine,
  clipRing,
  extract,
  GEOJSON,
  lineRuns,
  overpassQuery,
  roundPts,
  run,
  runsPath,
  simplify,
  startBar,
  waterRings,
} from '../../../scripts/map-extract.ts';

// Synthetic geometry only: no network, no Overpass data (ODbL 1.0 data is never in a test).

type Pt = [number, number];

describe('the OSM layers of map-extract (P5c, ADR-0008)', () => {
  test('three open ways out of order, one reversed, join into one closed ring', () => {
    const a: Pt[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const b: Pt[] = [
      [0, 1],
      [1, 1],
    ]; // runs the other way: (1,1) is its end, not its start
    const c: Pt[] = [
      [0, 1],
      [0, 0],
    ];
    const rings = assembleRings([c, a, b]);
    expect(rings).toHaveLength(1);
    const [ring] = rings as [Pt[]];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(new Set(ring.map((p) => p.join(','))).size).toBe(4);
  });

  test('a closed way is a ring; a chain that never closes is dropped', () => {
    const closed: Pt[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const open: Pt[] = [
      [5, 5],
      [6, 5],
      [6, 6],
    ];
    expect(assembleRings([closed, open])).toEqual([closed]);
  });

  test('Sutherland–Hodgman keeps the part of a square that is inside the box', () => {
    const square: Pt[] = [
      [0, 0],
      [12, 0],
      [12, 4],
      [0, 4],
    ];
    const clipped = clipRing(square, 6);
    expect(Math.max(...clipped.map((p) => p[0]))).toBe(6);
    expect(Math.min(...clipped.map((p) => p[0]))).toBe(0);
    expect(new Set(clipped.map((p) => p.join(','))).size).toBe(4);
    expect(
      clipRing(
        [
          [20, 20],
          [30, 20],
          [30, 30],
        ],
        6,
      ),
    ).toEqual([]);
  });

  test('Liang–Barsky splits a line that leaves and re-enters into two runs', () => {
    const runs = clipLine(
      [
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ],
      6,
    );
    expect(runs).toEqual([
      [
        [0, 0],
        [6, 0],
      ],
      [
        [6, 5],
        [0, 5],
      ],
    ]);
    expect(
      clipLine(
        [
          [7, 7],
          [9, 9],
        ],
        6,
      ),
    ).toEqual([]);
    expect(
      clipLine(
        [
          [0, 0],
          [1, 1],
        ],
        6,
      ),
    ).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
    ]);
  });

  test('simplify keeps the endpoints and drops points within the tolerance', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 0.001],
      [2, 0],
      [3, 1],
    ];
    expect(simplify(pts, 0.015)).toEqual([
      [0, 0],
      [2, 0],
      [3, 1],
    ]);
  });

  test('rounding to 0.01 km drops consecutive duplicates', () => {
    expect(
      roundPts([
        [0.001, 0.002],
        [0.004, -0.003],
        [1.234, 5.678],
      ]),
    ).toEqual([
      [0, 0],
      [1.23, 5.68],
    ]);
  });

  test('layers: tiny rings and 1-point runs are dropped, paths follow the grammar', () => {
    const tiny: Pt[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0],
    ];
    const big: Pt[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    expect(waterRings([tiny, big])).toHaveLength(1);
    expect(
      lineRuns([
        [[0, 0]],
        [
          [0, 0],
          [0.001, 0.001],
        ],
      ]),
    ).toEqual([]);
    const water = runsPath(waterRings([big]), true);
    expect(water).toBe('M 0 0 L 2 0 L 2 -2 L 0 -2 Z');
    expect(
      runsPath(
        lineRuns([
          [
            [0, 0],
            [3, 0],
          ],
        ]),
        false,
      ),
    ).toBe('M 0 0 L 3 0');
    expect(water).toMatch(/^[MLZ0-9 .-]+$/);
    expect(runsPath([], false)).toBe('');
  });

  test('the query holds the three layers and a ±6 km bbox', () => {
    const q = overpassQuery(45.6216, 9.2888);
    expect(q).toContain('[out:json][timeout:60][bbox:45.56764,9.21165,45.67556,9.36595];');
    for (const part of [
      '"natural"="coastline"',
      '"natural"="water"',
      '"waterway"="riverbank"',
      'motorway|trunk|primary',
    ]) {
      expect(q).toContain(part);
    }
    expect(q.endsWith('out geom;')).toBe(true);
  });

  test('--osm under CI refuses with exit 1 and no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lines: string[] = [];
    expect(await run(['--osm'], { CI: 'true' }, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('refuses to run under CI');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an unknown argument is a usage error, not an OSM run', async () => {
    const lines: string[] = [];
    expect(await run(['--nope'], {}, (l) => lines.push(l))).toBe(64);
  });
});

// The outline run (#91) reads only the vendored GeoJSON, so it runs here into a temporary directory.
describe('the outline run of map-extract', () => {
  const root = join(import.meta.dirname, '../../..');
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'map-extract-'));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    return { map: join(d, 'map'), circuits: join(d, 'circuits.ts'), geojson: GEOJSON };
  };

  test('reproduces the committed outline files and circuits.ts byte for byte', () => {
    const dirs = tmp();
    expect(extract([], {}, () => {}, dirs)).toBe(0);
    const committed = join(root, 'apps/web/src/map');
    const names = readdirSync(dirs.map).sort();
    expect(names).toEqual(
      readdirSync(committed)
        .filter((f) => f.endsWith('.json'))
        .sort(),
    );
    for (const f of names)
      expect(readFileSync(join(dirs.map, f), 'utf8'), f).toBe(readFileSync(join(committed, f), 'utf8'));
    expect(readFileSync(dirs.circuits, 'utf8')).toBe(
      readFileSync(join(root, 'packages/contracts/src/circuits.ts'), 'utf8'),
    );
  });

  test('refuses a start/finish point 150 m off the outline (a typo, not a position)', () => {
    const lines: string[] = [];
    // 150 m north of Silverstone's sourced point: 0.15 km / 110.57 km per degree of latitude.
    const off = { 'gb-1948': [52.07879 + 0.15 / 110.57, -1.01535] as const };
    expect(extract([], {}, (l) => lines.push(l), tmp(), off)).toBe(1);
    expect(lines.at(-1)).toBe('map-extract: gb-1948: the start/finish point is more than 40 m off the outline');
  });

  test('a bar is perpendicular to the segment it snaps to, its length centred on the snapped point', () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(startBar(square, [0.5, 0.03], 0.2)).toEqual({
      bar: [
        [0.5, 0.1],
        [0.5, -0.1],
      ],
      off: expect.closeTo(0.03, 9),
    });
    expect(startBar(square, [0.5, 0.5], 0.2)).toBeUndefined();
    // On a vertex (the corner at 1, 0): across the bisector of its two segments, not across either one.
    expect(startBar(square, [1.01, -0.01], 0.2 * Math.SQRT2)?.bar).toEqual([
      [0.9, 0.1],
      [1.1, -0.1],
    ]);
  });
});
