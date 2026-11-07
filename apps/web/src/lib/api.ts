import { Laps, Live, Recordings, Season, Seasons, SessionDetail, Status, Stints } from '@f1/contracts';
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

export const useSeason = (year: number) => useQuery(seasonQuery(year));

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

export const useRecordings = () =>
  useQuery({
    queryKey: ['recordings'],
    queryFn: ({ signal }) => getJson('/api/v1/recordings', Recordings, signal),
    staleTime: STALE_MS,
  });
