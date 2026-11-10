// The .jsonStream reader and duration() port FastF1 3.9.0 fastf1/_api.py (fetch_page, parse) and
// fastf1/internals/parsing_helpers.py (to_timedelta):
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

// Feed input → events (A§11.3). Pure: a P2a recording line or an archive .jsonStream file becomes
// FeedEvents; `full` marks a topic's full state from the Subscribe completion.

export type FeedEvent = { t: number /* epoch ms */; topic: string; payload: unknown; full?: true };

/** A plain object: not null, not an array. */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `h:m:s.f`, `m:s.f` or `s.f` (the fraction optional, as in to_timedelta) → integer ms: the fraction
 * is truncated to µs as FastF1 does, then rounded to ms as normalise.ts does. Anything else is null.
 */
export function duration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(?:(?:(\d+):)?(\d+):)?(\d+)(?:\.(\d*))?$/.exec(v);
  if (!m) return null;
  const [, h = '0', min = '0', s, frac = ''] = m;
  const us = ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1e6 + Number(frac.slice(0, 6).padEnd(6, '0'));
  const ms = Math.round(us / 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * An archive `<Topic>.jsonStream`: a UTF-8 BOM, CRLF (or LF) lines, each a 12-character
 * session-relative `HH:MM:SS.mmm` and then the payload. The time is .NET TimeSpan text: past 24 h a
 * day count comes first, `d.HH:MM:SS.mmm` (a stream can open a day before its session; FastF1 reads a
 * fixed 12 characters). `{` is JSON, `"` a JSON string, or its text
 * without the outer quotes when it is no valid one (a `.z` payload stays that base64 string, not
 * decoded), anything else the raw text. A line with a bad
 * timestamp or bad JSON is skipped and counted.
 */
export function parseJsonStream(text: string, topic: string, t0Ms: number): { events: FeedEvent[]; skipped: number } {
  const events: FeedEvent[] = [];
  let skipped = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (line === '') continue;
    const day = /^(\d+)\./.exec(line);
    const at = day ? day[0].length : 0;
    const hms = duration(line.slice(at, at + 12));
    const rel = hms === null ? null : Number(day?.[1] ?? 0) * 86_400_000 + hms;
    const body = line.slice(at + 12);
    let payload: unknown = body;
    if (body.startsWith('{')) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined;
      }
    } else if (body.startsWith('"')) {
      try {
        payload = JSON.parse(body); // starts with ", so a string
      } catch {
        payload = body.replace(/^"+|"+$/g, ''); // FastF1's strip('"')
      }
    }
    if (rel === null || !Number.isSafeInteger(rel) || body === '' || payload === undefined) skipped++;
    else events.push({ t: t0Ms + rel, topic, payload });
  }
  return { events, skipped };
}

/**
 * A P2a `feed.jsonl` line: `[receivedAtMs, topic, payload, f1Timestamp]` is one event at the F1
 * timestamp when it parses, else at receivedAtMs (the native client writes a missing one as
 * "undefined", the library one as null). `[receivedAtMs, "_subscribe", result]` is one `full` event
 * per topic at receivedAtMs, SessionInfo first: the other topics belong to its session, which laps.ts
 * checks before it reads them (F1 sends RaceControlMessages before it). Anything malformed is [].
 */
export function parseFeedLine(line: string): FeedEvent[] {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return [];
  }
  if (!Array.isArray(v) || v.length < 3) return [];
  const [receivedAt, topic, payload, ts] = v;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || typeof topic !== 'string') return [];
  if (topic === '_subscribe') {
    if (!isObj(payload)) return [];
    return Object.entries(payload)
      .sort(([a], [b]) => Number(b === 'SessionInfo') - Number(a === 'SessionInfo'))
      .map(([name, value]) => ({ t: receivedAt, topic: name, payload: value, full: true }));
  }
  const at = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return [{ t: Number.isNaN(at) ? receivedAt : at, topic, payload }];
}

/** A feed `Utc` as UTC, with or without its Z: epoch ms, or null. */
export const utc = (v: unknown): number | null => {
  const at = typeof v === 'string' ? Date.parse(v.endsWith('Z') ? v : `${v}Z`) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};

const values = (v: unknown): unknown[] => (typeof v === 'object' && v !== null ? Object.values(v) : []);

/**
 * The archive's epoch (A§6.2). Each SessionData `Series` and `StatusSeries` entry outside the stream's first line
 * sits at its own `Utc`, which is OpenF1's timebase to the ms; the first line (a list) holds older entries. So t0 is
 * the most frequent `Utc` minus session-relative time over those entries, list and dict forms, when at least 2
 * agree (a tie: the value seen first). Otherwise the first Heartbeat's `Utc` minus its time, which runs about 2 s
 * late. The events are parsed with t0Ms = 0, so their `t` is that relative time.
 */
export function archiveT0(
  heartbeat: readonly FeedEvent[],
  sessionData: readonly FeedEvent[] = [],
): { t0: number; from: 'sessiondata' | 'heartbeat' } | undefined {
  const counts = new Map<number, number>();
  for (const ev of sessionData) {
    if (ev.topic !== 'SessionData' || !isObj(ev.payload)) continue;
    for (const entry of [...values(ev.payload.Series), ...values(ev.payload.StatusSeries)]) {
      const at = isObj(entry) ? utc(entry.Utc) : null;
      if (at !== null) counts.set(at - ev.t, (counts.get(at - ev.t) ?? 0) + 1);
    }
  }
  let best: [number, number] = [0, 1];
  for (const entry of counts) if (entry[1] > best[1]) best = entry;
  if (best[1] >= 2) return { t0: best[0], from: 'sessiondata' };
  for (const ev of heartbeat) {
    const at = ev.topic === 'Heartbeat' && isObj(ev.payload) ? utc(ev.payload.Utc) : null;
    if (at !== null) return { t0: at - ev.t, from: 'heartbeat' };
  }
  return undefined;
}
