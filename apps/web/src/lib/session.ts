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

/** The team colour as the `--team` custom property; without one the CSS falls back to `--muted`. */
export const teamStyle = (driver: Driver): CSSProperties | undefined =>
  driver.team === null ? undefined : ({ '--team': driver.team } as CSSProperties);

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
