// The theme (A§13): `data-theme` on <html>, dark or light. The header's moon saves a pick; without one the
// system's prefers-color-scheme decides at boot (main.tsx).

export type Theme = 'dark' | 'light';

const KEY = 'f1.theme';

/** The saved pick, else the system's; dark when storage throws and matchMedia says nothing. */
export function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'dark' || t === 'light') return t;
  } catch {
    // Private mode or blocked storage: follow the system.
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Calls back on every theme switch (the moon, or the system's while nothing is saved); returns the unsubscribe. */
export function subscribeTheme(cb: () => void): () => void {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => o.disconnect();
}

/** Sets the theme and saves it as the pick. */
export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // As in the player: not remembered.
  }
}
