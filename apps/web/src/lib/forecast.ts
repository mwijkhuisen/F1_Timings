import type { Forecast } from '@f1/contracts';
import { fmtHm, fmtInstant } from './time.ts';
import { fmtRange, type Range } from './weather.ts';

// The weekend forecast's numbers (#120, A§13), pure. A row is dated by the END of the hour it covers (Open-Meteo), so a
// session starting at 14:30 begins in the row dated 15:00 and one ending at 15:30 ends in the row dated 16:00.

type Data = NonNullable<Forecast>;
export type Hour = Data['hours'][number];
type Span = { date_start: string; date_end: string; is_cancelled: boolean };

const HOUR = 3_600_000;
const floorHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const ceilHour = (ms: number) => Math.ceil(ms / HOUR) * HOUR;

/** A session that shows a forecast: not cancelled and not started. */
export const upcoming = (s: Span, now: number): boolean => !s.is_cancelled && now < Date.parse(s.date_start);

/** The rows in (floorHour(start), ceilHour(end)]. */
export const sessionHours = (hours: readonly Hour[], s: Span): Hour[] => {
  const [from, to] = [floorHour(Date.parse(s.date_start)), ceilHour(Date.parse(s.date_end))];
  return hours.filter((h) => Date.parse(h.date) > from && Date.parse(h.date) <= to);
};

/** The row of the hour the session starts in, or null. */
export const startRow = (hours: readonly Hour[], s: Span): Hour | null =>
  hours.find((h) => Date.parse(h.date) === floorHour(Date.parse(s.date_start)) + HOUR) ?? null;

/** "rain 40 %, 18 °C": whole numbers, a null part dropped, null when both are. */
export function startWords(row: Hour | null): string | null {
  const parts = [
    row?.precipitation_probability != null && `rain ${row.precipitation_probability} %`,
    row?.temperature_2m != null && `${Math.round(row.temperature_2m)} °C`,
  ].filter((p): p is string => p !== false);
  return parts.length === 0 ? null : parts.join(', ');
}

const known = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

/** Over a session's rows: the highest chance (%), the rain total (mm, 1 decimal), the air range and the highest wind (m/s). */
export function summary(rows: readonly Hour[]) {
  const chance = known(rows.map((r) => r.precipitation_probability));
  const mm = known(rows.map((r) => r.precipitation));
  const air = known(rows.map((r) => r.temperature_2m));
  const wind = known(rows.map((r) => r.wind_speed_10m));
  const range: Range | null = air.length === 0 ? null : { min: Math.min(...air), max: Math.max(...air) };
  return {
    chance: chance.length === 0 ? null : `${Math.max(...chance)} %`,
    rain: mm.length === 0 ? null : `${mm.reduce((a, b) => a + b, 0).toFixed(1)} mm`,
    air: range && `${fmtRange(range, 0)} °C`,
    wind: wind.length === 0 ? null : `${Math.max(...wind).toFixed(1)} m/s`,
  };
}

const day = (ms: number) => fmtInstant(new Date(ms).toISOString()).split(',')[0];

/** "updated 15:30", or "updated Fri 6 Nov 2026, 15:30" when `fetched_at` is on another Amsterdam day than `now`. */
export const updatedWords = (fetchedAt: string, now: number): string => {
  const at = Date.parse(fetchedAt);
  return `updated ${day(at) === day(now) ? fmtHm(at) : fmtInstant(fetchedAt)}`;
};
