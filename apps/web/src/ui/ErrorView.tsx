import { ZodError } from 'zod';
import { HttpError } from '../lib/api.ts';

/** What the error view says. Never a response body or a ZodError message (A§12.1). */
export function errorText(error: unknown): string {
  // A TypeError is Access's login redirect under `redirect: 'error'` (or no network).
  if ((error instanceof HttpError && error.status === 401) || error instanceof TypeError)
    return 'Your Access session may have expired: reload to sign in.';
  if (error instanceof HttpError && error.status === 404) return 'Not found.';
  if (error instanceof ZodError) return 'Unexpected data from the API.';
  return 'API error';
}

export const ErrorView = ({ error }: { error: unknown }) => <p role="alert">{errorText(error)}</p>;

export const NotFound = () => <p>Page not found.</p>;
