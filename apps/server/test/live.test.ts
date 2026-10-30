import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFeed, MAX_DEPTH, merge, type Obj } from '../src/live/merge.ts';
import { archiveT0, duration, type FeedEvent, parseFeedLine, parseJsonStream } from '../src/live/read.ts';
import { view } from '../src/live/state.ts';

// Nested deltas the way the feed sends them: index-keyed objects, arrays, nulls, leaves. The few
// keys collide often, so values flip between leaf and object.
const key = fc.constantFrom('0', '1', '2', 'a', 'b');
const leaf = fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constantFrom('x', 'y', ''), fc.boolean(), fc.constant(null));
const { delta } = fc.letrec((tie) => ({
  tree: fc.oneof({ depthSize: 'small', maxDepth: 4 }, leaf, tie('delta')),
  delta: fc.oneof(fc.dictionary(key, tie('tree'), { maxKeys: 4 }), fc.array(tie('tree'), { maxLength: 3 })),
}));
// A `.z` topic's payload is a string, which replaces the topic's value raw.
const event = fc.record({
  topic: fc.constantFrom('TimingData', 'DriverList', 'CarData.z'),
  payload: fc.oneof(delta, leaf),
});
const events = fc.array(event, { maxLength: 12 }).map((list) => list.map((e, i): FeedEvent => ({ ...e, t: i * 1000 })));

describe('merge', () => {
  it('A§15: merging a snapshot then the remaining deltas equals merging every delta from empty', () => {
    fc.assert(
      fc.property(events, fc.nat(), (list, at) => {
        const split = at % (list.length + 1);
        const all = createFeed();
        for (const ev of list) all.apply(ev);

        const before = createFeed();
        for (const ev of list.slice(0, split)) before.apply(ev);
        // P2c writes the snapshot as JSON; a reconnect's full state arrives as one `full` event per topic.
        const snapshot = JSON.parse(JSON.stringify(before.state)) as Obj;
        const resumed = createFeed();
        for (const [topic, payload] of Object.entries(snapshot)) resumed.apply({ t: 0, topic, payload, full: true });
        for (const ev of list.slice(split)) resumed.apply(ev);

        expect(resumed.state).toEqual(all.state);
      }),
      { numRuns: 300 },
    );
  });

  it('merging the effective deltas from empty rebuilds the state', () => {
    fc.assert(
      fc.property(fc.array(delta, { maxLength: 10 }), (deltas) => {
        const state: Obj = {};
        const effective = deltas.map((d) => merge(state, d));
        const rebuilt: Obj = {};
        for (const d of effective) merge(rebuilt, d);
        expect(rebuilt).toEqual(state);
      }),
      { numRuns: 300 },
    );
  });

  it('returns only what changed, and arrays become index-keyed objects', () => {
    const state: Obj = {};
    expect(merge(state, { Lines: { '1': { Position: '1', Sectors: [{ Value: '23.1' }, { Value: '' }] } } })).toEqual({
      Lines: { '1': { Position: '1', Sectors: { '0': { Value: '23.1' }, '1': { Value: '' } } } },
    });
    expect(merge(state, { Lines: { '1': { Position: '1', Sectors: { '1': { Value: '30.2' } } } } })).toEqual({
      Lines: { '1': { Sectors: { '1': { Value: '30.2' } } } },
    });
    expect(merge(state, { Lines: { '1': { Position: '1' } } })).toBeUndefined();
    expect(merge(state, { Lines: { '1': { Sectors: null } } })).toEqual({ Lines: { '1': { Sectors: null } } });
    expect(merge(state, { Lines: { '1': { Sectors: [] } } })).toEqual({ Lines: { '1': { Sectors: {} } } });
    expect(Array.isArray((state.Lines as Obj)['1'])).toBe(false);
    expect(merge(state, 'raw')).toBeUndefined();
  });

  it('keeps a large index as an object key', () => {
    const state: Obj = {};
    merge(state, { Messages: { '4294967296': { Flag: 'GREEN' } } });
    expect(Object.keys(state.Messages as Obj)).toEqual(['4294967296']);
  });

  it('never writes or reads through a prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"prototype":{"polluted":3},' +
        '"a":{"__proto__":{"polluted":4},"b":[{"constructor":{"prototype":{"polluted":5}}},{"prototype":6}]}}',
    );
    const state: Obj = {};
    const effective = merge(state, hostile);
    const feed = createFeed();
    feed.apply({ t: 0, topic: '__proto__', payload: { polluted: 7 } });
    feed.apply({ t: 0, topic: 'TimingData', payload: hostile });
    feed.apply({ t: 0, topic: 'x', payload: hostile, full: true });

    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    const unsafe = (v: unknown): boolean =>
      typeof v === 'object' &&
      v !== null &&
      Object.entries(v).some(([k, c]) => ['__proto__', 'constructor', 'prototype'].includes(k) || unsafe(c));
    expect([state, effective, feed.state].some(unsafe)).toBe(false);
    expect(state).toEqual({ a: { b: { '0': {}, '1': {} } } });
    // An inherited name is a plain own key: `toString` is merged as data, not into Object.prototype.toString.
    const plain: Obj = {};
    expect(merge(plain, { toString: { a: 1 }, hasOwnProperty: 2 })).toEqual({ toString: { a: 1 }, hasOwnProperty: 2 });
    expect(Object.hasOwn(plain, 'toString')).toBe(true);
  });

  it(`drops objects nested deeper than ${MAX_DEPTH} levels`, () => {
    let deep: Obj = { v: 41 };
    for (let level = 40; level >= 1; level--) deep = { v: level, c: deep };
    const state: Obj = {};
    merge(state, deep);
    let depth = 0;
    for (let node: Obj | undefined = state; node; node = node.c as Obj | undefined) {
      depth++;
      expect(node.v).toBe(depth);
    }
    expect(depth).toBe(MAX_DEPTH);
  });
});

describe('createFeed', () => {
  const ev = (t: number, payload: unknown, full?: true): FeedEvent => ({
    t,
    topic: 'TimingData',
    payload,
    ...(full ? { full } : {}),
  });

  it('gives no second delta for the same message applied twice', () => {
    const feed = createFeed();
    const msg = ev(1_000, { Lines: { '1': { NumberOfLaps: 3 } } });
    expect(feed.apply(msg)).toBe(msg.payload);
    expect(feed.apply({ ...msg, payload: structuredClone(msg.payload) })).toBeUndefined();
    // The same payload at another time is a new message: its raw payload goes to the lap builder.
    expect(feed.apply(ev(2_000, msg.payload))).toBe(msg.payload);
  });

  it('forgets a message after 5 minutes of feed time', () => {
    const feed = createFeed();
    const msg = ev(0, { a: 1 });
    feed.apply(msg);
    feed.apply(ev(5 * 60_000 + 1, { b: 1 }));
    expect(feed.apply(msg)).toBe(msg.payload);
  });

  it('gives the effective delta of a full event, and none when it equals the state', () => {
    const feed = createFeed();
    feed.apply(ev(1_000, { Lines: { '1': { NumberOfLaps: 3, Position: '2' } } }));
    expect(feed.apply(ev(2_000, { Lines: [null, { NumberOfLaps: 3, Position: '1' }] }, true))).toEqual({
      Lines: { '0': null, '1': { Position: '1' } },
    });
    expect(
      feed.apply(ev(3_000, { Lines: { '0': null, '1': { NumberOfLaps: 3, Position: '1' } } }, true)),
    ).toBeUndefined();
    // A full event is never deduplicated, so a repeated reconnect at the same t still merges.
    feed.apply(ev(4_000, { Lines: { '1': { Position: '5' } } }));
    expect(feed.apply(ev(3_000, { Lines: { '1': { Position: '1' } } }, true))).toEqual({
      Lines: { '1': { Position: '1' } },
    });
  });

  it('replaces a topic whose payload is no object', () => {
    const feed = createFeed();
    expect(feed.apply({ t: 0, topic: 'CarData.z', payload: 'abc=' })).toBe('abc=');
    expect(feed.apply({ t: 1, topic: 'CarData.z', payload: 'def=' })).toBe('def=');
    expect(feed.apply({ t: 2, topic: 'CarData.z', payload: 'def=', full: true })).toBeUndefined();
    expect(feed.state['CarData.z']).toBe('def=');
  });

  it('ignores a null or undefined payload', () => {
    const feed = createFeed();
    feed.apply({ t: 0, topic: 'TimingData', payload: { Lines: { '7': { NumberOfLaps: 3 } } } });
    expect(feed.apply({ t: 1, topic: 'TimingData', payload: null })).toBeUndefined();
    expect(feed.apply({ t: 2, topic: 'TimingData', payload: undefined, full: true })).toBeUndefined();
    expect(feed.state).toEqual({ TimingData: { Lines: { '7': { NumberOfLaps: 3 } } } });
  });
});

describe('read', () => {
  it('parses a .jsonStream with a BOM, CRLF, a quoted .z string and bad lines', () => {
    const text =
      '﻿00:00:01.500{"Utc":"2026-10-30T18:30:01.500Z"}\r\n' +
      '00:00:02.250"7ZJBa8Mw=="\r\n' +
      '00:00:03.000{"bad"\r\n' +
      'xx:yy:zz.www{"a":1}\r\n' +
      '01:02:03.004{"Lines":{"1":{}}}\r\n';
    const t0 = Date.parse('2026-10-30T18:30:00Z');
    expect(parseJsonStream(text, 'Heartbeat', t0)).toEqual({
      events: [
        { t: t0 + 1_500, topic: 'Heartbeat', payload: { Utc: '2026-10-30T18:30:01.500Z' } },
        { t: t0 + 2_250, topic: 'Heartbeat', payload: '7ZJBa8Mw==' },
        { t: t0 + 3_723_004, topic: 'Heartbeat', payload: { Lines: { '1': {} } } },
      ],
      skipped: 2,
    });
    expect(parseJsonStream(text.replaceAll('\r\n', '\n'), 'Heartbeat', t0).events).toHaveLength(3);
    expect(parseJsonStream('', 'Heartbeat', t0)).toEqual({ events: [], skipped: 0 });
  });

  it('decodes a quoted payload as a JSON string, else strips its quotes as FastF1 does', () => {
    const text = '00:00:01.000"ab\\/cd=="\n00:00:02.000""x"\n';
    expect(parseJsonStream(text, 'CarData.z', 0).events.map((e) => e.payload)).toEqual(['ab/cd==', 'x']);
  });

  it('takes the archive epoch from the first Heartbeat', () => {
    const { events } = parseJsonStream(
      '00:00:01.500{"Utc":"2026-10-30T18:30:01.5000000Z"}\r\n00:00:02.500{"Utc":"2026-10-30T19:00:00Z"}\r\n',
      'Heartbeat',
      0,
    );
    expect(archiveT0(events)).toBe(Date.parse('2026-10-30T18:30:00Z'));
    expect(archiveT0([{ t: 0, topic: 'Heartbeat', payload: { Utc: 'soon' } }])).toBeUndefined();
  });

  it('parses both feed.jsonl line shapes and rejects garbage', () => {
    const at = Date.parse('2026-10-30T18:30:00.123Z');
    expect(parseFeedLine(`[1000,"TimingData",{"a":1},"2026-10-30T18:30:00.1234567Z"]`)).toEqual([
      { t: at, topic: 'TimingData', payload: { a: 1 } },
    ]);
    // The native client writes a missing timestamp as "undefined", the library one as null.
    expect(parseFeedLine('[1000,"TimingData",{"a":1},"undefined"]')).toEqual([
      { t: 1000, topic: 'TimingData', payload: { a: 1 } },
    ]);
    expect(parseFeedLine('[1000,"Position.z","abc=",null]')).toEqual([
      { t: 1000, topic: 'Position.z', payload: 'abc=' },
    ]);
    expect(parseFeedLine('[2000,"_subscribe",{"Heartbeat":{"Utc":"x"},"CarData.z":"abc="}]')).toEqual([
      { t: 2000, topic: 'Heartbeat', payload: { Utc: 'x' }, full: true },
      { t: 2000, topic: 'CarData.z', payload: 'abc=', full: true },
    ]);
    for (const garbage of [
      '',
      'not json',
      '{}',
      '[1000]',
      '[1000,"TimingData"]',
      '["1000","TimingData",{}]',
      '[1000,7,{}]',
      '[1000,"_subscribe",null]',
      '[1000,"_subscribe",[1,2]]',
      '[1000,"TimingData",{"a":1}',
    ])
      expect(parseFeedLine(garbage)).toEqual([]);
  });

  it.each([
    ['1:23.456', 83_456],
    ['23.456', 23_456],
    ['1:00:00.000', 3_600_000],
    ['36:54', 2_214_000],
    ['8:45:46', 31_546_000],
    ['24.3564', 24_356],
    ['1.0005', 1_001],
    ['1.0004999', 1_000],
    ['1.', 1_000],
    ['0.000', 0],
    ['', null],
    [' 1.2', null],
    ['-1.2', null],
    ['+1.2', null],
    ['.5', null],
    ['1:2:3:4.5', null],
    ['1:23,456', null],
    ['abc', null],
    ['9'.repeat(30), null],
    [83.456, null],
    [null, null],
    [undefined, null],
  ])('duration(%j) = %j', (input, expected) => {
    expect(duration(input)).toBe(expected);
  });
});

describe('view', () => {
  it('turns a bad leaf into undefined and keeps unknown fields', () => {
    const feed = createFeed();
    feed.apply({
      t: 0,
      topic: 'TimingData',
      payload: { Lines: { '1': { NumberOfLaps: '7', Position: '1', LastLapTime: { Value: '1:20.000' }, Extra: [1] } } },
    });
    feed.apply({ t: 0, topic: 'DriverList', payload: { '1': { Tla: 'VER', Line: 'one' }, _kf: true } });
    feed.apply({ t: 0, topic: 'SessionInfo', payload: 'not an object' });

    const line = view(feed.state, 'TimingData')?.Lines?.['1'];
    expect(line?.NumberOfLaps).toBeUndefined();
    expect(line?.Position).toBe('1');
    expect(line?.LastLapTime?.Value).toBe('1:20.000');
    expect(line?.Extra).toEqual({ '0': 1 });
    const drivers = view(feed.state, 'DriverList');
    expect(drivers?.['1']).toEqual({ Tla: 'VER', Line: undefined });
    expect(drivers?._kf).toBeUndefined();
    expect(view(feed.state, 'SessionInfo')).toBeUndefined();
    expect(view(feed.state, 'LapCount')).toBeUndefined();
  });
});
