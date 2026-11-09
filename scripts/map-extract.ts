import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../packages/contracts/src/geo.ts';

// Derives the circuit outlines (apps/web/src/map/<id>.json) and the circuit table (packages/contracts/src/circuits.ts)
// from bacinger/f1-circuits (MIT, data/third-party/f1-circuits). Run on the owner's machine only: it is a build step
// whose outputs are committed, and CI never needs it (A§12.1 invariant 4: CI calls no outside host).

const ROOT = join(import.meta.dirname, '..');
export const GEOJSON = join(ROOT, 'data/third-party/f1-circuits/f1-circuits.geojson');
export const MAP_DIR = join(ROOT, 'apps/web/src/map');
export const CIRCUITS_TS = join(ROOT, 'packages/contracts/src/circuits.ts');

/** The clip box half-width, the simplification tolerance and the rounding, all in km. */
const CLIP_KM = 6;
const TOLERANCE_KM = 0.015;
const ROUND_KM = 0.01;
export const MAX_BYTES = 40_960;

/**
 * OpenF1 circuit_short_name → [bacinger id, native15]. native15 is true where Open-Meteo has a native 15-minute model
 * (ICON-D2, AROME: Central Europe; RRFS: North America), false where it interpolates hourly data. Edit here, then
 * re-run the script.
 */
export const TABLE: Readonly<Record<string, readonly [id: string, native15: boolean]>> = {
  Sakhir: ['bh-2002', false],
  Jeddah: ['sa-2021', false],
  Melbourne: ['au-1953', false],
  Shanghai: ['cn-2004', false],
  Suzuka: ['jp-1962', false],
  Miami: ['us-2022', true],
  Imola: ['it-1953', true],
  'Monte Carlo': ['mc-1929', true],
  Montreal: ['ca-1978', true],
  Catalunya: ['es-1991', false], // [U] U4
  Spielberg: ['at-1969', true],
  Silverstone: ['gb-1948', false],
  Hungaroring: ['hu-1986', true],
  'Spa-Francorchamps': ['be-1925', true],
  Zandvoort: ['nl-1948', true],
  Monza: ['it-1922', true],
  Madring: ['es-2026', false], // [U] U4
  Baku: ['az-2016', false],
  'Kuala Lumpur': ['my-1999', false],
  Singapore: ['sg-2008', false],
  Austin: ['us-2012', true],
  'Mexico City': ['mx-1962', false], // [U] U4
  Interlagos: ['br-1940', false],
  'Las Vegas': ['us-2023', true],
  Lusail: ['qa-2004', false],
  'Yas Marina Circuit': ['ae-2009', false],
};

type Pt = [number, number];

/** The outlines by id: [lon, lat] pairs as the GeoJSON has them. */
export function readOutlines(file = GEOJSON): Map<string, Pt[]> {
  const geo = JSON.parse(readFileSync(file, 'utf8')) as {
    features: { properties: { id: string }; geometry: { type: string; coordinates: Pt[] } }[];
  };
  const out = new Map<string, Pt[]>();
  for (const f of geo.features) {
    if (f.geometry.type !== 'LineString') throw new Error(`${f.properties.id}: not a LineString`);
    out.set(f.properties.id, f.geometry.coordinates);
  }
  return out;
}

/** The bounding-box centre of [lon, lat] pairs, rounded to 4 decimals: [lat0, lon0]. */
export function centre(lonLat: readonly Pt[]): [number, number] {
  const lons = lonLat.map((p) => p[0]);
  const lats = lonLat.map((p) => p[1]);
  const mid = (v: number[]) => Math.round(((Math.min(...v) + Math.max(...v)) / 2) * 1e4) / 1e4;
  return [mid(lats), mid(lons)];
}

/** Douglas–Peucker, iterative so a long outline cannot overflow the stack. */
export function simplify(pts: readonly Pt[], tol: number): Pt[] {
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let far = -1;
    let dMax = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distance(pts[i] as Pt, pts[a] as Pt, pts[b] as Pt);
      if (d > dMax) [far, dMax] = [i, d];
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Distance from p to the segment a–b (to a when they coincide). */
function distance([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const [dx, dy] = [bx - ax, by - ay];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Minimal number text: 1.2, -0.05, 0. */
const num = (v: number) => String(Math.round(v / ROUND_KM) / (1 / ROUND_KM) + 0);

/** The SVG path data of one outline in the km frame around its centre, north up. */
export function outlinePath(lonLat: readonly Pt[]): string {
  const [lat0, lon0] = centre(lonLat);
  const km = lonLat.map(([lon, lat]) => project(lat, lon, lat0, lon0));
  const pts = simplify(km, TOLERANCE_KM).filter(([x, y]) => Math.abs(x) <= CLIP_KM && Math.abs(y) <= CLIP_KM);
  const svg = pts.map(([x, y]) => `${num(x)} ${num(-y)}`);
  // A closed ring repeats its first point: Z closes it.
  if (svg.length > 1 && svg[0] === svg[svg.length - 1]) svg.pop();
  return `M ${svg.join(' L ')} Z`;
}

/** Object keys that Biome leaves unquoted. */
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);

export function extract(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  dirs = { map: MAP_DIR, circuits: CIRCUITS_TS, geojson: GEOJSON },
): number {
  if (env.CI) {
    log('map-extract refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  if (argv.length > 0) {
    log('usage: map-extract.ts');
    return 64;
  }
  // --osm (the Overpass layers) goes here once ADR-0008 is approved.
  const outlines = readOutlines(dirs.geojson);
  mkdirSync(dirs.map, { recursive: true });
  const rows: string[] = [];
  for (const [name, [id, native15]] of Object.entries(TABLE).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lonLat = outlines.get(id);
    if (!lonLat) {
      log(`map-extract: ${name}: no outline ${id}`);
      return 1;
    }
    const [lat, lon] = centre(lonLat);
    const path = outlinePath(lonLat);
    if (!/^[MLZ0-9 .-]+$/.test(path)) throw new Error(`${id}: unexpected path text`);
    const file = join(dirs.map, `${id}.json`);
    writeFileSync(file, `${JSON.stringify({ outline: path }, null, 2)}\n`);
    const size = statSync(file).size;
    if (size > MAX_BYTES) {
      log(`map-extract: ${id}.json is ${size} bytes, over ${MAX_BYTES}`);
      return 1;
    }
    log(`${id}.json ${size} bytes`);
    rows.push(`  ${key(name)}: { id: '${id}', lat: ${lat}, lon: ${lon}, native15: ${native15} },`);
  }
  writeFileSync(
    dirs.circuits,
    `// Generated by scripts/map-extract.ts from bacinger/f1-circuits (MIT, see data/third-party/f1-circuits).
// Do not edit by hand: change the table in the script and run it again.

/** A circuit's centre (the outline's bounding-box centre) and whether Open-Meteo has a native 15-minute model there. */
export type Circuit = { id: string; lat: number; lon: number; native15: boolean };

/** By OpenF1 circuit_short_name. */
export const CIRCUITS: Readonly<Record<string, Circuit>> = {
${rows.join('\n')}
};
`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = extract(process.argv.slice(2), process.env);
}
