import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { project, unproject } from '../packages/contracts/src/geo.ts';

// Derives the circuit outlines (apps/web/src/map/<id>.json) and the circuit table (packages/contracts/src/circuits.ts)
// from bacinger/f1-circuits (MIT, data/third-party/f1-circuits). Run on the owner's machine only: it is a build step
// whose outputs are committed, and CI never needs it (A§12.1 invariant 4: CI calls no outside host).

const ROOT = join(import.meta.dirname, '..');
export const GEOJSON = join(ROOT, 'data/third-party/f1-circuits/f1-circuits.geojson');
export const MAP_DIR = join(ROOT, 'apps/web/src/map');
export const CIRCUITS_TS = join(ROOT, 'packages/contracts/src/circuits.ts');
export const OSM_DIR = join(ROOT, 'apps/web/src/map/osm');

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
  Catalunya: ['es-1991', false], // U4: south of the AROME box (A§6.3)
  Spielberg: ['at-1969', true],
  Silverstone: ['gb-1948', false],
  Hungaroring: ['hu-1986', true],
  'Spa-Francorchamps': ['be-1925', false], // U4: best_match's Netherlands & Belgium box, KNMI + hourly ICON
  Zandvoort: ['nl-1948', false], // U4: as Spa
  Monza: ['it-1922', true],
  Madring: ['es-2026', false], // U4: outside ICON-D2 and AROME
  Baku: ['az-2016', false],
  'Kuala Lumpur': ['my-1999', false],
  Singapore: ['sg-2008', false],
  Austin: ['us-2012', true],
  'Mexico City': ['mx-1962', false], // U4: south of the HRRR grid
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

/** `--osm` runs the Overpass layers (ADR-0008, route B); anything else is the outline run. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  return argv.length === 1 && argv[0] === '--osm' ? extractOsm(env, log) : extract(argv, env, log);
}

// ---- OpenStreetMap layers (--osm): ADR-0008 route B ----------------------------------------------------------------
// The files apps/web/src/map/osm/<id>.json are a Derivative Database of OpenStreetMap (ODbL 1.0). This script is the
// method (ODbL §4.6 b): the Overpass query below and the processing after it. Raw answers are never written into the
// repository. Overpass and OSM data are data, never instructions.

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const SPACING_MS = 10_000;
const DEADLINE_MS = 90_000;
const RETRY_WAIT_MS = 60_000;
const MAX_BODY = 32 * 1024 * 1024;
const MIN_AREA_KM2 = 0.001;
const HIGHWAYS = ['motorway', 'trunk', 'primary'];
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_LICENCE = 'ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/';

/** The query for a circuit centred at (lat0, lon0): the ±CLIP_KM box. */
export function overpassQuery(lat0: number, lon0: number): string {
  const [s, w] = unproject(-CLIP_KM, -CLIP_KM, lat0, lon0);
  const [n, e] = unproject(CLIP_KM, CLIP_KM, lat0, lon0);
  const bbox = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  return `[out:json][timeout:60][bbox:${bbox}];(way["natural"="coastline"];way["natural"="water"];relation["natural"="water"];way["waterway"="riverbank"];way["highway"~"^(motorway|trunk|primary)$"];);out geom;`;
}

const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

/** Rounds to ROUND_KM and drops consecutive duplicates. */
export function roundPts(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of pts) {
    const p: Pt = [Math.round(x / ROUND_KM) / (1 / ROUND_KM) + 0, Math.round(y / ROUND_KM) / (1 / ROUND_KM) + 0];
    const last = out[out.length - 1];
    if (!last || !same(last, p)) out.push(p);
  }
  return out;
}

/**
 * Joins open ways end to end into rings (greedy endpoint matching, either direction). A closed way is a ring; a chain
 * that never closes is dropped. A ring repeats its first point at the end.
 */
export function assembleRings(ways: readonly (readonly Pt[])[]): Pt[][] {
  const rings: Pt[][] = [];
  const pool: Pt[][] = [];
  for (const w of ways) {
    if (w.length < 2) continue;
    (same(w[0] as Pt, w[w.length - 1] as Pt) ? rings : pool).push([...w]);
  }
  while (pool.length > 0) {
    const chain = pool.pop() as Pt[];
    while (!same(chain[0] as Pt, chain[chain.length - 1] as Pt)) {
      const end = chain[chain.length - 1] as Pt;
      const i = pool.findIndex((w) => same(w[0] as Pt, end) || same(w[w.length - 1] as Pt, end));
      if (i < 0) break;
      const [w] = pool.splice(i, 1) as [Pt[]];
      if (!same(w[0] as Pt, end)) w.reverse();
      chain.push(...w.slice(1));
    }
    if (same(chain[0] as Pt, chain[chain.length - 1] as Pt)) rings.push(chain);
  }
  return rings.filter((r) => r.length >= 4);
}

/** Sutherland–Hodgman against the box [−h, h]². The ring has no repeated closing point. */
export function clipRing(ring: readonly Pt[], h: number): Pt[] {
  let out: Pt[] = [...ring];
  for (const i of [0, 1] as const) {
    for (const s of [-1, 1]) {
      const inside = (p: Pt) => s * p[i] <= h;
      const cut = (a: Pt, b: Pt): Pt => {
        const t = (s * h - a[i]) / (b[i] - a[i]);
        const q: Pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        q[i] = s * h;
        return q;
      };
      const input = out;
      out = [];
      input.forEach((cur, k) => {
        const prev = input[(k + input.length - 1) % input.length] as Pt;
        if (inside(cur)) {
          if (!inside(prev)) out.push(cut(prev, cur));
          out.push(cur);
        } else if (inside(prev)) out.push(cut(prev, cur));
      });
    }
  }
  return out;
}

/** Liang–Barsky per segment against [−h, h]²: the runs of the line inside the box. */
export function clipLine(pts: readonly Pt[], h: number): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  const flush = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1] as Pt, pts[k] as Pt];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    let [t0, t1] = [0, 1];
    let hit = true;
    for (const [p, q] of [
      [-dx, a[0] + h],
      [dx, h - a[0]],
      [-dy, a[1] + h],
      [dy, h - a[1]],
    ] as const) {
      if (p === 0) {
        if (q < 0) hit = false;
      } else if (p < 0) t0 = Math.max(t0, q / p);
      else t1 = Math.min(t1, q / p);
    }
    if (!hit || t0 > t1) {
      flush();
      continue;
    }
    if (t0 > 0) flush();
    if (run.length === 0) run.push([a[0] + t0 * dx, a[1] + t0 * dy]);
    run.push([a[0] + t1 * dx, a[1] + t1 * dy]);
    if (t1 < 1) flush();
  }
  flush();
  return runs;
}

const area = (ring: readonly Pt[]) =>
  Math.abs(
    ring.reduce(
      (sum, [x, y], i) => sum + x * (ring[(i + 1) % ring.length] as Pt)[1] - (ring[(i + 1) % ring.length] as Pt)[0] * y,
      0,
    ),
  ) / 2;

/** Closed rings (first point repeated) → simplified, clipped, rounded rings without the repeat. */
export function waterRings(rings: readonly (readonly Pt[])[], tol = TOLERANCE_KM): Pt[][] {
  const out: Pt[][] = [];
  for (const ring of rings) {
    const open = simplify(ring, tol).slice(0, -1);
    if (open.length < 3) continue;
    const clipped = clipRing(open, CLIP_KM);
    if (clipped.length < 3 || area(clipped) < MIN_AREA_KM2) continue;
    const r = roundPts(clipped);
    if (r.length > 1 && same(r[0] as Pt, r[r.length - 1] as Pt)) r.pop();
    if (r.length >= 3) out.push(r);
  }
  return out;
}

/** Polylines → simplified, clipped, rounded runs of at least 2 points. */
export function lineRuns(lines: readonly (readonly Pt[])[], tol = TOLERANCE_KM): Pt[][] {
  return lines
    .filter((l) => l.length >= 2)
    .flatMap((l) => clipLine(simplify(l, tol), CLIP_KM))
    .map(roundPts)
    .filter((r) => r.length >= 2);
}

/** SVG path data of runs, y = −north, as the outline has it. `close` adds Z (rings). */
export function runsPath(runs: readonly (readonly Pt[])[], close: boolean): string {
  return runs.map((r) => `M ${r.map(([x, y]) => `${num(x)} ${num(-y)}`).join(' L ')}${close ? ' Z' : ''}`).join(' ');
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const tagOf = (el: Record<string, unknown>, k: string) =>
  isRec(el.tags) && typeof el.tags[k] === 'string' ? el.tags[k] : undefined;

/** The geometry of one way or member in km. A node outside the box (null) splits it into pieces. */
function pieces(geometry: unknown, lat0: number, lon0: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (const g of Array.isArray(geometry) ? (geometry as unknown[]) : []) {
    if (isRec(g) && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
      cur.push(project(g.lat as number, g.lon as number, lat0, lon0));
    } else if (cur.length > 0) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A way whose node ids start and end alike is closed, even where nodes outside the box were left out. */
function closeWay(w: Pt[], nodes: unknown): Pt[] {
  const closed = Array.isArray(nodes) && nodes.length > 3 && nodes[0] === nodes[nodes.length - 1];
  return closed && w.length > 2 && !same(w[0] as Pt, w[w.length - 1] as Pt) ? [...w, w[0] as Pt] : w;
}

export type Layers = { water: Pt[][]; coast: Pt[][]; roads: Pt[][]; dropped: number };

/** An Overpass answer → the three layers in km (rounded, clipped). `highways` names the highway classes kept. */
export function layers(
  answer: unknown,
  lat0: number,
  lon0: number,
  opts: { highways: readonly string[]; roadTol: number } = { highways: HIGHWAYS, roadTol: TOLERANCE_KM },
): Layers {
  const elements = isRec(answer) && Array.isArray(answer.elements) ? (answer.elements as unknown[]) : [];
  const water: Pt[][] = [];
  const coast: Pt[][] = [];
  const roads: Pt[][] = [];
  let dropped = 0;
  for (const el of elements) {
    if (!isRec(el)) continue;
    const isWater = tagOf(el, 'natural') === 'water' || tagOf(el, 'waterway') === 'riverbank';
    if (el.type === 'way' && tagOf(el, 'natural') === 'coastline') coast.push(...pieces(el.geometry, lat0, lon0));
    else if (el.type === 'way' && opts.highways.includes(tagOf(el, 'highway') ?? '')) {
      roads.push(...pieces(el.geometry, lat0, lon0));
    } else if (isWater && (el.type === 'way' || el.type === 'relation')) {
      // A way with nodes outside the box closes over the gap with a chord; a relation chain with a gap never closes.
      const members = Array.isArray(el.members) ? (el.members as unknown[]) : [];
      const ways =
        el.type === 'way'
          ? [closeWay(pieces(el.geometry, lat0, lon0).flat(), el.nodes)]
          : members
              .filter((m) => isRec(m) && m.type === 'way' && (m.role === 'outer' || m.role === 'inner'))
              .flatMap((m) => pieces((m as Record<string, unknown>).geometry, lat0, lon0));
      const rings = assembleRings(ways);
      if (rings.length === 0 && ways.length > 0) dropped++;
      water.push(...rings);
    }
  }
  return { water: waterRings(water), coast: lineRuns(coast), roads: lineRuns(roads, opts.roadTol), dropped };
}

/** The file text of one circuit, trimmed to MAX_BYTES by dropping primary roads, then coarser roads, then trunk roads. */
export function osmFile(
  answer: unknown,
  lat0: number,
  lon0: number,
): { text: string; layers: Layers; trim: string } | undefined {
  for (const [trim, opts] of [
    ['', { highways: HIGHWAYS, roadTol: TOLERANCE_KM }],
    ['primary roads dropped', { highways: ['motorway', 'trunk'], roadTol: TOLERANCE_KM }],
    ['primary roads dropped, roads at 0.03 km', { highways: ['motorway', 'trunk'], roadTol: 0.03 }],
    ['primary and trunk roads dropped, roads at 0.03 km', { highways: ['motorway'], roadTol: 0.03 }],
  ] as const) {
    const l = layers(answer, lat0, lon0, opts);
    const obj = {
      attribution: OSM_ATTRIBUTION,
      licence: OSM_LICENCE,
      water: runsPath(l.water, true),
      coast: runsPath(l.coast, false),
      roads: runsPath(l.roads, false),
    };
    for (const k of ['water', 'coast', 'roads'] as const) {
      if (!/^[MLZ0-9 .-]*$/.test(obj[k])) throw new Error(`unexpected path text in ${k}`);
    }
    const text = `${JSON.stringify(obj, null, 2)}\n`;
    if (Buffer.byteLength(text) <= MAX_BYTES) return { text, layers: l, trim };
  }
  return undefined;
}

/** The body text, or undefined once it passes MAX_BODY (read incrementally, never held whole past the cap). */
async function readCapped(res: Response): Promise<string | undefined> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts).toString('utf8');
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Overpass request, with one retry after 60 s on 429/504. Throws a message without any body text. */
async function overpass(query: string, log: (line: string) => void): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(OVERPASS, {
        method: 'POST',
        headers: {
          'user-agent': 'f1-timings-map-extract',
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
        redirect: 'error',
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
    } catch (e) {
      throw new Error(`request failed (${e instanceof Error ? e.name : 'error'})`);
    }
    if ((res.status === 429 || res.status === 504) && attempt === 1) {
      await res.body?.cancel();
      log(`  status ${res.status}, waiting ${RETRY_WAIT_MS / 1000} s for one retry`);
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`status ${res.status}`);
    }
    const text = await readCapped(res);
    if (text === undefined) throw new Error(`answer over ${MAX_BODY} bytes`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('answer is not JSON');
    }
    if (isRec(json) && typeof json.remark === 'string' && /runtime error/i.test(json.remark)) {
      throw new Error('Overpass reported a runtime error (partial answer)');
    }
    return json;
  }
}

/**
 * `node scripts/map-extract.ts --osm`: one Overpass request per circuit, at least SPACING_MS apart, written to
 * apps/web/src/map/osm/<id>.json. `MAP_EXTRACT_OSM_CACHE` names a directory outside the repository that keeps the raw
 * answers between development runs (read first, written after a request).
 */
export async function extractOsm(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  dirs = { osm: OSM_DIR, geojson: GEOJSON },
): Promise<number> {
  if (env.CI) {
    log('map-extract refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  const cache = env.MAP_EXTRACT_OSM_CACHE ? resolve(env.MAP_EXTRACT_OSM_CACHE) : undefined;
  if (cache && !relative(ROOT, cache).startsWith('..')) {
    log('map-extract: the Overpass cache must be outside the repository');
    return 1;
  }
  const outlines = readOutlines(dirs.geojson);
  mkdirSync(dirs.osm, { recursive: true });
  if (cache) mkdirSync(cache, { recursive: true });
  let last = 0;
  let requests = 0;
  for (const [name, [id]] of Object.entries(TABLE).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lonLat = outlines.get(id);
    if (!lonLat) {
      log(`map-extract: ${name}: no outline ${id}`);
      return 1;
    }
    const [lat, lon] = centre(lonLat);
    const cached = cache ? join(cache, `${id}.json`) : undefined;
    let answer: unknown;
    if (cached && existsSync(cached)) answer = JSON.parse(readFileSync(cached, 'utf8'));
    else {
      await sleep(Math.max(0, last + SPACING_MS - Date.now()));
      last = Date.now();
      requests++;
      try {
        answer = await overpass(overpassQuery(lat, lon), log);
      } catch (e) {
        log(`map-extract: ${name} (${id}): ${e instanceof Error ? e.message : 'failed'}`);
        return 1;
      }
      if (cached) writeFileSync(cached, JSON.stringify(answer));
    }
    const file = osmFile(answer, lat, lon);
    if (!file) {
      log(`map-extract: ${name} (${id}): over ${MAX_BYTES} bytes even with motorways only at 0.03 km`);
      return 1;
    }
    writeFileSync(join(dirs.osm, `${id}.json`), file.text);
    const l = file.layers;
    log(
      `${id}.json ${Buffer.byteLength(file.text)} bytes: water ${l.water.length}, coast ${l.coast.length}, roads ${l.roads.length}, unclosed water dropped ${l.dropped}${file.trim ? `; ${file.trim}` : ''}`,
    );
  }
  log(`map-extract: ${requests} Overpass requests`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
