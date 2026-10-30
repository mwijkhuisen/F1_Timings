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
 * session-relative `HH:MM:SS.mmm` and then the payload. `{` is JSON, `"` a JSON string, or its text
 * without the outer quotes when it is no valid one (a `.z` payload stays that base64 string, not
 * decoded), anything else the raw text. A line with a bad
 * timestamp or bad JSON is skipped and counted.
 */
export function parseJsonStream(text: string, topic: string, t0Ms: number): { events: FeedEvent[]; skipped: number } {
  const events: FeedEvent[] = [];
  let skipped = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (line === '') continue;
    const rel = duration(line.slice(0, 12));
    const body = line.slice(12);
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
    if (rel === null || body === '' || payload === undefined) skipped++;
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

/**
 * The archive's epoch: the first Heartbeat's `Utc` minus its session-relative time. The Heartbeat
 * events are parsed with t0Ms = 0, so their `t` is that relative time.
 */
export function archiveT0(events: readonly FeedEvent[]): number | undefined {
  for (const ev of events) {
    if (ev.topic !== 'Heartbeat' || !isObj(ev.payload) || typeof ev.payload.Utc !== 'string') continue;
    const utc = Date.parse(ev.payload.Utc);
    if (!Number.isNaN(utc)) return utc - ev.t;
  }
  return undefined;
}
