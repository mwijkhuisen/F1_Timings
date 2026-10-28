import { Laps, Season, Seasons, SessionDetail, Status, Stints } from '@f1/contracts';
import { QueryClient, useQuery } from '@tanstack/react-query';

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

async function getJson<T>(path: string, contract: { parse(data: unknown): T }, signal: AbortSignal): Promise<T> {
  // redirect: 'error' turns Access's login redirect into a TypeError instead of an HTML page.
  const res = await fetch(path, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status);
  return contract.parse(await res.json());
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const STALE_MS = 60_000;

export const useSeasons = () =>
  useQuery({
    queryKey: ['seasons'],
    queryFn: ({ signal }) => getJson('/api/v1/seasons', Seasons, signal),
    staleTime: STALE_MS,
  });

export const useSeason = (year: number) =>
  useQuery({
    queryKey: ['season', year],
    queryFn: ({ signal }) => getJson(`/api/v1/seasons/${year}`, Season, signal),
    staleTime: STALE_MS,
  });

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

export const useStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => getJson('/api/v1/status', Status, signal),
    staleTime: STALE_MS,
  });
