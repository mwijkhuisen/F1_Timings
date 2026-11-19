// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../src/lib/session.ts';
import { DriverPicker } from '../src/views/DriverPicker.tsx';

// A pick in "Add driver" closes the disclosure (#238); the static markup is pinned in compare.test.tsx.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const driver = (number: number, acronym: string): Driver =>
  ({ number, acronym, name: acronym, team: 'T', colour: '3671C6' }) as unknown as Driver;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DriverPicker', () => {
  it('closes "Add driver" after a pick, and still reports it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onToggle = vi.fn();
    const root = createRoot(host);
    act(() =>
      root.render(<DriverPicker drivers={[driver(1, 'VER'), driver(4, 'NOR')]} selected={[1]} onToggle={onToggle} />),
    );
    const details = host.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    const nor = [...details.querySelectorAll('button')].find((b) => b.textContent === 'NOR');
    act(() => nor?.click());
    expect(onToggle).toHaveBeenCalledWith(4);
    expect(details.open).toBe(false);
    act(() => root.unmount());
  });
});
