import { Component, type ReactNode } from 'react';
import { ZodError } from 'zod';
import { HttpError, useStale } from '../lib/api.ts';

export const NEW_VERSION = 'A new version is out: reload the page.';

/** D5 (#121): what a page that needs the network says offline. Node has no `onLine`: compare with false. */
export const OFFLINE = 'You are offline: this page needs the network.';

/** What the error view says. Never a response body or a ZodError message (A§12.1). */
export function errorText(error: unknown): string {
  // A TypeError is no network, or else Access's login redirect under `redirect: 'error'`.
  if (error instanceof TypeError && navigator.onLine === false) return OFFLINE;
  if ((error instanceof HttpError && error.status === 401) || error instanceof TypeError)
    return 'Your Access session may have expired: reload to sign in.';
  if (error instanceof HttpError && error.status === 404) return 'Not found.';
  if (error instanceof ZodError) return NEW_VERSION;
  return 'API error';
}

/** The app-wide reload banner: another revision answered, or an answer failed its contract (A§13). */
export const NewVersion = () => (useStale() ? <p role="alert">{NEW_VERSION}</p> : null);

export const ErrorView = ({ error }: { error: unknown }) => <p role="alert">{errorText(error)}</p>;

/** A query without data yet: its error, or a loading line. */
export const Pending = ({ error }: { error: unknown }) =>
  error ? <ErrorView error={error} /> : <p className="muted">Loading…</p>;

export const NotFound = () => <p>Page not found.</p>;

/**
 * A render exception shows a line instead of a blank page. Not errorText: a render bug is
 * usually a TypeError, which errorText would call an expired Access session.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p role="alert">Something went wrong: reload the page.</p> : this.props.children;
  }
}
