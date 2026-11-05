// The per-driver TimingData and TimingAppData processing follows FastF1 3.9.0 fastf1/_api.py
// (_laps_data_driver, timing_app_data), with lap times through duration() (read.ts):
//
// MIT License
//
// Copyright (c) 2026 Philipp Schäfer
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { Insertable } from 'kysely';
import type { DB } from '../db/db.ts';
import { markPitIn } from '../ingest/normalise.ts';
import type { Obj } from './merge.ts';
import { duration, type FeedEvent, isObj } from './read.ts';

// Feed deltas → the lap and stint rows OpenF1 builds (A§11.3). Pure and incremental: push() takes each event with
// the delta createFeed().apply returned for it, rows() returns the rows so far.
//
// FastF1 is the base. Where it disagrees with OpenF1, OpenF1's behaviour wins (owner decision D3): OpenF1 is the
// oracle and the v1 source. Those rules come from br-g/openf1 (laps.py, stints.py), which is CC BY-NC-SA 4.0 and was
// read for behaviour only, never copied; A§11.3 states each rule with its origin.
//
// A lap's row is its copy as of the last time OpenF1 emits it: after each driver line of a TimingData message, for
// the laps with a changed value. So a value written in place later (a segment) or set directly (race lap 1) shows
// only once the lap changes again, and a race lap that starts after the chequered flag never shows. A stint shows
// from its first changed value, with its current values.

const WINDOW_MS = 10_000;
// A time over a day is no time, so sums and differences stay inside the int columns.
const MAX_MS = 86_400_000;

type Field = 'lap' | 's1' | 's2' | 's3';
type Times = Record<Field, number | null>;
// Every column given.
type Full<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
/** A lap row, plus the epoch ms at which each time was set (progressiveColours); strip `at` before an insert. */
export type LapRow = Full<Insertable<DB['lap']>> & { at: Times };
export type StintRow = Full<Insertable<DB['stint']>>;

type Segments = (number | null)[] | null;
type Lap = {
  driver_number: number;
  lap_number: number;
  date_start: number | null;
  lap_ms: number | null;
  s1_ms: number | null;
  s2_ms: number | null;
  s3_ms: number | null;
  i1_kph: number | null;
  i2_kph: number | null;
  st_kph: number | null;
  is_pit_out: boolean;
  seg1: Segments;
  seg2: Segments;
  seg3: Segments;
  at: Times;
};
type Value = Exclude<keyof Lap, 'driver_number' | 'lap_number' | 'at'>;
type Stint = StintRow & { lap_start: number; lap_end: number };

const TIMED: Partial<Record<Value, Field>> = { lap_ms: 'lap', s1_ms: 's1', s2_ms: 's2', s3_ms: 's3' };
const SECTORS = [
  ['s1_ms', 'seg1'],
  ['s2_ms', 'seg2'],
  ['s3_ms', 'seg3'],
] as const;

const items = (v: unknown): unknown[] => (typeof v === 'object' && v !== null ? Object.values(v) : []);
// Python truthiness, which OpenF1's checks use: an empty list, object or string, 0 and null are false.
const truthy = (v: unknown) => (typeof v === 'object' && v !== null ? Object.keys(v).length > 0 : Boolean(v));
// A non-negative integer key below max ("0", "44"), else null.
const index = (key: string, max: number) => (/^\d+$/.test(key) && Number(key) < max ? Number(key) : null);
const int16 = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 32_767 ? v : null);
// int() of a digit string or an integer.
const integer = (v: unknown) => int16(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
const fit = (ms: number | null) => (ms !== null && Math.abs(ms) <= MAX_MS ? ms : null);
// Epoch ms in the years 1970 to 9999 (the plain ISO form) as ISO, else null: a bad feed time is no start.
const iso = (ms: number | null) =>
  ms !== null && ms >= 0 && ms < 253_402_300_800_000 ? new Date(ms).toISOString() : null;
// OpenF1 reads a sector with float(): plain seconds only, so "1:05.123" is no value.
const seconds = (v: unknown) => (typeof v === 'string' && /^\d+(\.\d*)?$/.test(v) ? fit(duration(v)) : null);
const text = (v: unknown) => (typeof v === 'string' && !v.includes('\0') ? v : null);
// A feed Utc as UTC, with or without its Z.
const utc = (v: unknown) => {
  const at = typeof v === 'string' ? Date.parse(v.endsWith('Z') ? v : `${v}Z`) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};

const newLap = (driver: number, n: number): Lap => ({
  driver_number: driver,
  lap_number: n,
  date_start: null,
  lap_ms: null,
  s1_ms: null,
  s2_ms: null,
  s3_ms: null,
  i1_kph: null,
  i2_kph: null,
  st_kph: null,
  is_pit_out: false,
  seg1: null,
  seg2: null,
  seg3: null,
  at: { lap: null, s1: null, s2: null, s3: null },
});

export function createLaps(
  sessionKey: number,
  source: 'f1-live' | 'f1-archive',
): { push(ev: FeedEvent, delta: unknown): void; rows(): { laps: LapRow[]; stints: StintRow[] } } {
  let ours = false;
  let race = false;
  let open = false;
  let chequered: number | null = null;
  const laps = new Map<number, Lap[]>();
  const marked = new Set<Lap>();
  const shown = new Map<Lap, LapRow>();
  const stints = new Map<number, Map<number, Stint>>();
  const lapAt = new Map<Stint, number>(); // the time of the driver's last NumberOfLaps, on the last stint
  const shownStints = new Set<Stint>();

  const row = ({ date_start, seg1, seg2, seg3, at, ...lap }: Lap): LapRow => ({
    session_key: sessionKey,
    source,
    ...lap,
    date_start: iso(date_start),
    // PostgreSQL arrays keep null elements; kysely-codegen types them as number[] (as in normalise.ts).
    seg1: seg1 && ([...seg1] as number[]),
    seg2: seg2 && ([...seg2] as number[]),
    seg3: seg3 && ([...seg3] as number[]),
    is_pit_in: false,
    deleted: false,
    deleted_reason: null,
    quali_phase: null,
    at: { ...at },
  });

  // The last lap in the driver's list; a driver seen for the first time gets lap 1 (OpenF1).
  function current(driver: number): Lap {
    const list = laps.get(driver);
    if (list) return list.at(-1) as Lap;
    const first = newLap(driver, 1);
    laps.set(driver, [first]);
    return first;
  }

  // An end-of-lap value (the lap time, S2, S3 and their segments) that comes less than 10 s after the current lap
  // started belongs to the lap before, and is dropped when there is none (OpenF1). FastF1's 5 s window is not used.
  function ending(driver: number, t: number): Lap | undefined {
    const lap = current(driver);
    if (lap.date_start === null || t - lap.date_start >= WINDOW_MS) return lap;
    return laps.get(driver)?.at(-2);
  }

  // A changed value marks the lap for the next emission, unless it is a race lap that started after the chequered
  // flag. A new sector time fills a missing lap time with the sector sum (OpenF1; FastF1's checks on it are not used).
  function set<K extends Value>(lap: Lap, key: K, value: Lap[K], t: number) {
    if (lap[key] === value) return;
    lap[key] = value;
    const field = TIMED[key];
    if (field) lap.at[field] = t;
    if (field && field !== 'lap' && !lap.lap_ms && lap.s1_ms && lap.s2_ms && lap.s3_ms) {
      lap.lap_ms = lap.s1_ms + lap.s2_ms + lap.s3_ms;
      lap.at.lap = t;
    }
    if (race && chequered !== null && lap.date_start !== null && chequered < lap.date_start) return;
    marked.add(lap);
  }

  // A segment status (OpenF1): the first of a sector on a lap creates the list (holes are null) and counts as a
  // change; later ones are written in place, which OpenF1 does not count.
  function segment(lap: Lap, key: 'seg1' | 'seg2' | 'seg3', i: number, status: number | null, t: number) {
    const list = lap[key] ?? [];
    while (list.length <= i) list.push(null);
    list[i] = status;
    if (lap[key] === null) set(lap, key, list, t);
  }

  // Race lap 1 when lap 2 starts (OpenF1): a missing time is lap 2's start minus lap 1's, then a missing S1 is the
  // lap minus S2 and S3. Both are set directly, without marking lap 1, and only when positive.
  function firstLap(driver: number, t: number) {
    const first = laps.get(driver)?.[0];
    if (first?.lap_number !== 1) return;
    const ms = first.date_start === null ? null : fit(t - first.date_start);
    if (!first.lap_ms && ms !== null && ms > 0) {
      first.lap_ms = ms;
      first.at.lap = t;
    }
    if (first.lap_ms && !first.s1_ms && first.s2_ms && first.s3_ms && first.lap_ms > first.s2_ms + first.s3_ms) {
      first.s1_ms = first.lap_ms - first.s2_ms - first.s3_ms;
      first.at.s1 = t;
    }
  }

  // One driver line of TimingData, in OpenF1's order: LastLapTime, Sectors, Speeds, NumberOfLaps, PitOut.
  function timing(driver: number, line: Obj, t: number) {
    const last = isObj(line.LastLapTime) ? line.LastLapTime.Value : undefined;
    if (typeof last === 'string') {
      const ms = fit(duration(last));
      const lap = ms === null ? undefined : ending(driver, t);
      if (lap) set(lap, 'lap_ms', ms, t);
    }
    // Sectors and segments only as an object: the list form carries no values (FastF1, OpenF1).
    for (const [key, sector] of Object.entries(isObj(line.Sectors) ? line.Sectors : {})) {
      const i = index(key, 3) as 0 | 1 | 2 | null;
      if (i === null || !isObj(sector)) continue;
      const [time, segs] = SECTORS[i];
      const target = () => (i === 0 ? current(driver) : ending(driver, t));
      const ms = seconds(sector.Value);
      const lap = ms === null ? undefined : target();
      if (lap) set(lap, time, ms, t);
      for (const [k, seg] of Object.entries(isObj(sector.Segments) ? sector.Segments : {})) {
        const j = index(k, 64); // a sector has about ten
        if (j === null || !isObj(seg)) continue;
        const into = target();
        if (into) segment(into, segs, j, int16(seg.Status), t);
      }
    }
    // Speed traps go to the current lap; FL is not stored (OpenF1).
    for (const [label, trap] of Object.entries(isObj(line.Speeds) ? line.Speeds : {})) {
      const key = label === 'I1' ? 'i1_kph' : label === 'I2' ? 'i2_kph' : label === 'ST' ? 'st_kph' : null;
      const kph = key && isObj(trap) ? integer(trap.Value) : null;
      if (key && kph !== null) set(current(driver), key, kph, t);
    }
    if (line.NumberOfLaps !== undefined && line.NumberOfLaps !== null) {
      // A count that is no integer skips the rest of the line, its emission included (OpenF1).
      const count = int16(line.NumberOfLaps);
      if (count === null) return;
      // A higher number starts a new lap, without filling gaps; a race counts one lower, as its start crosses no
      // line. A lap starts at the first count it sees (OpenF1; FastF1's own counter is not used).
      const n = int16(count + (race ? 1 : 0)); // the +1 can leave smallint: skipped the same way
      if (n === null) return;
      let lap = current(driver);
      if (n > lap.lap_number) {
        lap = newLap(driver, n);
        laps.get(driver)?.push(lap);
      }
      if (lap.date_start === null) {
        set(lap, 'date_start', t, t);
        if (race && lap.lap_number === 2) firstLap(driver, t);
      }
    }
    // Any PitOut but null marks the current lap as an out-lap, false included (OpenF1; FastF1 ignores PitOut).
    if (line.PitOut !== undefined && line.PitOut !== null) set(current(driver), 'is_pit_out', true, t);
    for (const lap of marked) shown.set(lap, row(lap));
    marked.clear();
  }

  function stintsOf(driver: number) {
    const own = stints.get(driver) ?? new Map<number, Stint>();
    stints.set(driver, own);
    return own;
  }
  const lastStint = (own: Map<number, Stint>) => own.get(Math.max(...own.keys()));
  function change<K extends keyof Stint>(stint: Stint, key: K, value: Stint[K]) {
    if (stint[key] === value) return;
    stint[key] = value;
    shownStints.add(stint);
  }

  // A new stint starts after the last stint's end (lap 1 for the first). When it comes less than 10 s after the
  // driver's last NumberOfLaps, that lap is the new stint's: the last stint ends one lap earlier (OpenF1).
  function addStint(own: Map<number, Stint>, driver: number, n: number, t: number): Stint {
    const last = lastStint(own);
    const at = last && lapAt.get(last);
    if (last && at !== undefined && t - at < WINDOW_MS) change(last, 'lap_end', last.lap_end - 1);
    const start = last ? Math.min(last.lap_end + 1, 32_767) : 1; // smallint
    const stint: Stint = {
      session_key: sessionKey,
      source,
      driver_number: driver,
      stint_number: n,
      lap_start: start,
      lap_end: start,
      compound: null,
      tyre_age_at_start: null,
    };
    own.set(n, stint);
    return stint;
  }

  // TimingAppData stints (OpenF1): the key + 1 is the stint number, in key order as text; a list (the feed's form at
  // the start of a session) all goes to stint 1, where FastF1 numbers it by position. The compound when given;
  // tyre_age_at_start takes every StartLaps but null, the latest winning, and TotalLaps only while it is still null.
  function tyres(driver: number, list: unknown, t: number) {
    if (!truthy(list) || typeof list !== 'object' || list === null) return;
    const entries = Array.isArray(list)
      ? list.map((s): [string, unknown] => ['0', s])
      : Object.entries(list).sort(([a], [b]) => (a < b ? -1 : 1));
    const own = stintsOf(driver);
    for (const [key, s] of entries) {
      const i = index(key, 32_767);
      if (i === null) continue;
      const stint = own.get(i + 1) ?? addStint(own, driver, i + 1, t);
      if (!isObj(s)) continue;
      if (Object.hasOwn(s, 'Compound')) change(stint, 'compound', text(s.Compound));
      if (s.StartLaps !== undefined && s.StartLaps !== null) change(stint, 'tyre_age_at_start', int16(s.StartLaps));
      else if (Object.hasOwn(s, 'TotalLaps') && stint.tyre_age_at_start === null) {
        change(stint, 'tyre_age_at_start', int16(s.TotalLaps));
      }
    }
  }

  // TimingData for stints (OpenF1, ungated): a driver's first line creates stint 1, and NumberOfLaps is the last
  // stint's lap_end, raw (no race +1), with its time kept for the 10 s rule.
  function stintLaps(driver: number, line: Obj, t: number) {
    const own = stintsOf(driver);
    const last = lastStint(own) ?? addStint(own, driver, 1, t);
    if (!Object.hasOwn(line, 'NumberOfLaps')) return;
    const count = int16(line.NumberOfLaps);
    if (count !== null) change(last, 'lap_end', count);
    lapAt.set(last, t);
    shownStints.add(last);
  }

  return {
    push(ev, delta) {
      if (!isObj(delta)) return;
      const { t } = ev;
      // Only the session's own events count: from a SessionInfo with its Key to one with another Key. A feed joined
      // before the session holds the previous session's full state until F1 switches with a SessionInfo keyframe.
      if (ev.topic === 'SessionInfo' && typeof delta.Key === 'number') ours = delta.Key === sessionKey;
      if (!ours) return;
      if (ev.topic === 'SessionInfo') {
        // A race is a session of Type "Race", sprints included (OpenF1).
        if (typeof delta.Type === 'string') race = delta.Type.toLowerCase() === 'race';
      } else if (ev.topic === 'SessionData' && race) {
        // A "Started" status gives every driver whose only lap is lap 1 its start, at the status's Utc (OpenF1).
        for (const status of items(delta.StatusSeries)) {
          const at = isObj(status) && status.SessionStatus === 'Started' ? utc(status.Utc) : null;
          if (at === null) continue;
          for (const [first, ...more] of laps.values()) {
            if (!first || more.length > 0 || first.lap_number !== 1) continue;
            first.date_start = at;
            marked.add(first);
          }
        }
      } else if (ev.topic === 'RaceControlMessages') {
        // The chequered flag is the time of the event that carries the text "CHEQUERED FLAG"; the last wins (OpenF1).
        for (const m of items(delta.Messages)) {
          if (isObj(m) && typeof m.Message === 'string' && m.Message.toUpperCase() === 'CHEQUERED FLAG') chequered = t;
        }
      } else if ((ev.topic === 'TimingData' || ev.topic === 'TimingAppData') && isObj(delta.Lines)) {
        for (const [key, line] of Object.entries(delta.Lines)) {
          if (!isObj(line)) continue;
          // Laps ignore TimingData until a TimingAppData line has stints (OpenF1).
          if (ev.topic === 'TimingAppData' && truthy(line.Stints)) open = true;
          const driver = index(key, 32_768);
          if (driver === null) continue;
          if (ev.topic === 'TimingAppData') tyres(driver, line.Stints, t);
          else {
            stintLaps(driver, line, t);
            if (open) timing(driver, line, t);
          }
        }
      }
    },
    rows() {
      return {
        laps: markPitIn(structuredClone([...shown.values()])).sort(
          (a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number,
        ),
        stints: [...shownStints]
          .map((s) => ({ ...s }))
          .sort((a, b) => a.driver_number - b.driver_number || a.stint_number - b.stint_number),
      };
    },
  };
}
