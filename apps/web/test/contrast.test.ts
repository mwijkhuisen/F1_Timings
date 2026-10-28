import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A§13/D9: the timing colours, the text and the muted text (deleted laps) are text on --bg,
// and compound letters are text on their fill, so each needs WCAG AA 4.5:1 in the dark and
// the light theme.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

const tokens = (block: string) =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, k, v]) => [k, v]));
const dark = tokens(/^:root\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '');
const light = {
  ...dark,
  ...tokens(/@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''),
};

// WCAG 2.x relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

it('computes the WCAG ratio', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
});

describe.each([
  ['dark', dark],
  ['light', light],
])('the %s theme', (_name, theme) => {
  it('defines a background different from the other theme', () => {
    expect(theme.bg).toMatch(/^#/);
    expect(dark.bg).not.toBe(light.bg);
  });

  it.each(['purple', 'green', 'yellow', 'fg', 'muted'])('--%s reaches 4.5:1 on --bg', (token) => {
    const fg = theme[token];
    expect(fg, token).toMatch(/^#/);
    expect(contrast(fg ?? '', theme.bg ?? '')).toBeGreaterThanOrEqual(4.5);
  });

  // The compound dot and the stint bars put --on-cmp text on a compound fill; an unknown compound gets --unknown.
  it.each(['soft', 'medium', 'hard', 'intermediate', 'wet', 'unknown'])('--on-cmp reaches 4.5:1 on --%s', (token) => {
    const fill = theme[token];
    expect(fill, token).toMatch(/^#/);
    expect(contrast(theme['on-cmp'] ?? '', fill ?? '')).toBeGreaterThanOrEqual(4.5);
  });
});

it('draws compound text and fills only from those tokens', () => {
  const rule = /\.cmp,\s*\.seg\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toContain('color: var(--on-cmp);');
  expect(rule).toContain('background: var(--cmp, var(--unknown));');
  for (const [, name, value] of css.matchAll(/\.cmp-([\w-]+)\s*\{\s*--cmp:\s*([^;]+);/g))
    expect(value, name).toBe(`var(--${name})`);
});
