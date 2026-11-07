import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clampForLight } from '../src/lib/session.ts';

// A§13 (P4a): every text token on every surface, the mini-sector fills, the compound letters, the colour
// separation of the timing colours and the light-theme team clamp, in both themes. The colour maths here is
// the test's own oracle (WCAG 2.x, OKLab, Machado 2009); it shares nothing with the app's.

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
// The mini-sector fills (purple and green full, other and unknown half height, pit hatched, no data dashed).
const FILLS = ['purple', 'green', 'ms-other', 'pit', 'muted', 'dim'];
const COMPOUNDS = ['soft', 'medium', 'hard', 'intermediate', 'wet', 'unknown'];
// Lines, washes and rings: drawn next to text, never as text or a meaning of their own.
const DECORATION = ['line', 'line-soft', 'heat-1', 'heat-2', 'heat-3', 'cmp-ring', 'on-cmp', 'display'];

// ---- the oracle

const linear = (h: string) =>
  [1, 3, 5].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

// WCAG 2.x relative luminance and contrast ratio.
const luminance = (h: string) => {
  const [r, g, b] = linear(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

type Vec = [number, number, number];
const mul = (m: Vec[], v: Vec) => m.map(([a, b, c]) => a * v[0] + b * v[1] + c * v[2]) as Vec;

// OKLab (Ottosson 2020) from linear sRGB.
const oklab = (lin: Vec): Vec => {
  const lms = mul(
    [
      [0.4122214708, 0.5363325363, 0.0514459929],
      [0.2119034982, 0.6806995451, 0.1073969566],
      [0.0883024619, 0.2817188376, 0.6299787005],
    ],
    lin,
  ).map(Math.cbrt) as Vec;
  return mul(
    [
      [0.2104542553, 0.793617785, -0.0040720468],
      [1.9779984951, -2.428592205, 0.4505937099],
      [0.0259040371, 0.7827717662, -0.808675766],
    ],
    lms,
  );
};

// Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear RGB and clamped to [0, 1].
const VISION: Record<string, Vec[] | null> = {
  normal: null,
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
};
const seen = (h: string, vision: string): Vec => {
  const m = VISION[vision];
  const lin = linear(h);
  return oklab(m ? (mul(m, lin).map((c) => Math.min(1, Math.max(0, c))) as Vec) : lin);
};
/** ΔE in OKLab × 100, as the vision sees the two colours. */
const deltaE = (a: string, b: string, vision = 'normal') => {
  const [x, y] = [seen(a, vision), seen(b, vision)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
};
/** The smallest ΔE between any two colours of a set. */
const minDeltaE = (set: string[], vision: string) =>
  Math.min(...set.flatMap((a, i) => set.slice(i + 1).map((b) => deltaE(a, b, vision))));

const lch = (h: string) => {
  const [, a, b] = oklab(linear(h));
  return { c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
};

describe('the oracle', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  // The figures of docs/design/2026-11-redesign/README.md.
  it('reproduces the review: the old light green and yellow, and dark green against --fg', () => {
    expect(deltaE('#18803a', '#8a6400')).toBeCloseTo(13.8, 1);
    expect(deltaE('#18803a', '#8a6400', 'deutan')).toBeCloseTo(4.6, 1);
    expect(deltaE('#3ccf6e', '#f0f0f5', 'protan')).toBeCloseTo(19.8, 1);
  });
});

describe('the tokens', () => {
  it('classifies every token, so none skips a check', () => {
    const known = new Set([...SURFACES, ...TEXT, ...FILLS, ...COMPOUNDS, ...DECORATION]);
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

  it.each(FILLS)('the mini-sector fill --%s reaches 3:1 on --bg', (token) => {
    expect(contrast(hex(theme, token), hex(theme, 'bg'))).toBeGreaterThanOrEqual(3);
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
  ])('purple, green and --fg are at least ΔE %s %s apart', (vision, bar) => {
    const set = ['purple', 'green', 'fg'].map((t) => hex(theme, t));
    expect(minDeltaE(set, vision)).toBeGreaterThanOrEqual(bar);
  });
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
