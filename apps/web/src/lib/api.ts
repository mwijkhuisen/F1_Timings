import {
  Laps,
  Live,
  RaceControl,
  Rain,
  Recordings,
  Season,
  Seasons,
  SessionDetail,
  Status,
  Stints,
  Weather,
} from '@f1/contracts';
import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { ZodError } from 'zod';

// The P1c API, read through relative paths only. Every answer is parsed with
// its contract before the UI sees it; anything else is an error state. There
// is no error contract: callers branch on the HTTP status (ui/ErrorView.tsx).

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function getJson<T>(path: string, contract: { parse(data: unknown): T }, signal: AbortSignal): Promise<T> {
  // redirect: 'error' turns Access's login redirect into a TypeError instead of an HTML page.
  const res = await fetch(path, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status);
  return contract.parse(await res.json());
}

/** One retry, but never for an answer that will not change: a 4xx or data that fails its contract. */
export const retry = (failures: number, error: unknown): boolean =>
  failures < 1 && !(error instanceof HttpError && error.status < 500) && !(error instanceof ZodError);

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry, refetchOnWindowFocus: false } },
});

const STALE_MS = 60_000;

export const useSeasons = () =>
  useQuery({
    queryKey: ['seasons'],
    queryFn: ({ signal }) => getJson('/api/v1/seasons', Seasons, signal),
    staleTime: STALE_MS,
  });

/** Also used by the header, with `enabled` off on routes without a year. */
export const seasonQuery = (year: number) =>
  queryOptions({
    queryKey: ['season', year],
    queryFn: ({ signal }) => getJson(`/api/v1/seasons/${year}`, Season, signal),
    staleTime: STALE_MS,
  });

/** `poll`: the refetch interval in ms for the data so far, or false; it is asked after each fetch and each render. */
export const useSeason = (year: number, poll?: (data: Season | undefined) => number | false) =>
  useQuery({ ...seasonQuery(year), refetchInterval: poll ? (q) => poll(q.state.data) : false });

export const useSession = (key: number) =>
  useQuery({
    queryKey: ['session', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}`, SessionDetail, signal),
    staleTime: STALE_MS,
  });

export const useLaps = (key: number) =>
  useQuery({
    queryKey: ['laps', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/laps`, Laps, signal),
    staleTime: STALE_MS,
  });

export const useStints = (key: number) =>
  useQuery({
    queryKey: ['stints', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/stints`, Stints, signal),
    staleTime: STALE_MS,
  });

/** Races only (`enabled`): the SC, VSC and red-flag bands (lib/track.ts). */
export const useRaceControl = (key: number, enabled: boolean) =>
  useQuery({
    queryKey: ['race-control', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/race-control`, RaceControl, signal),
    staleTime: STALE_MS,
    enabled,
  });

/** The weather samples (P5a): the Weather tab and the session head's line. */
export const useWeather = (key: number) =>
  useQuery({
    queryKey: ['weather', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/weather`, Weather, signal),
    staleTime: STALE_MS,
  });

/** The rain map's grid and frames (P5c); `live` polls every 60 s, as the server adds a frame every 15 min. */
export const useRain = (key: number, live = false) =>
  useQuery({
    queryKey: ['rain', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/rain`, Rain, signal),
    staleTime: STALE_MS,
    refetchInterval: live ? 60_000 : false,
  });

/** A circuit's OpenStreetMap layers (ODbL, ADR-0008): SVG path data in km, any of them possibly empty. */
export type OsmLayers = { water: string; coast: string; roads: string };

// The map files are bundled, one lazy chunk per file, so a map costs no request to a third party (or to the API). The
// default export, not a named one: Vite's JSON `stringify: 'auto'` gives a file over 10 kB a default export only.
const OUTLINES = import.meta.glob<{ outline: string }>('../map/*.json', { import: 'default' });
const OSM = import.meta.glob<OsmLayers>('../map/osm/*.json', { import: 'default' });

/** The circuit's outline and OSM layers by map id, each null when the circuit has no such file. */
export async function loadCircuitMap(id: string) {
  const [outline, osm] = await Promise.all([
    OUTLINES[`../map/${id}.json`]?.() ?? null,
    OSM[`../map/osm/${id}.json`]?.() ?? null,
  ]);
  return { outline: outline?.outline ?? null, osm: osm && { water: osm.water, coast: osm.coast, roads: osm.roads } };
}

export const useCircuitMap = (id: string | null) =>
  useQuery({
    queryKey: ['map', id],
    enabled: id !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => loadCircuitMap(id as string),
  });

/** `refetchMs`: poll, such as every 60 s on `/live`. */
export const useStatus = (refetchMs: number | false = false) =>
  useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => getJson('/api/v1/status', Status, signal),
    staleTime: STALE_MS,
    refetchInterval: refetchMs,
  });

/** Polled every 30 s, so `/live` picks up a session that starts and the player an `ended_at` that is set. */
export const useLive = () =>
  useQuery({
    queryKey: ['live'],
    queryFn: ({ signal }) => getJson('/api/v1/live', Live, signal),
    refetchInterval: 30_000,
  });

export const useRecordings = (refetchMs: number | false = false) =>
  useQuery({
    queryKey: ['recordings'],
    queryFn: ({ signal }) => getJson('/api/v1/recordings', Recordings, signal),
    staleTime: STALE_MS,
    refetchInterval: refetchMs,
  });
