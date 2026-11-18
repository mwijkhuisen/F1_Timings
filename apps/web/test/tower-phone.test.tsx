// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Tower } from '../src/views/Tower.tsx';
import { raceState } from './feed-state.ts';

// The tower's column order follows the viewport (#237): a matchMedia `change` re-renders the heads.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it('flips the head order when the media query changes', () => {
  let matches = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Tower state={raceState()} />));
  const heads = () => [...host.querySelectorAll('thead th')].slice(0, 5).map((th) => th.textContent);
  expect(heads()).toEqual(['Pos', 'Driver', '±Places since the start', 'Gap', 'Int']);
  expect(listeners.size).toBe(1);
  matches = true;
  act(() => {
    for (const cb of listeners) cb();
  });
  expect(heads()).toEqual(['Pos', 'Driver', 'Gap', 'Int', 'Last']);
  matches = false;
  act(() => {
    for (const cb of listeners) cb();
  });
  expect(heads()).toEqual(['Pos', 'Driver', '±Places since the start', 'Gap', 'Int']);
  act(() => root.unmount());
  host.remove();
});
