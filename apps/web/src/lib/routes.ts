import { type ComponentProps, createElement, type MouseEvent, useEffect, useMemo, useSyncExternalStore } from 'react';

// The pages of the site (A§13), with no router library. A session segment is
// `<key>-<name>`: the key decides, the name is decoration (a bad one is
// canonicalised once the session is loaded). Importable in Node: `window` is
// touched only inside functions.

export type View = 'laps' | 'compare' | 'minisectors' | 'stints';

/** A view's name on its tab and in the title. */
export const VIEW_LABEL: Record<View, string> = {
  laps: 'Laps',
  compare: 'Compare',
  minisectors: 'Mini-sectors',
  stints: 'Stints',
};

export type Route =
  | { id: 'latest' }
  | { id: 'year'; year: number }
  /** `view` is null for `/:year/:meeting/:session`, which redirects to `laps`. */
  | { id: 'session'; year: number; meeting: number; session: number; view: View | null }
  | { id: 'status' }
  | { id: 'live' }
  | { id: 'replays' }
  | { id: 'replay'; recording: number };

const KEY_SEGMENT = /^(\d{1,9})(?:-[a-z0-9-]*)?$/;
const YEAR = /^\d{4}$/;
const ID = /^\d{1,9}$/;

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
  if (a === 'live') return b === undefined ? { id: 'live' } : null;
  if (a === 'replay' && b === undefined) return { id: 'replays' };
  if (a === 'replay')
    return b !== undefined && c === undefined && ID.test(b) ? { id: 'replay', recording: Number(b) } : null;
  if (!YEAR.test(a)) return null;
  const year = Number(a);
  if (b === undefined) return { id: 'year', year };
  const meeting = keyOf(b);
  const session = c === undefined ? null : keyOf(c);
  if (meeting === null || session === null) return null;
  if (d === undefined) return { id: 'session', year, meeting, session, view: null };
  return d === 'laps' || d === 'compare' || d === 'minisectors' || d === 'stints'
    ? { id: 'session', year, meeting, session, view: d }
    : null;
}

type Names = { meeting: string | null; session: string | null };

/** `document.title` of a page: names only, never a result (A§13). A session without its names shows its year. */
export function titleOf(route: Route | null, names?: Names): string {
  const n = names && `${names.meeting ?? '—'} · ${names.session ?? '—'}`;
  const page = (() => {
    switch (route?.id) {
      case undefined:
        return 'Not found';
      case 'latest':
        return null;
      case 'year':
        return `${route.year}`;
      case 'session':
        return n ? `${n} · ${VIEW_LABEL[route.view ?? 'laps']}` : `${route.year}`;
      case 'status':
        return 'Status';
      case 'live':
        return 'Live';
      case 'replays':
        return 'Replays';
      case 'replay':
        return n ? `Replay: ${n}` : 'Replay';
    }
  })();
  return page === null ? 'F1 Timings' : `${page} · F1 Timings`;
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

/** Set by `navigate()` to a new path, cleared once `useHeadingFocus` has focused the h1 (A§13). */
let focusPending = false;

/** Replace the current URL without a history entry (a redirect or a canonical URL). */
export function replace(path: string): void {
  history.replaceState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
}

export function navigate(path: string): void {
  if (path !== location.pathname) focusPending = true;
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

/**
 * After a `navigate()`, focus `main h1`, waiting for it to mount. `replace()`, popstate and the first load never
 * set the flag; a pending focus survives a redirect by `replace()`, so it lands on the page the redirect shows.
 */
export function useHeadingFocus(route: Route | null): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is the trigger, a page change.
  useEffect(() => {
    if (!focusPending) return;
    const focus = () => {
      const h1 = document.querySelector<HTMLElement>('main h1');
      h1?.focus();
      if (h1) focusPending = false;
      return h1 !== null;
    };
    const main = document.querySelector('main');
    if (focus() || !main) return;
    const observer = new MutationObserver(() => focus() && observer.disconnect());
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [route]);
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
