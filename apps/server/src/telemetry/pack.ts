import { TELEMETRY_MAX_SAMPLES, type Telemetry } from '@f1/contracts';
import type { CarSample, Sample } from '../live/telemetry.ts';

// One driver-lap's telemetry for a `telemetry_lap` row (P7b, A§7, T2), and the lap's T1, T3 and T6 rules. Pure.
// A row is little-endian columns, one record per sample: dt u16 (the first from the row's date_start, each later one
// from the previous record), then the topic's own columns. A gap of 65,535 ms or more becomes skip records (dt
// 0xFFFF, the rest 0) that carry no sample, so no field overflows and nothing is ever made up (A§2 principle 4).
//   car: a flags byte (bit 0: DRS), then dt u16, rpm u16, speed u16, gear u8, throttle u8, brake u8, [drs u8].
//   pos: dt u16, dx i16, dy i16, z i16, status u8; dx and dy from the previous sample (0 first), wrapped to int16.

/** Samples sorted by t (epoch ms), each t distinct. */
export type CarRow = CarSample & { t: number };
export type PosRow = Sample & { t: number };
/** One source's lap for `pick`: whole (T3, both topics) and whether it holds any sample. */
export type Coverage = { whole: boolean; any: boolean };

const SKIP = 0xffff;
/** T3: a gap over this breaks the line, so the lap is not whole and T6 counts neither side of it. */
const GAP_MS = 1_500;
const FMT = {
  u8: [1, 'writeUInt8', 'readUInt8'],
  u16: [2, 'writeUInt16LE', 'readUInt16LE'],
  i16: [2, 'writeInt16LE', 'readInt16LE'],
} as const;
type Fmt = keyof typeof FMT;
const CAR: Fmt[] = ['u16', 'u16', 'u8', 'u8', 'u8'];
const POS: Fmt[] = ['i16', 'i16', 'i16', 'u8'];

const int16 = (v: number) => (v << 16) >> 16;
const width = (fmts: Fmt[]) => fmts.reduce((sum, f) => sum + FMT[f][0], 2);

/** The records' samples (-1 a skip) and dts, or null past TELEMETRY_MAX_SAMPLES records (`too_long`). */
function records(rows: { t: number }[], start: number): { at: number[]; dt: number[] } | null {
  const at: number[] = [];
  const dt: number[] = [];
  let prev = start;
  for (const [i, { t }] of rows.entries()) {
    if (!Number.isSafeInteger(t) || t < prev || (i > 0 && t === prev)) throw new RangeError('rows not sorted by t');
    const skips = Math.floor((t - prev) / SKIP);
    if (at.length + skips + 1 > TELEMETRY_MAX_SAMPLES) return null;
    for (let k = 0; k < skips; k++) {
      at.push(-1);
      dt.push(SKIP);
    }
    at.push(i);
    dt.push((t - prev) % SKIP);
    prev = t;
  }
  return { at, dt };
}

/** `head` bytes, the dt column, then one column per `cols` entry (one value per row; a skip writes 0). */
function pack(rows: { t: number }[], start: number, head: number[], cols: [Fmt, number[]][]): Buffer | null {
  const recs = records(rows, start);
  if (!recs) return null;
  const n = recs.at.length;
  const buf = Buffer.alloc(head.length + n * width(cols.map(([f]) => f)));
  buf.set(head);
  let off = head.length;
  for (const [k, dt] of recs.dt.entries()) buf.writeUInt16LE(dt, off + 2 * k);
  off += 2 * n;
  for (const [fmt, values] of cols) {
    const [size, write] = FMT[fmt];
    for (const [k, i] of recs.at.entries()) {
      const v = values[i];
      if (v !== undefined) buf[write](v, off + size * k); // range-checked: a bad value throws
    }
    off += size * n;
  }
  return buf;
}

/** Each column's values, one per sample, with t in ms from the row's date_start. Throws on a malformed row. */
function unpack(buf: Buffer, head: number, fmts: Fmt[]): { t: number[]; cols: number[][] } {
  const w = width(fmts);
  const n = (buf.length - head) / w;
  if (!Number.isInteger(n) || n < 0 || n > TELEMETRY_MAX_SAMPLES) throw new RangeError('bad telemetry row');
  const t: number[] = [];
  const cols = fmts.map((): number[] => []);
  let at = 0;
  for (let k = 0; k < n; k++) {
    const dt = buf.readUInt16LE(head + 2 * k);
    at += dt;
    if (dt === SKIP) continue;
    t.push(at);
    let off = head + 2 * n;
    for (const [j, fmt] of fmts.entries()) {
      const [size, , read] = FMT[fmt];
      cols[j]?.push(buf[read](off + size * k));
      off += size * n;
    }
  }
  return { t, cols };
}

/**
 * A lap's CarData row, or null past TELEMETRY_MAX_SAMPLES records (`too_long`). DRS is kept only when every sample
 * has it; when only some do, the row has none and `drsPartial` is set (`drs_partial`). Throws on unsorted rows.
 */
export function packCar(rows: CarRow[], start: number): { buf: Buffer; drsPartial: boolean } | null {
  const withDrs = rows.filter((r) => r.drs !== undefined).length;
  const drs = withDrs > 0 && withDrs === rows.length;
  const cols: [Fmt, number[]][] = [
    ['u16', rows.map((r) => r.rpm)],
    ['u16', rows.map((r) => r.speed)],
    ['u8', rows.map((r) => r.gear)],
    ['u8', rows.map((r) => r.throttle)],
    ['u8', rows.map((r) => r.brake)],
  ];
  if (drs) cols.push(['u8', rows.map((r) => r.drs ?? 0)]);
  const buf = pack(rows, start, [drs ? 1 : 0], cols);
  return buf && { buf, drsPartial: withDrs > 0 && !drs };
}

/** A Position status as its byte: 0 OnTrack, 1 OffTrack, 2 + n for an integer n of 0–253 (2019), else null. */
export const statusCode = (s: Sample['status']): number | null =>
  s === 'OnTrack' ? 0 : s === 'OffTrack' ? 1 : Number.isInteger(s) && s >= 0 && s <= 253 ? s + 2 : null;

/**
 * A lap's Position row, or null past TELEMETRY_MAX_SAMPLES records (`too_long`). The caller drops a sample whose
 * `statusCode` is null first (`bad_status`), so `whole` sees only what is stored: one here throws, as unsorted rows.
 */
export function packPos(rows: PosRow[], start: number): Buffer | null {
  const delta = (v: number[]) =>
    v.map((x, i) => {
      if (int16(x) !== x) throw new RangeError('not int16'); // the wrap below would hide it
      return int16(x - (v[i - 1] ?? 0));
    });
  const status = rows.map((r) => {
    const code = statusCode(r.status);
    if (code === null) throw new RangeError('bad status');
    return code;
  });
  return pack(
    rows,
    start,
    [],
    [
      ['i16', delta(rows.map((r) => r.x))],
      ['i16', delta(rows.map((r) => r.y))],
      ['i16', rows.map((r) => r.z)],
      ['u8', status],
    ],
  );
}

/** A stored CarData row. Throws on a bad flags byte, a length that fits no record count, or too many records. */
export function unpackCar(buf: Buffer): Telemetry['car'] {
  const flags = buf[0];
  if (flags !== 0 && flags !== 1) throw new RangeError('bad telemetry row');
  const { t, cols } = unpack(buf, 1, flags ? [...CAR, 'u8'] : CAR);
  const [rpm = [], speed = [], gear = [], throttle = [], brake = [], drs] = cols;
  return { t, rpm, speed, gear, throttle, brake, drs: drs ?? null };
}

/** A stored Position row, X and Y back from their deltas. Throws as unpackCar. */
export function unpackPos(buf: Buffer): Telemetry['pos'] {
  const { t, cols } = unpack(buf, 0, POS);
  const [dx = [], dy = [], z = [], codes = []] = cols;
  const sum = (d: number[]) => {
    let prev = 0;
    return d.map((v) => {
      prev = int16(prev + v);
      return prev;
    });
  };
  const status = codes.map((c) => (c === 0 ? 'OnTrack' : c === 1 ? 'OffTrack' : c - 2));
  return { t, x: sum(dx), y: sum(dy), z, status };
}

/** T3: sorted times run from `start` to `end` with no gap over 1.5 s, both edges included. */
export function whole(times: number[], start: number, end: number): boolean {
  if (times.length === 0) return false;
  let prev = start;
  for (const t of times) {
    if (t - prev > GAP_MS) return false;
    prev = t;
  }
  return end - prev <= GAP_MS;
}

/**
 * T1: the recording's lap if whole, else the archive's if whole, else the recording's if it has any sample, else the
 * archive's if it has any; null for no row. So a truncated archive never replaces a whole recording lap.
 */
export function pick(live: Coverage | undefined, archive: Coverage | undefined): Telemetry['source'] | null {
  if (live?.whole) return 'f1-live';
  if (archive?.whole) return 'f1-archive';
  if (live?.any) return 'f1-live';
  if (archive?.any) return 'f1-archive';
  return null;
}

/**
 * T6 over the samples present (D2): the top speed, and the share of time at full throttle (99 or 100; 104 is a
 * sentinel, D4) over the consecutive pairs at most 1.5 s apart, each pair weighed by its dt and counted by its left
 * sample. A gap counts neither way. Null without samples, and the share null without such a pair.
 */
export function t6(car: { t: number; speed: number; throttle: number }[]): {
  top_kph: number | null;
  full_throttle: number | null;
} {
  let top: number | null = null;
  let full = 0;
  let all = 0;
  for (const [i, s] of car.entries()) {
    top = Math.max(top ?? 0, s.speed);
    const dt = (car[i + 1]?.t ?? Number.POSITIVE_INFINITY) - s.t;
    if (dt > GAP_MS) continue;
    all += dt;
    if (s.throttle === 99 || s.throttle === 100) full += dt;
  }
  return { top_kph: top, full_throttle: all > 0 ? full / all : null };
}
