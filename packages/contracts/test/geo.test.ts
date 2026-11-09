import { expect, test } from 'vitest';
import { gridPoints, project, R_KM, unproject } from '../src/geo.ts';

const [LAT, LON] = [45.62, 9.28];
const rad = (d: number) => (d * Math.PI) / 180;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

test('a projected 5 km distance near Monza is within 1 % of the haversine distance', () => {
  const [lat, lon] = unproject(3, 4, LAT, LON);
  const [x, y] = project(lat, lon, LAT, LON);
  expect(Math.hypot(x, y)).toBeCloseTo(5, 9);
  expect(Math.abs(Math.hypot(x, y) / haversineKm(LAT, LON, lat, lon) - 1)).toBeLessThan(0.01);
});

test('project and unproject round-trip', () => {
  const [lat, lon] = unproject(-2.5, 1.25, LAT, LON);
  const [x, y] = project(lat, lon, LAT, LON);
  expect(x).toBeCloseTo(-2.5, 9);
  expect(y).toBeCloseTo(1.25, 9);
  const [lat2, lon2] = unproject(x, y, LAT, LON);
  expect(Math.abs(lat2 - lat)).toBeLessThan(1e-9);
  expect(Math.abs(lon2 - lon)).toBeLessThan(1e-9);
});

test('gridPoints: 7 × 7, row 0 north, column 0 west, 1.5 km apart', () => {
  const g = gridPoints(LAT, LON, 7, 1500);
  expect(g).toHaveLength(49);
  expect(g[24]).toEqual({ lat: LAT, lon: LON });
  const at = (i: number) => g[i] as { lat: number; lon: number };
  expect(at(0).lat).toBeGreaterThan(LAT);
  expect(at(0).lon).toBeLessThan(LON);
  expect(at(6).lat).toBeGreaterThan(LAT);
  expect(at(6).lon).toBeGreaterThan(LON);
  expect(at(48).lat).toBeLessThan(LAT);
  expect(at(48).lon).toBeGreaterThan(LON);
  expect(at(42).lon).toBeLessThan(LON);
  for (const [a, b] of [
    [0, 1],
    [0, 7],
    [24, 25],
    [24, 31],
    [47, 48],
  ] as const) {
    const [x, y] = project(at(b).lat, at(b).lon, at(a).lat, at(a).lon);
    expect(Math.abs(Math.hypot(x, y) / 1.5 - 1)).toBeLessThan(0.01);
  }
  for (const p of g) expect(p).toEqual({ lat: Math.round(p.lat * 1e4) / 1e4, lon: Math.round(p.lon * 1e4) / 1e4 });
});
