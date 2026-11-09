import type { RainAnswer } from './client.ts';

// The Open-Meteo query for a rain grid and the frames of its answer (P5c). Pure.

const QUARTER_MS = 15 * 60_000;
export const floor15 = (ms: number) => Math.floor(ms / QUARTER_MS) * QUARTER_MS;
export const ceil15 = (ms: number) => Math.ceil(ms / QUARTER_MS) * QUARTER_MS;

/** UTC 'YYYY-MM-DDTHH:mm', the form start_minutely_15 and end_minutely_15 take. */
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * One call for every point (C1: the same shape for both hosts): precipitation per 15 minutes over
 * [fromMs, toMs], both on 15-minute boundaries, in unixtime so the answer carries no zone. Each point
 * takes its nearest model cell: the default (`land`) moves a point at sea onto a land cell, so a
 * coastal grid would repeat the circuit's cell (U5).
 */
export function rainQuery(
  points: readonly { lat: number; lon: number }[],
  fromMs: number,
  toMs: number,
): Record<string, string> {
  if (fromMs !== floor15(fromMs) || toMs !== floor15(toMs) || toMs < fromMs) {
    throw new RangeError('the rain window must run between 15-minute boundaries');
  }
  return {
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    minutely_15: 'precipitation',
    start_minutely_15: minute(fromMs),
    end_minutely_15: minute(toMs),
    timeformat: 'unixtime',
    timezone: 'GMT',
    cell_selection: 'nearest',
  };
}

/** One frame per time step: mm[k] is location k's precipitation (mm in the preceding 15 minutes). */
export function toFrames(answer: RainAnswer): { date: string; mm: (number | null)[] }[] {
  const times = answer[0]?.minutely_15.time ?? [];
  return times.map((t, i) => ({
    date: new Date(t * 1000).toISOString(),
    mm: answer.map((location) => location.minutely_15.precipitation[i] ?? null),
  }));
}
