import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeZ, positions, type ZFail, zCounts } from '../src/live/telemetry.ts';

// Every payload is built here from synthetic JSON (A§12.1 invariant 3): the bomb too, so no `.z` fixture exists.

const z = (text: string | Buffer) => deflateRawSync(text).toString('base64');
const json = (v: unknown) => z(JSON.stringify(v));
const message = { Position: [{ Timestamp: '2027-01-01T12:00:00.25Z', Entries: { '1': { Status: 'OnTrack' } } }] };
const sample = (over: Record<string, unknown> = {}) => ({ Status: 'OnTrack', X: -1200, Y: 3400, Z: 75, ...over });
const one = (entries: Record<string, unknown>, ...ts: unknown[]) =>
  positions({ Position: [{ Timestamp: ts.length > 0 ? ts[0] : '2027-01-01T12:00:00.250Z', Entries: entries }] });

describe('decodeZ (P7a, A§11.3)', () => {
  it('decodes raw deflate JSON, with or without a BOM', () => {
    expect(decodeZ(json(message))).toEqual({ ok: true, value: message });
    expect(decodeZ(z(`﻿${JSON.stringify(message)}`))).toEqual({ ok: true, value: message });
  });

  it('a zip bomb is too_large: 4 MiB of zeros in about 4 KB', () => {
    const bomb = z(Buffer.alloc(4 * 2 ** 20));
    expect(bomb.length).toBeLessThan(8_000);
    expect(decodeZ(bomb)).toEqual({ ok: false, fail: 'too_large' });
  });

  it('junk is bad_base64: a bad character, a length that is no multiple of 4, an empty or a non-string', () => {
    for (const junk of ['!!!!', 'QUJD=', 'QUJ', '', 42, null, undefined, { a: 1 }, ['QUJD']]) {
      expect(decodeZ(junk)).toEqual({ ok: false, fail: 'bad_base64' });
    }
  });

  it('a zlib wrapper is zlib, a truncated or garbled stream bad_deflate, text that is no JSON bad_json', () => {
    expect(decodeZ(deflateSync(JSON.stringify(message)).toString('base64'))).toEqual({ ok: false, fail: 'zlib' });
    const good = deflateRawSync(JSON.stringify(message));
    expect(decodeZ(good.subarray(0, 6).toString('base64'))).toEqual({ ok: false, fail: 'bad_deflate' });
    expect(decodeZ(Buffer.from([0xff, 0xff, 0xff]).toString('base64'))).toEqual({ ok: false, fail: 'bad_deflate' });
    expect(decodeZ(z('{"Position":'))).toEqual({ ok: false, fail: 'bad_json' });
    expect(decodeZ(z(''))).toEqual({ ok: false, fail: 'bad_json' });
  });

  it('a scan counts each failure once, keeps both good messages and never throws', () => {
    const second = { Position: [] };
    const scan = [
      json(message),
      z(Buffer.alloc(4 * 2 ** 20)),
      '!!!',
      deflateSync('{}').toString('base64'),
      z('not json'),
      Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString('base64'),
      json(second),
    ];
    const counts = zCounts();
    const good: unknown[] = [];
    for (const payload of scan) {
      const r = decodeZ(payload);
      if (r.ok) good.push(r.value);
      else counts[r.fail]++;
    }
    expect(good).toEqual([message, second]);
    expect(counts).toEqual({ bad_base64: 1, bad_deflate: 1, too_large: 1, zlib: 1, bad_json: 1 } satisfies Record<
      ZFail,
      number
    >);
  });
});

describe('positions (P7a, A§6.2)', () => {
  it('reads each entry at its Timestamp, its cars in 0.1 m units', () => {
    const t = Date.parse('2027-01-01T12:00:00.250Z');
    expect(
      positions({
        Position: [
          { Timestamp: '2027-01-01T12:00:00.250Z', Entries: { '1': sample(), '44': sample({ Status: 'OffTrack' }) } },
          { Timestamp: '2027-01-01T12:00:00.5000000Z', Entries: { '1': sample({ X: 32_767, Y: -32_768 }) } },
        ],
      }),
    ).toEqual([
      {
        t,
        cars: [
          [1, { status: 'OnTrack', x: -1200, y: 3400, z: 75 }],
          [44, { status: 'OffTrack', x: -1200, y: 3400, z: 75 }],
        ],
      },
      { t: t + 250, cars: [[1, { status: 'OnTrack', x: 32_767, y: -32_768, z: 75 }]] },
    ]);
  });

  it('drops ids that are no car: 241–243, 0, 100, a leading zero, letters', () => {
    const entries = Object.fromEntries(['241', '242', '243', '0', '100', '07', 'x', '1e1'].map((id) => [id, sample()]));
    expect(one({ ...entries, '99': sample() })[0]?.cars.map(([id]) => id)).toEqual([99]);
  });

  it('keeps OnTrack, OffTrack and a numeric status (2019); drops any other', () => {
    const cars = one({
      '1': sample({ Status: 0 }),
      '2': sample({ Status: 'Pit' }),
      '3': sample({ Status: null }),
      '4': sample({ Status: undefined }),
      '5': sample({ Status: Number.NaN }),
      '6': sample({ Status: 'onTrack' }),
    })[0]?.cars;
    expect(cars?.map(([id, s]) => [id, s.status])).toEqual([[1, 0]]);
  });

  it('drops X, Y or Z outside int16 or not an integer, and X = Y = 0', () => {
    const cars = one({
      '1': sample({ X: 32_768 }),
      '2': sample({ Y: -32_769 }),
      '3': sample({ Z: 1.5 }),
      '4': sample({ X: '12' }),
      '5': sample({ X: 0, Y: 0 }),
      '6': sample({ X: 0 }),
      '7': sample({ Z: undefined }),
    })[0]?.cars;
    expect(cars?.map(([id]) => id)).toEqual([6]);
  });

  it('skips an entry with a bad Timestamp or no Entries; anything else is []', () => {
    for (const bad of ['yesterday', 42, null, undefined]) expect(one({ '1': sample() }, bad)).toEqual([]);
    expect(positions({ Position: [{ Timestamp: '2027-01-01T12:00:00Z' }, 7, null] })).toEqual([]);
    expect(one({})).toEqual([{ t: Date.parse('2027-01-01T12:00:00.250Z'), cars: [] }]);
    for (const value of [null, 'x', 3, [], { Position: {} }, { Entries: [] }]) expect(positions(value)).toEqual([]);
  });
});
