// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate, replace, useHeadingFocus, useRoute } from '../src/lib/routes.ts';

// The focus rule (A§13): a navigation moves focus to the page's h1; the first load and a redirect do not.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Page({ heading }: { heading: boolean }) {
  useHeadingFocus(useRoute());
  return <main>{heading && <h1 tabIndex={-1}>Page</h1>}</main>;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (heading: boolean) => act(() => root.render(<Page heading={heading} />));
const h1 = () => document.querySelector('main h1');

describe('useHeadingFocus', () => {
  it('leaves focus alone on the first render', () => {
    render(true);
    expect(h1()).not.toBeNull();
    expect(document.activeElement).not.toBe(h1());
  });

  it('focuses the h1 after navigate()', () => {
    render(true);
    act(() => navigate('/x'));
    expect(document.activeElement).toBe(h1());
  });

  it('focuses an h1 that mounts after the navigation', async () => {
    render(false);
    act(() => navigate('/later'));
    expect(h1()).toBeNull();
    render(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(h1()));
  });

  it('leaves focus alone after replace()', () => {
    render(true);
    act(() => replace('/y'));
    expect(location.pathname).toBe('/y');
    expect(document.activeElement).not.toBe(h1());
  });
});
