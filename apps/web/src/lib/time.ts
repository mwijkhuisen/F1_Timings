// Every time on screen goes through here: Europe/Amsterdam through Intl, no
// Temporal (owner, 2026-10-28). Durations are integer ms from the API.

const instant = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An ISO-8601 instant as Amsterdam wall time, such as "Fri 2 Oct 2026, 14:00". */
export const fmtInstant = (iso: string): string => instant.format(new Date(iso)).replace(/^(\w+),/, '$1');

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** A lap time as `m:ss.SSS`. */
export const fmtLap = (ms: number): string =>
  `${Math.floor(ms / 60_000)}:${pad(Math.floor((ms % 60_000) / 1000), 2)}.${pad(ms % 1000, 3)}`;

/** A sector time as `ss.SSS`, or `m:ss.SSS` from 60 s up. */
export const fmtSector = (ms: number): string =>
  ms < 60_000 ? `${pad(Math.floor(ms / 1000), 2)}.${pad(ms % 1000, 3)}` : fmtLap(ms);
