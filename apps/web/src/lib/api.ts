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
import { QueryClient, queryOptions, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ZodError } from 'zod';
import { savedSessions } from './saved.ts';
import { pollMs } from './session.ts';

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

/** This build's git commit or `dev` (vite.config.ts, A§10). */
export const REVISION: string = import.meta.env.F1_REVISION ?? 'dev';

// One app-wide flag: the api answered for another revision, or an answer failed its contract. A reload is the fix,
// so the banner (ui/ErrorView.tsx) stays up; it is never cleared (A§13).
let stale = false;
const listeners = new Set<() => void>();
export const isStale = () => stale;
export function markStale() {
  if (stale) return;
  stale = true;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useStale = () => useSyncExternalStore(subscribe, isStale, isStale);

export async function getJson<T>(path: string, contract: { parse(data: unknown): T }, signal: AbortSignal): Promise<T> {
  // A per-session answer may sit in the browser cache for 24 h: `v` makes the cache key per build (A§10).
  const url = path.includes('/api/v1/sessions/') ? `${path}?v=${REVISION}` : path;
  // redirect: 'error' turns Access's login redirect into a TypeError instead of an HTML page.
  const res = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status);
  const rev = res.headers.get('f1-revision');
  // Another revision's answer is still data: keep it, and ask for a reload.
  if (rev !== null && rev !== REVISION) markStale();
  try {
    return contract.parse(await res.json());
  } catch (err) {
    if (err instanceof ZodError) markStale();
    throw err;
  }
}

/** One retry, but never for an answer that will not change: a 4xx, or data that fails its contract. */
export const retry = (failures: number, error: unknown): boolean =>
  failures < 1 && !(error instanceof HttpError && error.status < 500) && !(error instanceof ZodError);

export const queryClient = new QueryClient({
  // 'always': the default 'online' pauses every query after an `offline` event, so it would never reach the service
  // worker (#121), which decides what answers offline.
  defaultOptions: { queries: { retry, refetchOnWindowFocus: false, networkMode: 'always' } },
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

/** Polled while its data can still change (`pollMs`), so a page left open sees each new fetch (#99). */
export const sessionQuery = (key: number) =>
  queryOptions({
    queryKey: ['session', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}`, SessionDetail, signal),
    staleTime: STALE_MS,
    refetchInterval: (q) => (q.state.data ? pollMs(q.state.data.session) : false),
  });

export const useSession = (key: number) => useQuery(sessionQuery(key));

/**
 * A new fetch of the session (its `fetch_count` changed, not the first value seen) refetches its laps, stints and
 * weather once (#99); only the session query polls.
 */
export function useRefetchOnFetch(key: number, fetchCount: number | undefined) {
  const client = useQueryClient();
  const seen = useRef(fetchCount);
  useEffect(() => {
    if (fetchCount === undefined) return;
    if (seen.current !== undefined && seen.current !== fetchCount)
      for (const what of ['laps', 'stints', 'weather']) void client.invalidateQueries({ queryKey: [what, key] });
    seen.current = fetchCount;
  }, [client, key, fetchCount]);
}

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

/**
 * The rain map's grid and frames (P5c): polled every 60 s while `live` (the player) or while the grid is `live`
 * (#99), as the server adds a frame every 15 min.
 */
export const rainQuery = (key: number, live = false) =>
  queryOptions({
    queryKey: ['rain', key],
    queryFn: ({ signal }) => getJson(`/api/v1/sessions/${key}/rain`, Rain, signal),
    staleTime: STALE_MS,
    refetchInterval: (q) => (live || q.state.data?.grid?.state === 'live' ? 60_000 : false),
  });

export const useRain = (key: number, live = false) => useQuery(rainQuery(key, live));

/** A circuit's OpenStreetMap layers (ODbL, ADR-0008): SVG path data in km, any of them possibly empty. */
export type OsmLayers = { water: string; coast: string; roads: string };

/**
 * A circuit's outline file (A§6.3): SVG path data in km, north up; the viewBox around it; the start/finish bar when the
 * script's table has one (#91).
 */
export type Outline = { outline: string; viewBox: string; start?: string };

// The map files are bundled, one lazy chunk per file, so a map costs no request to a third party (or to the API). The
// default export, not a named one: Vite's JSON `stringify: 'auto'` gives a file over 10 kB a default export only.
const OUTLINES = import.meta.glob<Outline>('../map/*.json', { import: 'default' });
const OSM = import.meta.glob<OsmLayers>('../map/osm/*.json', { import: 'default' });

/** The circuit's outline file by map id, null when there is none. Never an OSM layer: the season page uses this. */
export const loadOutline = async (id: string): Promise<Outline | null> =>
  (await OUTLINES[`../map/${id}.json`]?.()) ?? null;

/** The circuit's outline and OSM layers by map id, each null when the circuit has no such file. */
export async function loadCircuitMap(id: string) {
  const [outline, osm] = await Promise.all([loadOutline(id), OSM[`../map/osm/${id}.json`]?.() ?? null]);
  return { outline: outline?.outline ?? null, osm: osm && { water: osm.water, coast: osm.coast, roads: osm.roads } };
}

/** The outline files of `ids` by map id, each in once its chunk is (the season page, #91). */
export const useOutlines = (ids: readonly string[]): ReadonlyMap<string, Outline> =>
  useQueries({
    queries: ids.map((id) => ({
      queryKey: ['outline', id],
      queryFn: () => loadOutline(id),
      staleTime: Number.POSITIVE_INFINITY,
    })),
    combine: (results) => new Map(results.flatMap((r, i) => (r.data ? [[ids[i] as string, r.data] as const] : []))),
  });

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

/**
 * Polled every 30 s while `enabled`, so `/live` picks up a session that starts and the player an `ended_at` that is
 * set; the session page enables it only while its session can be live.
 */
export const useLive = (enabled = true) =>
  useQuery({
    queryKey: ['live'],
    queryFn: ({ signal }) => getJson('/api/v1/live', Live, signal),
    refetchInterval: 30_000,
    enabled,
  });

/** The sessions the service worker keeps (#121, D4); `/` asks only once /seasons has failed. */
export const useSaved = (enabled: boolean) => useQuery({ queryKey: ['saved'], queryFn: savedSessions, enabled });

/** `enabled`: the header asks only on the player routes (#100). */
export const useRecordings = (refetchMs: number | false = false, enabled = true) =>
  useQuery({
    queryKey: ['recordings'],
    queryFn: ({ signal }) => getJson('/api/v1/recordings', Recordings, signal),
    staleTime: STALE_MS,
    refetchInterval: refetchMs,
    enabled,
  });
