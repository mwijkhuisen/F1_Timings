import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CarRow,
  type PosRow,
  packCar,
  packPos,
  pick,
  statusCode,
  t6,
  unpackCar,
  unpackPos,
  whole,
} from '../src/telemetry/pack.ts';

// Synthetic samples only (A§12.1 invariant 3): no telemetry fixture exists.

const START = Date.UTC(2027, 0, 1, 12);
const car = (t: number, over: Partial<CarRow> = {}): CarRow => ({
  t,
  rpm: 11_000,
  speed: 301,
  gear: 7,
  throttle: 100,
  brake: 0,
  ...over,
});
const pos = (t: number, over: Partial<PosRow> = {}): PosRow => ({
  t,
  status: 'OnTrack',
  x: -1200,
  y: 3400,
  z: 75,
  ...over,
});
const packedCar = (rows: CarRow[], start = START) => {
  const r = packCar(rows, start);
  if (!r) throw new Error('too_long');
  return r;
};
const packedPos = (rows: PosRow[], start = START) => {
  const r = packPos(rows, start);
  if (!r) throw new Error('too_long');
  return r;
};
const at = (n: number, step = 1) => Array.from({ length: n }, (_, i) => START + i * step);

// Gaps of every kind: jitter, just under, at and over the 65,535 ms skip, and several skips.
const gap = fc.oneof(
  fc.integer({ min: 1, max: 1_500 }),
  fc.constantFrom(65_534, 65_535, 65_536, 131_070, 131_071),
  fc.integer({ min: 65_000, max: 300_000 }),
);
const times = fc.tuple(fc.oneof(fc.constant(0), gap), fc.array(gap, { maxLength: 120 })).map(([first, rest]) => {
  const ts = [START + first];
  for (const g of rest) ts.push((ts.at(-1) ?? 0) + g);
  return ts;
});
const u8 = fc.integer({ min: 0, max: 255 });
const u16 = fc.integer({ min: 0, max: 65_535 });
const i16 = fc.oneof(fc.integer({ min: -32_768, max: 32_767 }), fc.constantFrom(-32_768, 32_767, -30_000, 30_000, 0));
const status = fc.oneof(fc.constantFrom('OnTrack' as const, 'OffTrack' as const), fc.integer({ min: 0, max: 253 }));

describe('packCar / unpackCar (P7b, A§7, T2)', () => {
  it('round trips exactly, one sample per input, over skips and with or without DRS', () => {
    fc.assert(
      fc.property(
        times,
        fc.boolean(),
        fc.array(fc.tuple(u16, u16, u8, u8, u8, u8), { minLength: 121, maxLength: 121 }),
        (ts, drs, values) => {
          const rows = ts.map((t, i) => {
            const [rpm, speed, gear, throttle, brake, d] = values[i] ?? [0, 0, 0, 0, 0, 0];
            return { t, rpm, speed, gear, throttle, brake, ...(drs ? { drs: d } : {}) };
          });
          const { buf, drsPartial } = packedCar(rows);
          expect(drsPartial).toBe(false);
          expect(unpackCar(buf)).toEqual({
            t: rows.map((r) => r.t - START),
            rpm: rows.map((r) => r.rpm),
            speed: rows.map((r) => r.speed),
            gear: rows.map((r) => r.gear),
            throttle: rows.map((r) => r.throttle),
            brake: rows.map((r) => r.brake),
            drs: drs ? rows.map((r) => r.drs) : null,
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a first sample 65,535 ms or more after the start, and 255 as a DRS value', () => {
    for (const first of [65_535, 65_536, 2 * 65_535 + 7]) {
      const { buf } = packedCar([car(START + first, { drs: 255 }), car(START + first + 240, { drs: 255 })]);
      const skips = Math.floor(first / 65_535);
      expect(buf.length).toBe(1 + 10 * (2 + skips));
      expect(unpackCar(buf)).toMatchObject({ t: [first, first + 240], drs: [255, 255] });
    }
  });

  it('DRS only when every sample has it: else none, and drsPartial when some had it', () => {
    const none = packedCar([car(START), car(START + 250)]);
    expect([none.buf.length, none.drsPartial, unpackCar(none.buf).drs]).toEqual([1 + 9 * 2, false, null]);
    const some = packedCar([car(START, { drs: 12 }), car(START + 250)]);
    expect([some.buf.length, some.drsPartial, unpackCar(some.buf).drs]).toEqual([1 + 9 * 2, true, null]);
    const empty = packedCar([]);
    expect([empty.buf.length, empty.drsPartial, unpackCar(empty.buf)]).toEqual([
      1,
      false,
      { t: [], rpm: [], speed: [], gear: [], throttle: [], brake: [], drs: null },
    ]);
  });

  it('a 3 s hole stays empty: no sample is added', () => {
    const { buf } = packedCar([0, 250, 3_250, 3_500].map((dt) => car(START + dt)));
    expect(unpackCar(buf).t).toEqual([0, 250, 3_250, 3_500]);
  });

  it('20,000 records fit, skips included; 20,001 are too_long', () => {
    expect(unpackCar(packedCar(at(20_000).map((t) => car(t))).buf).t).toHaveLength(20_000);
    expect(
      packCar(
        at(20_001).map((t) => car(t)),
        START,
      ),
    ).toBeNull();
    const skip = (n: number) => at(n).map((t, i) => car(i === n - 1 ? t + 65_535 : t));
    expect(unpackCar(packedCar(skip(19_999)).buf).t).toHaveLength(19_999);
    expect(packCar(skip(20_000), START)).toBeNull();
    expect(
      packPos(
        at(20_001).map((t) => pos(t)),
        START,
      ),
    ).toBeNull();
  });

  it('throws on unsorted or repeated times, a time before the start and a value out of range', () => {
    expect(() => packCar([car(START + 10), car(START + 5)], START)).toThrow(RangeError);
    expect(() => packCar([car(START + 10), car(START + 10)], START)).toThrow(RangeError);
    expect(() => packCar([car(START - 1)], START)).toThrow(RangeError);
    expect(() => packCar([car(START, { rpm: 65_536 })], START)).toThrow(RangeError);
    expect(() => packCar([car(START, { gear: 256 })], START)).toThrow(RangeError);
  });

  it('a malformed row throws before anything is built: length, flags, more than 20,000 records', () => {
    for (const buf of [
      Buffer.alloc(0),
      Buffer.from([2]),
      Buffer.from([0x80, ...Buffer.alloc(9)]),
      Buffer.alloc(1 + 9 * 2 + 1),
      Buffer.from([1, ...Buffer.alloc(9)]),
      Buffer.alloc(1 + 9 * 20_001),
      Buffer.from([1, ...Buffer.alloc(10 * 20_001)]),
    ]) {
      expect(() => unpackCar(buf)).toThrow(RangeError);
    }
    for (const buf of [Buffer.alloc(10), Buffer.alloc(8), Buffer.alloc(9 * 20_001)]) {
      expect(() => unpackPos(buf)).toThrow(RangeError);
    }
    expect(unpackPos(Buffer.alloc(9 * 20_000)).t).toHaveLength(20_000);
  });
});

describe('packPos / unpackPos (P7b, A§7, T2)', () => {
  it('round trips exactly over skips, X/Y jumps that wrap int16 and every status kind', () => {
    fc.assert(
      fc.property(
        times,
        fc.array(fc.tuple(i16, i16, i16, status), { minLength: 121, maxLength: 121 }),
        (ts, values) => {
          const rows = ts.map((t, i) => {
            const [x, y, z, s] = values[i] ?? [1, 1, 0, 'OnTrack'];
            return { t, x, y, z, status: s };
          });
          const buf = packedPos(rows);
          expect(buf.length % 9).toBe(0);
          expect(unpackPos(buf)).toEqual({
            t: rows.map((r) => r.t - START),
            x: rows.map((r) => r.x),
            y: rows.map((r) => r.y),
            z: rows.map((r) => r.z),
            status: rows.map((r) => r.status),
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('jumps of ±60,000 and the int16 extremes, also right after a skip', () => {
    const xs = [-30_000, 30_000, -30_000, 32_767, -32_768, 32_767, 0];
    const ys = xs.toReversed();
    const rows = xs.map((x, i) => pos(START + i * 70_000, { x, y: ys[i] ?? 0 }));
    expect(unpackPos(packedPos(rows))).toMatchObject({ x: xs, y: ys });
    expect(() => packPos([pos(START, { x: 32_768 })], START)).toThrow(RangeError);
    expect(() => packPos([pos(START, { y: -32_769 })], START)).toThrow(RangeError);
  });

  it('status bytes: OnTrack 0, OffTrack 1, n + 2 for 0–253; anything else is null and packPos throws', () => {
    expect((['OnTrack', 'OffTrack', 0, 1, 253] as const).map((s) => statusCode(s))).toEqual([0, 1, 2, 3, 255]);
    for (const s of [254, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(statusCode(s)).toBeNull();
      expect(() => packPos([pos(START, { status: s })], START)).toThrow(RangeError);
    }
  });
});

describe('whole (T3)', () => {
  const end = START + 10_000;
  it('runs from start to end with no gap over 1.5 s, both edges included', () => {
    expect(
      whole(
        [1_500, 3_000, 4_500, 6_000, 7_500, 8_500].map((dt) => START + dt),
        START,
        end,
      ),
    ).toBe(true);
    expect(
      whole(
        [1_501, 3_000, 4_500, 6_000, 7_500, 8_500].map((dt) => START + dt),
        START,
        end,
      ),
    ).toBe(false);
    expect(
      whole(
        [1_500, 3_000, 4_500, 6_000, 7_500, 8_499].map((dt) => START + dt),
        START,
        end,
      ),
    ).toBe(false);
    expect(
      whole(
        [1_500, 3_001, 4_500, 6_000, 7_500, 8_500].map((dt) => START + dt),
        START,
        end,
      ),
    ).toBe(false);
    expect(whole([], START, end)).toBe(false);
  });
});

describe('pick (T1)', () => {
  const w = { whole: true, any: true };
  const part = { whole: false, any: true };
  const none = { whole: false, any: false };
  it('a whole recording wins, a whole archive beats a partial recording, else any sample, recording first', () => {
    expect(pick(w, w)).toBe('f1-live');
    expect(pick(w, part)).toBe('f1-live');
    expect(pick(part, w)).toBe('f1-archive');
    expect(pick(part, undefined)).toBe('f1-live');
    expect(pick(undefined, part)).toBe('f1-archive');
    expect(pick(none, w)).toBe('f1-archive');
    expect(pick(part, part)).toBe('f1-live');
    expect(pick(none, none)).toBeNull();
    expect(pick(undefined, undefined)).toBeNull();
  });
});

describe('t6 (T6, D2, D4)', () => {
  const lap = (...s: [number, number, number][]) =>
    s.map(([dt, speed, throttle]) => ({ t: START + dt, speed, throttle }));
  it('top_kph is the highest speed', () => {
    expect(t6(lap([0, 280, 0], [250, 341, 0], [500, 300, 0])).top_kph).toBe(341);
  });
  it('a 2 s gap counts neither way', () => {
    expect(t6(lap([0, 1, 100], [250, 1, 0], [500, 1, 100], [2_500, 1, 0])).full_throttle).toBe(0.5);
    expect(t6(lap([0, 1, 100], [1_500, 1, 0], [1_750, 1, 0])).full_throttle).toBeCloseTo(1_500 / 1_750, 12);
  });
  it('99 and 100 are full, 104 (the sentinel) and 98 never', () => {
    expect(t6(lap([0, 1, 99], [200, 1, 100], [400, 1, 98], [600, 1, 0])).full_throttle).toBeCloseTo(2 / 3, 12);
    expect(t6(lap([0, 1, 104], [200, 1, 104], [400, 1, 104])).full_throttle).toBe(0);
  });
  it('null without samples; a single sample has a top but no share', () => {
    expect(t6([])).toEqual({ top_kph: null, full_throttle: null });
    expect(t6(lap([0, 312, 100]))).toEqual({ top_kph: 312, full_throttle: null });
    expect(t6(lap([0, 312, 100], [1_501, 300, 100]))).toEqual({ top_kph: 312, full_throttle: null });
  });
});
