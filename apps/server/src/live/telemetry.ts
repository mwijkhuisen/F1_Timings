import { inflateRawSync } from 'node:zlib';
import { isObj, utc } from './read.ts';

// The `.z` topics (A§6.2, A§11.3): `decodeZ` turns one payload into JSON within a bound, and `positions` reads a
// decoded Position message. Pure, and they never throw: a failure is a fixed code for the caller to count, never a
// payload. Decoded telemetry is F1 data (A§12.1 invariant 3): no fixture holds any, and nothing here logs.

export type ZFail = 'bad_base64' | 'bad_deflate' | 'too_large' | 'zlib' | 'bad_json';
export type Sample = { status: 'OnTrack' | 'OffTrack' | number; x: number; y: number; z: number };
/** One Position timestamp (epoch ms) with its cars, ids 1–99, in 0.1 m units. */
export type PosEntry = { t: number; cars: [number, Sample][] };

/** About 20 times the largest message seen (11.7 KB, A§6.2): anything bigger is a zip bomb. */
const MAX_INFLATED = 256 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A car is 1–99: the ids 241–243 are not cars (A§6.2), and neither is 0 or a leading zero.
const CAR = /^[1-9]\d?$/;

export const zCounts = (): Record<ZFail, number> => ({
  bad_base64: 0,
  bad_deflate: 0,
  too_large: 0,
  zlib: 0,
  bad_json: 0,
});

/**
 * base64 → raw inflate (at most MAX_INFLATED) → JSON, BOM stripped. A zlib header (RFC 1950: CM 8, CINFO ≤ 7, the
 * check bits) is refused before inflating: every recorded message is raw deflate (A§11.3).
 */
export function decodeZ(payload: unknown): { ok: true; value: unknown } | { ok: false; fail: ZFail } {
  if (typeof payload !== 'string' || payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return { ok: false, fail: 'bad_base64' };
  }
  const buf = Buffer.from(payload, 'base64');
  const [cmf = 0, flg = 0] = buf;
  if ((cmf & 0x0f) === 8 && cmf >> 4 <= 7 && (cmf * 256 + flg) % 31 === 0) return { ok: false, fail: 'zlib' };
  let text: string;
  try {
    text = inflateRawSync(buf, { maxOutputLength: MAX_INFLATED }).toString('utf8');
  } catch (err) {
    const large = err instanceof RangeError || (isObj(err) && err.code === 'ERR_BUFFER_TOO_LARGE');
    return { ok: false, fail: large ? 'too_large' : 'bad_deflate' };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch {
    return { ok: false, fail: 'bad_json' };
  }
}

const int16 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -32_768 && v <= 32_767;
const status = (v: unknown): Sample['status'] | undefined =>
  v === 'OnTrack' || v === 'OffTrack' || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

/**
 * A decoded Position message, `Position[].{Timestamp, Entries.<n>.{Status, X, Y, Z}}` (A§6.2). An entry with a bad
 * Timestamp is skipped; a sample whose id is no car, whose Status is none of OnTrack, OffTrack or a number (2019),
 * whose X, Y or Z is no int16, or at X = Y = 0, is dropped.
 */
export function positions(value: unknown): PosEntry[] {
  if (!isObj(value) || !Array.isArray(value.Position)) return [];
  const out: PosEntry[] = [];
  for (const entry of value.Position) {
    const t = isObj(entry) ? utc(entry.Timestamp) : null;
    if (t === null || !isObj(entry) || !isObj(entry.Entries)) continue;
    const cars: [number, Sample][] = [];
    for (const [id, c] of Object.entries(entry.Entries)) {
      if (!CAR.test(id) || !isObj(c)) continue;
      const s = status(c.Status);
      const { X: x, Y: y, Z: z } = c;
      if (s === undefined || !int16(x) || !int16(y) || !int16(z) || (x === 0 && y === 0)) continue;
      cars.push([Number(id), { status: s, x, y, z }]);
    }
    out.push({ t, cars });
  }
  return out;
}
