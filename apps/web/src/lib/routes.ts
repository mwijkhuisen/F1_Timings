import { type ComponentProps, createElement, type MouseEvent, useMemo, useSyncExternalStore } from 'react';

// The pages of the site (A§13), with no router library. A session segment is
// `<key>-<name>`: the key decides, the name is decoration (a bad one is
// canonicalised once the session is loaded). Importable in Node: `window` is
// touched only inside functions.

export type View = 'laps' | 'stints';

export type Route =
  | { id: 'latest' }
  | { id: 'year'; year: number }
  /** `view` is null for `/:year/:meeting/:session`, which redirects to `laps`. */
  | { id: 'session'; year: number; meeting: number; session: number; view: View | null }
  | { id: 'status' };

const KEY_SEGMENT = /^(\d{1,9})(?:-[a-z0-9-]*)?$/;
const YEAR = /^\d{4}$/;

const keyOf = (segment: string): number | null => {
  const m = KEY_SEGMENT.exec(segment);
  return m?.[1] === undefined ? null : Number(m[1]);
};

/** The page of a location's pathname (percent-decoded first), or null for any other path. */
export function routeOf(pathname: string): Route | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (path === '/') return { id: 'latest' };
  const [root, a, b, c, d, ...extra] = path.split('/');
  if (root !== '' || a === undefined || extra.length > 0) return null;
  if (a === 'status') return b === undefined ? { id: 'status' } : null;
  if (!YEAR.test(a)) return null;
  const year = Number(a);
  if (b === undefined) return { id: 'year', year };
  const meeting = keyOf(b);
  const session = c === undefined ? null : keyOf(c);
  if (meeting === null || session === null) return null;
  if (d === undefined) return { id: 'session', year, meeting, session, view: null };
  return d === 'laps' || d === 'stints' ? { id: 'session', year, meeting, session, view: d } : null;
}

/** Lower case, diacritics stripped, every run of other characters one `-`, trimmed. */
export const slug = (name: string | null): string =>
  (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

type Named = { key: number; name: string | null };

const segment = (key: number, name: string) => (name === '' ? `${key}` : `${key}-${name}`);

/** The canonical URL of a session view. Meetings drop a trailing " Grand Prix". */
export const sessionPath = (year: number, meeting: Named, session: Named, view: View): string =>
  `/${year}/${segment(meeting.key, slug(meeting.name?.replace(/ Grand Prix$/i, '') ?? null))}/${segment(session.key, slug(session.name))}/${view}`;

const NAVIGATE = 'f1:navigate';

/** Replace the current URL without a history entry (a redirect or a canonical URL). */
export function replace(path: string): void {
  history.replaceState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
}

export function navigate(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

export function useRoute(): Route | null {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  return useMemo(() => routeOf(pathname), [pathname]);
}

/** A real link: only a plain left click navigates in place, so a modified or middle click opens a new tab. */
export function Link({ to, onClick, ...rest }: Omit<ComponentProps<'a'>, 'href'> & { to: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target !== undefined && rest.target !== '_self') return;
    e.preventDefault();
    navigate(to);
  };
  // createElement keeps this file plain .ts, so Node tests import it as it is.
  return createElement('a', { ...rest, href: to, onClick: click });
}
