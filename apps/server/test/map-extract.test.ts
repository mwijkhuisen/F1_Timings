import { describe, expect, test, vi } from 'vitest';
import {
  assembleRings,
  clipLine,
  clipRing,
  lineRuns,
  overpassQuery,
  roundPts,
  run,
  runsPath,
  simplify,
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
