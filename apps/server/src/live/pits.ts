import { isoTime, merge, type Obj } from '@f1/contracts';
import { duration, type FeedEvent, isObj } from './read.ts';

// The pit-lane topics (#219, A§11.3, ADR-0006) → one row per (car, lap): the archive, fill and the playback read them
// through this parser. Pure. PitLaneTimeCollection (PLTC) adds each entry once and deletes it 19–64 s later, so only
// the event stream holds its entries; PitStopSeries (PSS) accumulates, so its merged state holds every stop. PitStop
// adds nothing to PSS and is never read. `Lap` is the feed's own lap (OpenF1's lap_number: the in-lap in a race).
// Input is untrusted, as overtakesOf's: an entry with a bad car key, lap or (PSS) Timestamp is dropped and counted.

export type PitRow = {
  driver_number: number;
  lap_number: number;
  /** Epoch ms: the PLTC entry's event time, else the PSS Timestamp. */
  date: number;
  lane_ms: number | null;
  stop_ms: number | null;
};

const DAY_MS = 86_400_000;
/** PLTC entries kept, and rows returned: a race has about 100. The rest is counted in `skipped` (a hostile file's size). */
export const MAX_PIT_ROWS = 5000;
/** A car key of 1 to 3 digits, equal to the entry's RacingNumber when it has one. */
const carOf = (key: string, racing: unknown) =>
  /^\d{1,3}$/.test(key) && (racing === undefined || racing === key) ? Number(key) : null;
const lapOf = (v: unknown) => (typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : null);
/** A duration over 0 and under 24 h (a red-flag entry runs past 1000 s), else null. */
const msOf = (v: unknown) => {
  const ms = duration(v);
  return ms !== null && ms > 0 && ms < DAY_MS ? ms : null;
};
const byCarLap = (a: PitRow, b: PitRow) => a.driver_number - b.driver_number || a.lap_number - b.lap_number;

/**
 * `push` every event in order (any topic; only PLTC and PSS are read), then `rows()`: the union by (car, lap), the lane
 * time PSS `PitLaneTime` (to the ms) over PLTC `Duration` (rounded to 0.1 s), the stationary time PSS `PitStopTime`
 * only, the date the PLTC entry's. A PLTC entry's first sighting wins: a later one (a reconnect's Subscribe state, a
 * replayed line) only fills its missing lane time. `_deleted` is the graphic going away, not the stop undone: ignored.
 * With `sessionKey` the two topics are read only while the stream's merged SessionInfo `Key` is that session's (a feed
 * joined before the session holds the previous one's state until F1 sends a keyframe): the playback and fill. Without
 * it every event is read: the archive holds one session per stream, and its pit lines can come before its SessionInfo.
 */
export function createPits(sessionKey?: number): {
  push(ev: FeedEvent): void;
  rows(): { rows: PitRow[]; skipped: number };
} {
  const lane = new Map<string, PitRow>();
  const series: Obj = Object.create(null);
  const info: Obj = Object.create(null);
  let skipped = 0; // PLTC entries; the PSS ones are counted per rows() call, over its state
  return {
    push(ev) {
      if (sessionKey !== undefined) {
        if (ev.topic === 'SessionInfo') merge(info, ev.payload);
        if (info.Key !== sessionKey) return;
      }
      if (ev.topic === 'PitStopSeries') merge(series, ev.payload);
      if (ev.topic !== 'PitLaneTimeCollection' || !isObj(ev.payload) || !isObj(ev.payload.PitTimes)) return;
      for (const [key, e] of Object.entries(ev.payload.PitTimes)) {
        if (key === '_deleted' || !isObj(e)) continue;
        const [car, lap] = [carOf(key, e.RacingNumber), lapOf(e.Lap)];
        if (car === null || lap === null) {
          skipped++;
          continue;
        }
        const seen = lane.get(`${car}:${lap}`);
        if (seen) seen.lane_ms ??= msOf(e.Duration);
        else if (lane.size >= MAX_PIT_ROWS) skipped++;
        else
          lane.set(`${car}:${lap}`, {
            driver_number: car,
            lap_number: lap,
            date: ev.t,
            lane_ms: msOf(e.Duration),
            stop_ms: null,
          });
      }
    },
    rows() {
      let bad = 0;
      const out = new Map([...lane].map(([k, r]) => [k, { ...r }]));
      const times = isObj(series.PitTimes) ? series.PitTimes : {};
      for (const [key, entries] of Object.entries(times)) {
        for (const e of isObj(entries) ? Object.values(entries) : []) {
          if (!isObj(e)) continue;
          const stop = isObj(e.PitStop) ? e.PitStop : {};
          const [car, lap, at] = [carOf(key, stop.RacingNumber), lapOf(stop.Lap), isoTime(e.Timestamp)];
          if (car === null || lap === null || at === null) {
            bad++;
            continue;
          }
          const seen = out.get(`${car}:${lap}`);
          if (!seen && out.size >= MAX_PIT_ROWS) {
            bad++;
            continue;
          }
          out.set(`${car}:${lap}`, {
            driver_number: car,
            lap_number: lap,
            date: seen?.date ?? at,
            lane_ms: msOf(stop.PitLaneTime) ?? seen?.lane_ms ?? null,
            stop_ms: msOf(stop.PitStopTime),
          });
        }
      }
      return { rows: [...out.values()].sort(byCarLap), skipped: skipped + bad };
    },
  };
}

/**
 * The rows of `events` dated from an hour before `start` (epoch ms) on: a stream can open with the day before's.
 * `sessionKey`: createPits's gate.
 */
export function pitsSince(
  events: Iterable<FeedEvent>,
  start: number,
  sessionKey?: number,
): { rows: PitRow[]; skipped: number } {
  const pits = createPits(sessionKey);
  for (const ev of events) pits.push(ev);
  const { rows, skipped } = pits.rows();
  return { rows: rows.filter((r) => r.date >= start - 3_600_000), skipped };
}
