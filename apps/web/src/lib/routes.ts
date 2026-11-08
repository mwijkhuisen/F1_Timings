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

/** A word in front of a page's title (D1), such as the pit wall's session light: "Safety car · Live · F1 Timings". */
export const withWord = (word: string | null, title: string): string => (word ? `${word} · ${title}` : title);

// The title word: a tiny external store, so a page (views/Player.tsx) can set it while App stays the one writer of
// `document.title`.
let titleWord: string | null = null;
const wordSubs = new Set<() => void>();

/** Sets the word in front of the title, or clears it with null. */
export function setTitleWord(word: string | null): void {
  if (word === titleWord) return;
  titleWord = word;
  for (const f of wordSubs) f();
}

function subscribeWord(onChange: () => void): () => void {
  wordSubs.add(onChange);
  return () => {
    wordSubs.delete(onChange);
  };
}

/**
 * Writes `document.title` (A§13), one writer per route (App's Title): the page's title, with the title word in front
 * while one is set.
 */
export function useTitle(title: string): void {
  const word = useSyncExternalStore(
    subscribeWord,
    () => titleWord,
    () => titleWord,
  );
  const full = withWord(word, title);
  useEffect(() => {
    document.title = full;
  }, [full]);
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

const D_PARAM = /^\d+(,\d+)*$/;

/**
 * The picked drivers of `?d=` (C4), in the given order: unknown and repeated numbers dropped. Null, meaning the
 * default pick, for a missing, malformed or over-long (> 100 characters) param, or one with no known driver.
 */
export function parseD(param: string | null, drivers: readonly { number: number }[]): number[] | null {
  if (param === null || param.length > 100 || !D_PARAM.test(param)) return null;
  const known = new Set(drivers.map((d) => d.number));
  const out = [...new Set(param.split(',').map(Number))].filter((n) => known.has(n));
  return out.length > 0 ? out : null;
}

/** The value of `?d=`: the numbers in pick order, joined with ','. */
export const formatD = (numbers: readonly number[]): string => numbers.join(',');

const NAVIGATE = 'f1:navigate';

/** Set by `navigate()` to a new path, cleared once `useHeadingFocus` has focused the h1 or by back/forward (A§13). */
let focusPending = false;

/** Replace the current URL without a history entry (a redirect or a canonical URL). */
export function replace(path: string): void {
  history.replaceState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
}

export function navigate(path: string): void {
  // The query is part of the page (`?d=` on Compare), not a new page: no focus move for it alone.
  if (path.split('?')[0] !== location.pathname) focusPending = true;
  history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

function subscribe(onChange: () => void): () => void {
  // A navigation to a page without an h1 (Not found, an error) leaves the flag set: back/forward must not focus.
  const onPop = () => {
    focusPending = false;
    onChange();
  };
  window.addEventListener('popstate', onPop);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener('popstate', onPop);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

export function useRoute(): Route | null {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  return useMemo(() => routeOf(pathname), [pathname]);
}

/**
 * After a `navigate()`, focus `main h1`, waiting for it to mount. `replace()`, popstate and the first load never
 * set the flag, and popstate clears it; a pending focus survives a redirect by `replace()`, so it lands on the page
 * the redirect shows.
 */
export function useHeadingFocus(route: Route | null): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is the trigger, a page change.
  useEffect(() => {
    if (!focusPending) return;
    // True ends the wait: also once back/forward has cleared the flag (the route may not change: two Not found pages).
    const focus = () => {
      if (!focusPending) return true;
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
