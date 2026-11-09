// A local km frame around a circuit (P5c). Pure and shared by the extract script, the server and the tests.

/** Mean Earth radius in km (IUGG). */
export const R_KM = 6371.0088;

const RAD = Math.PI / 180;

/** Equirectangular projection at (lat0, lon0): [x east, y north] in km. Good to well under 1 % within about 10 km. */
export function project(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  return [R_KM * (lon - lon0) * RAD * Math.cos(lat0 * RAD), R_KM * (lat - lat0) * RAD];
}

/** The inverse of project: [lat, lon] in degrees. */
export function unproject(x: number, y: number, lat0: number, lon0: number): [number, number] {
  return [lat0 + y / R_KM / RAD, lon0 + x / (R_KM * Math.cos(lat0 * RAD)) / RAD];
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * A size × size grid centred on (lat0, lon0), `stepM` metres apart, row-major: row 0 is the northernmost, column 0
 * the westernmost. Each coordinate is rounded to 4 decimals.
 */
export function gridPoints(lat0: number, lon0: number, size: number, stepM: number): { lat: number; lon: number }[] {
  const half = (size - 1) / 2;
  const points: { lat: number; lon: number }[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const [lat, lon] = unproject(((col - half) * stepM) / 1000, ((half - row) * stepM) / 1000, lat0, lon0);
      points.push({ lat: round4(lat), lon: round4(lon) });
    }
  }
  return points;
}
