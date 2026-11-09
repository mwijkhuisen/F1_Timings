import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deltaE, linear, oklab, type Vision } from '../src/lib/colour.ts';
import { clampForLight } from '../src/lib/session.ts';

// A§13 (P4a): every text token on every surface, the mini-sector fills, the compound letters, the colour
// separation of the timing colours and the light-theme team clamp, in both themes. The WCAG maths here is the
// test's own; OKLab and Machado 2009 come from src/lib/colour.ts (the chart's line types use them too), pinned
// below against the review's figures.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** Every `--name: value;` of a block, whatever the value (hex, rgb(), transparent, a font stack). */
const tokens = (block: string): Record<string, string> =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k = '', v = '']) => [k, v.trim()]));
const darkOwn = tokens(/^:root\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '');
const lightOwn = tokens(/@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const dark = darkOwn;
const light = { ...darkOwn, ...lightOwn };

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (theme: Record<string, string>, token: string) => {
  const v = theme[token] ?? '';
  expect(v, `--${token}`).toMatch(HEX);
  return v;
};

// The token classes. Each token is in one, so a new one cannot skip the checks below.
const SURFACES = ['bg', 'panel', 'raised'];
const TEXT = ['fg', 'muted', 'dim', 'purple', 'green', 'live', 'amber'];
// The mini-sector fills (purple and green full, other and unknown half height, pit hatched, no data dashed) and the
// rain map's three steps (P5c).
const FILLS = ['purple', 'green', 'ms-other', 'pit', 'muted', 'dim', 'rain-1', 'rain-2', 'rain-3'];
const COMPOUNDS = ['soft', 'medium', 'hard', 'intermediate', 'wet', 'unknown'];
// Lines, washes and rings: drawn next to text, never as text or a meaning of their own; the rain map's water and roads
// are context under the rain (P5c, D2).
const DECORATION = ['line', 'line-soft', 'cmp-ring', 'on-cmp', 'display', 'map-water', 'map-road'];
// Translucent washes behind text (`rgb(r g b / a)`), checked composited over --bg.
const WASHES = ['purple-wash', 'heat-1', 'heat-2', 'heat-3'];
// Chart bands (P5a): drawn translucent under the lines, named by a text key whose swatch is the full colour.
const BANDS = ['rain'];

// ---- the oracle

// WCAG 2.x relative luminance and contrast ratio.
const luminance = (h: string) => {
  const [r, g, b] = linear(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The smallest ΔE between any two colours of a set. */
const minDeltaE = (set: string[], vision: Vision) =>
  Math.min(...set.flatMap((a, i) => set.slice(i + 1).map((b) => deltaE(a, b, vision))));

const lch = (h: string) => {
  const [, a, b] = oklab(linear(h));
  return { c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
};

/** `rgb(r g b / a)` over an opaque hex background, as the browser blends it (in sRGB), as hex. */
const over = (wash: string, bg: string) => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(wash);
  expect(m, wash).not.toBeNull();
  const [r = 0, g = 0, b = 0, a = 0] = (m ?? []).slice(1).map(Number);
  return `#${[r, g, b]
    .map((c, i) => {
      const under = Number.parseInt(bg.slice(1 + 2 * i, 3 + 2 * i), 16);
      return Math.round(c * a + under * (1 - a))
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
};

describe('the oracle', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  // The figures of docs/design/2026-11-redesign/README.md.
  it('composites a wash over a background', () => {
    expect(over('rgb(255 255 255 / 0.5)', '#000000')).toBe('#808080');
    expect(over('rgb(0 0 0 / 0)', '#15151e')).toBe('#15151e');
  });

  it('reproduces the review: the old light green and yellow, and dark green against --fg', () => {
    expect(deltaE('#18803a', '#8a6400')).toBeCloseTo(13.8, 1);
    expect(deltaE('#18803a', '#8a6400', 'deutan')).toBeCloseTo(4.6, 1);
    expect(deltaE('#3ccf6e', '#f0f0f5', 'protan')).toBeCloseTo(19.8, 1);
  });

  // The README's pair, rounded as the README prints it: lib/colour.ts is the app's copy of this maths.
  it('pins lib/colour.ts to the README: #18803a against #8a6400 is 13.8, and 4.6 for deutan vision', () => {
    const round = (x: number) => Math.round(x * 10) / 10;
    expect(round(deltaE('#18803a', '#8a6400'))).toBe(13.8);
    expect(round(deltaE('#18803a', '#8a6400', 'deutan'))).toBe(4.6);
  });
});

describe('the tokens', () => {
  it('classifies every token, so none skips a check', () => {
    const known = new Set([...SURFACES, ...TEXT, ...FILLS, ...COMPOUNDS, ...DECORATION, ...WASHES, ...BANDS]);
    for (const k of [...Object.keys(darkOwn), ...Object.keys(lightOwn)]) expect(known.has(k), `--${k}`).toBe(true);
    for (const k of known) expect(darkOwn, `--${k}`).toHaveProperty(k);
  });

  it('defines every light token in the dark theme too', () => {
    for (const k of Object.keys(lightOwn)) expect(darkOwn, `--${k}`).toHaveProperty(k);
  });

  it('has a different background per theme', () => {
    expect(hex(dark, 'bg')).not.toBe(hex(light, 'bg'));
  });

  // Forced colours drop box-shadow, so every cue is an outline or a border (A§13).
  it('draws no cue with box-shadow', () => {
    expect(css).not.toContain('box-shadow');
  });

  it('draws compound text and fills only from those tokens', () => {
    const rule = /\.cmp,\s*\.seg\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('color: var(--on-cmp);');
    expect(rule).toContain('background: var(--cmp, var(--unknown));');
    for (const [, name, value] of css.matchAll(/\.cmp-([\w-]+)\s*\{\s*--cmp:\s*([^;]+);/g))
      expect(value, name).toBe(`var(--${name})`);
  });
});

describe.each([
  ['dark', dark],
  ['light', light],
])('the %s theme', (_name, theme) => {
  describe.each(SURFACES)('on --%s', (surface) => {
    it.each(TEXT)('--%s reaches 4.5:1', (token) => {
      expect(contrast(hex(theme, token), hex(theme, surface))).toBeGreaterThanOrEqual(4.5);
    });
  });

  // The overall best is purple text on its wash; a Δ is --fg text on its step (P4b).
  it('--purple reaches 4.5:1 on --purple-wash over --bg', () => {
    const bg = hex(theme, 'bg');
    expect(contrast(hex(theme, 'purple'), over(theme['purple-wash'] ?? '', bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['heat-1', 'heat-2', 'heat-3'])('--fg reaches 4.5:1 on --%s over --bg', (token) => {
    const bg = hex(theme, 'bg');
    expect(contrast(hex(theme, 'fg'), over(theme[token] ?? '', bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(FILLS)('the fill --%s reaches 3:1 on --bg', (token) => {
    expect(contrast(hex(theme, token), hex(theme, 'bg'))).toBeGreaterThanOrEqual(3);
  });

  // A graphic (WCAG 1.4.11): the rain key's swatch frame is the full colour, on --panel inside a card.
  it.each(BANDS)('the band colour --%s reaches 3:1 on --bg and --panel', (token) => {
    expect(contrast(hex(theme, token), hex(theme, 'bg'))).toBeGreaterThanOrEqual(3);
    expect(contrast(hex(theme, token), hex(theme, 'panel'))).toBeGreaterThanOrEqual(3);
  });

  // The compound dot and the stint bars put --on-cmp text on a compound fill; an unknown compound gets --unknown.
  it.each(COMPOUNDS)('--on-cmp reaches 4.5:1 on --%s', (token) => {
    expect(contrast(hex(theme, 'on-cmp'), hex(theme, token))).toBeGreaterThanOrEqual(4.5);
  });

  // Purple (overall best), green (personal best) and plain text must read apart for everyone.
  it.each([
    ['normal', 15],
    ['deutan', 8],
    ['protan', 8],
  ] as [Vision, number][])('purple, green and --fg are at least ΔE %s %s apart', (vision, bar) => {
    const set = ['purple', 'green', 'fg'].map((t) => hex(theme, t));
    expect(minDeltaE(set, vision)).toBeGreaterThanOrEqual(bar);
  });

  // The rain map's steps (P5c, D2): every pair of the three steps and the water reads apart for everyone.
  it.each(['normal', 'deutan', 'protan'] as Vision[])(
    'the rain steps and the water are at least ΔE 8 apart (%s)',
    (vision) => {
      const set = ['rain-1', 'rain-2', 'rain-3', 'map-water'];
      for (const [i, a] of set.entries())
        for (const b of set.slice(i + 1))
          expect(deltaE(hex(theme, a), hex(theme, b), vision), `--${a} --${b}`).toBeGreaterThanOrEqual(8);
    },
  );
});

it('fails the separation bar with the old light tokens (purple, green and yellow before P4a)', () => {
  const old = ['#7d2fc2', '#18803a', '#8a6400'];
  expect(minDeltaE(old, 'normal')).toBeLessThan(15);
  expect(minDeltaE(old, 'deutan')).toBeLessThan(8);
});

describe('clampForLight', () => {
  const bg = hex(light, 'bg');
  // Any six-digit colour, in lower or upper case.
  const anyHex = fc.tuple(fc.integer({ min: 0, max: 0xffffff }), fc.boolean()).map(([n, upper]) => {
    const h = `#${n.toString(16).padStart(6, '0')}`;
    return upper ? h.toUpperCase() : h;
  });
  const RUNS = { numRuns: 2000 };

  it('reaches 3:1 on the light --bg for any colour', () => {
    fc.assert(
      fc.property(anyHex, (h) => {
        const out = clampForLight(h);
        expect(out).toMatch(HEX);
        expect(contrast(out, bg)).toBeGreaterThanOrEqual(3);
      }),
      RUNS,
    );
  });

  it('keeps the OKLCH hue within 5° once the colour has chroma (≥ 0.04)', () => {
    fc.assert(
      fc.property(anyHex, (h) => {
        fc.pre(lch(h).c >= 0.04);
        const d = Math.abs(lch(h).h - lch(clampForLight(h)).h) % 360;
        expect(Math.min(d, 360 - d)).toBeLessThanOrEqual(5);
      }),
      RUNS,
    );
  });

  it('returns a colour that already reaches 3:1 unchanged', () => {
    fc.assert(
      fc.property(anyHex, (h) => {
        fc.pre(contrast(h, bg) >= 3);
        expect(clampForLight(h)).toBe(h);
      }),
      RUNS,
    );
  });

  it('darkens Mercedes #00D7B6 from 1.84:1 to 3:1', () => {
    expect(contrast('#00D7B6', bg)).toBeCloseTo(1.84, 2);
    const out = clampForLight('#00D7B6');
    expect(out).toBe('#00a88d');
    expect(contrast(out, bg)).toBeGreaterThanOrEqual(3);
  });
});
