import type { Live, SessionDetail } from '@f1/contracts';
import type { CSSProperties } from 'react';
import { linear } from './colour.ts';
import { isLiveNow } from './season.ts';
import { fmtHm } from './time.ts';

// Helpers shared by the session's tabs: why data is missing and when to refresh (#99), the lap table and the stints.

type Session = SessionDetail['session'];

/** After its first fetch a session is `fetched` or `due` only until date_end + 24 h (A§8). */
const DAY_MS = 24 * 3_600_000;

const ERROR_WORDS: Record<string, string> = {
  rate_limited: 'rate limited',
  timeout: 'timed out',
  network: 'network error',
  schema: 'unexpected data',
  empty: 'empty answer',
  db: 'database error',
};

/** A `last_error` code in fixed words: "HTTP 503" for `http_503`, "unknown error" for `unknown`, null or anything else. */
export function errorWords(code: string | null): string {
  const http = /^http_(\d{3})$/.exec(code ?? '');
  if (http) return `HTTP ${http[1]}`;
  return (code !== null && Object.hasOwn(ERROR_WORDS, code) && ERROR_WORDS[code]) || 'unknown error';
}

const SOURCE_WORDS: Record<Session['source'], string> = {
  openf1: 'the OpenF1 data',
  'f1-archive': 'the F1 archive',
  'f1-live': 'the F1 live feed',
  jolpica: 'the Jolpica data',
};

/** Where a session's rows come from, for the reasons: "the OpenF1 data", "the F1 archive", … */
export const sourceWords = (source: Session['source']): string => SOURCE_WORDS[source];

const ARRIVE = { laps: 'Laps arrive', stints: 'Stints arrive', weather: 'Weather arrives' } as const;

/** `noDataText` for a session live right now; `ui/NoData.tsx` links "follow it" to `/live`. */
export const LIVE_TEXT = 'Live now: follow it.';

/**
 * Why a tab has no laps, stints or weather (A§13), the first rule that holds: cancelled; live now; after a fetch that
 * succeeded (`fetch_count` > 0), none in the session's source (the head's "data provisional" says the rest); in
 * back-off (with the next try in Amsterdam time, or a retry due); failed; `fetched` or `due` past date_end + 24 h; not
 * started; still to come (`scheduled`, `due`); else none in the session's source.
 */
export function noDataText(s: Session, live: Live | null, now: number, what: 'laps' | 'stints' | 'weather'): string {
  if (s.is_cancelled) return `No ${what}: the session was cancelled.`;
  if (isLiveNow(s.session_key, live)) return LIVE_TEXT;
  const none = `No ${what} in ${sourceWords(s.source)}.`;
  if (s.fetch_count > 0) return none;
  const error = errorWords(s.last_error);
  if (s.ingest_state === 'due' && s.fail_count > 0) {
    const next = s.next_fetch_at === null ? null : Date.parse(s.next_fetch_at);
    const when = next === null ? '' : next <= now ? '; a retry is due' : `; next try at ${fmtHm(next)}`;
    return `The fetch failed (${error})${when}.`;
  }
  if (s.ingest_state === 'failed') return `The fetch failed ${s.fail_count} times (${error}) and is not retried.`;
  const queued = s.ingest_state === 'fetched' || s.ingest_state === 'due';
  if (queued && now > Date.parse(s.date_end) + DAY_MS) return 'Queued for a new fetch; check back later.';
  const arrive = `${ARRIVE[what]} about 35 min after the end.`;
  if (now < Date.parse(s.date_start)) return `Not started yet. ${arrive}`;
  if (s.ingest_state === 'scheduled' || s.ingest_state === 'due') return arrive;
  return none;
}

/**
 * The session query's refetch interval (A§13): every 60 s while its data can still change, that is while it is not
 * cancelled and `scheduled`, `due` or `fetched`; else false. A new `fetch_count` refetches the rest (`useRefetchOnFetch`).
 */
export const pollMs = (s: Pick<Session, 'is_cancelled' | 'ingest_state'>): 60_000 | false =>
  !s.is_cancelled && (s.ingest_state === 'scheduled' || s.ingest_state === 'due' || s.ingest_state === 'fetched')
    ? 60_000
    : false;

const COMPOUNDS = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

/** A known compound in lower case (its class is `cmp-<that>`), or null for null or anything else. */
export const compoundOf = (compound: string | null): string | null =>
  compound !== null && COMPOUNDS.includes(compound) ? compound.toLowerCase() : null;

export type Driver = { number: number; acronym: string; name: string | null; team: string | null };

const HEX = /^[0-9A-Fa-f]{6}$/;

/** `drivers.team_colour` as a CSS colour, or null unless it is six hex digits (D9). */
export const teamColour = (colour: string | null): string | null =>
  colour !== null && HEX.test(colour) ? `#${colour}` : null;

const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * A `#rrggbb` team colour darkened to at least 3:1 on the light `--bg` (#ffffff), for the light theme (A§13).
 * A colour with a WCAG luminance Y ≤ 0.3 already reaches 3:1 and comes back unchanged. Otherwise each linear-light
 * channel is scaled by 0.2999 / Y: scaling linear RGB keeps the ratios between the channels, so the chromaticity and
 * with it the OKLab hue stay the same up to the 8-bit rounding, and only the lightness drops. Flooring each channel
 * keeps Y below 0.3.
 */
export function clampForLight(hex: string): string {
  const lin = linear(hex);
  const [r, g, b] = lin;
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
