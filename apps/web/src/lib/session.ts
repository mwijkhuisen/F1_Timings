import type { SessionDetail } from '@f1/contracts';
import type { CSSProperties } from 'react';

// Helpers shared by the lap table and the stints view.

const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

/** A known compound in lower case (its class is `cmp-<that>`), or null for null or anything else. */
export const compoundOf = (compound: string | null): string | null =>
  compound !== null && COMPOUNDS.includes(compound) ? compound.toLowerCase() : null;

export type Driver = { number: number; acronym: string; name: string | null; team: string | null };

const HEX = /^[0-9A-Fa-f]{6}$/;

/** `drivers.team_colour` as a CSS colour, or null unless it is six hex digits (D9). */
export const teamColour = (colour: string | null): string | null =>
  colour !== null && HEX.test(colour) ? `#${colour}` : null;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * A `#rrggbb` team colour darkened to at least 3:1 on the light `--bg` (#ffffff), for the light theme (A§13).
 * A colour with a WCAG luminance Y ≤ 0.3 already reaches 3:1 and comes back unchanged. Otherwise each linear-light
 * channel is scaled by 0.2999 / Y: scaling linear RGB keeps the ratios between the channels, so the chromaticity and
 * with it the OKLab hue stay the same up to the 8-bit rounding, and only the lightness drops. Flooring each channel
 * keeps Y below 0.3.
 */
export function clampForLight(hex: string): string {
  const lin = [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  const [r = 0, g = 0, b = 0] = lin;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (y <= 0.3) return hex;
  return `#${lin
    .map((c) =>
      Math.floor(toSrgb((c * 0.2999) / y) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The team colour as `--team`, plus `--team-l`, its light-theme copy (`clampForLight`); `.drv` picks one as `--tc`.
 * Without a team colour the CSS falls back to `--muted`.
 */
export const teamStyle = (driver: Driver): CSSProperties | undefined =>
  driver.team === null
    ? undefined
    : ({ '--team': driver.team, '--team-l': clampForLight(driver.team) } as CSSProperties);

/** The drivers that have laps, by result position (nulls last), then driver number (D10). */
export function orderDrivers(
  detail: Pick<SessionDetail, 'drivers' | 'results'>,
  laps: readonly { driver_number: number }[],
): Driver[] {
  const info = new Map(detail.drivers.map((d) => [d.driver_number, d]));
  const position = new Map(detail.results.map((r) => [r.driver_number, r.position]));
  const rank = (n: number) => position.get(n) ?? Number.POSITIVE_INFINITY;
  return [...new Set(laps.map((l) => l.driver_number))]
    .sort((a, b) => rank(a) - rank(b) || a - b)
    .map((n) => {
      const d = info.get(n);
      return {
        number: n,
        acronym: d?.acronym ?? String(n),
        name: d?.full_name ?? null,
        team: teamColour(d?.team_colour ?? null),
      };
    });
}
