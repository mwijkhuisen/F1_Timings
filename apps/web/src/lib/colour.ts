// Colour maths shared by the app and test/contrast.test.ts: linear sRGB, OKLab (Ottosson 2020) and
// colour-vision simulation (Machado, Oliveira and Fernandes 2009). The chart's line types (C2) and
// clampForLight use it; contrast.test.ts pins it against the review's figures.

export type Vec = [number, number, number];

/** A `#rrggbb` colour as linear-light sRGB channels in [0, 1]. */
export const linear = (h: string) =>
  [1, 3, 5].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Vec;

export const mul = (m: Vec[], v: Vec) => m.map(([a, b, c]) => a * v[0] + b * v[1] + c * v[2]) as Vec;

/** OKLab (Ottosson 2020) from linear sRGB. */
export const oklab = (lin: Vec): Vec => {
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

export type Vision = 'normal' | 'deutan' | 'protan';

/** Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear RGB and clamped to [0, 1]. */
export const VISION: Record<Vision, Vec[] | null> = {
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

const seen = (h: string, vision: Vision): Vec => {
  const m = VISION[vision];
  const lin = linear(h);
  return oklab(m ? (mul(m, lin).map((c) => Math.min(1, Math.max(0, c))) as Vec) : lin);
};

/** ΔE in OKLab × 100, as the vision sees the two colours. */
export const deltaE = (a: string, b: string, vision: Vision = 'normal') => {
  const [x, y] = [seen(a, vision), seen(b, vision)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
};
