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

/** A time difference as signed seconds: `+0.123`, `−0.045` (a minus sign, not a hyphen), `+0.000`. */
export const fmtDelta = (ms: number): string => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}`;

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Epoch ms as Amsterdam wall-clock time, `HH:mm:ss`. */
export const fmtClock = (ms: number): string => clock.format(ms);

const weekday = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' });
const utcDay = weekday('UTC');
const amsterdamDay = weekday('Europe/Amsterdam');
const OFFSET = /^(-?)(\d{2}):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * An instant as wall time at the track, "HH:mm", from the meeting's `gmt_offset` (OpenF1's `[-]HH:MM:SS`, no `+`),
 * with the track's weekday first when it differs from Amsterdam's ("Sat 22:00"); null without a valid offset.
 * ponytail: one offset per meeting, so a DST change at the track mid-weekend shows the later sessions an hour off;
 * store each session's own gmt_offset if that matters.
 */
export function fmtTrack(iso: string, gmtOffset: string | null): string | null {
  const m = OFFSET.exec(gmtOffset ?? '');
  if (!m || Number(m[2]) > 14) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const at = Date.parse(iso);
  const track = new Date(at + sign * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000);
  const hm = `${pad(track.getUTCHours(), 2)}:${pad(track.getUTCMinutes(), 2)}`;
  const day = utcDay.format(track);
  return day === amsterdamDay.format(at) ? hm : `${day} ${hm}`;
}

/** Time left, minutes rounded up: "now", "M min", "H h M min" under 48 h, then "D days H h". */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}
