import { describe, expect, it } from 'vitest';
import { archiveEvents } from '../src/archive/files.ts';
import { archiveT0, type FeedEvent } from '../src/live/read.ts';

const T0 = Date.parse('2019-03-17T05:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const sd = (t: number, payload: unknown): FeedEvent => ({ t, topic: 'SessionData', payload });
const hb = (t: number, utc: string): FeedEvent => ({ t, topic: 'Heartbeat', payload: { Utc: utc } });

describe('archiveT0', () => {
  it('takes the most frequent Utc − t of SessionData entries, list and dict forms, over the first-line outlier', () => {
    const data = [
      // The first line: a list of older entries, at the line's own time.
      sd(1000, { Series: [], StatusSeries: [{ Utc: at(-60_000), TrackStatus: 'AllClear' }] }),
      sd(5000, { StatusSeries: { 1: { Utc: at(5000), SessionStatus: 'Started' } } }),
      // Without a Z, as UTC.
      sd(9000, { Series: { 0: { Utc: at(9000).slice(0, -1), QualifyingPart: 1 } } }),
    ];
    const heartbeat = [hb(500, at(2500))]; // about 2 s late
    expect(archiveT0(heartbeat, data)).toEqual({ t0: T0, from: 'sessiondata' });
  });

  it('falls back to the first Heartbeat when fewer than 2 entries agree', () => {
    const heartbeat = [hb(0, 'soon'), hb(500, at(2500))];
    expect(archiveT0(heartbeat, [sd(5000, { StatusSeries: { 1: { Utc: at(5000) } } })])).toEqual({
      t0: T0 + 2000,
      from: 'heartbeat',
    });
    expect(archiveT0(heartbeat)).toEqual({ t0: T0 + 2000, from: 'heartbeat' });
    expect(archiveT0([], [sd(1, { Series: { 0: { Utc: 'x' } } })])).toBeUndefined();
  });

  it('breaks a tie by the value seen first', () => {
    const tie = [sd(1000, { Series: { 0: { Utc: at(1000) } } }), sd(2000, { Series: { 0: { Utc: at(2000) } } })];
    const later = [sd(3000, { Series: { 0: { Utc: at(3005) } } }), sd(4000, { Series: { 0: { Utc: at(4005) } } })];
    expect(archiveT0([], [...tie, ...later])).toEqual({ t0: T0, from: 'sessiondata' });
    expect(archiveT0([], [...later, ...tie])).toEqual({ t0: T0 + 5, from: 'sessiondata' });
  });
});

describe('archiveEvents', () => {
  it('puts SessionInfo first at an equal t, else keeps topic-name order', () => {
    const files = new Map([
      ['Heartbeat', `﻿00:00:01.000{"Utc":"${at(1000)}"}\r\n`],
      ['RaceControlMessages', '﻿00:00:02.000{"Messages":[]}\r\n'],
      ['SessionData', '﻿00:00:02.000{"Series":[]}\r\n'],
      ['SessionInfo', '﻿00:00:02.000{"Key":1}\r\n'],
    ]);
    const got = archiveEvents(files);
    expect(got?.events.map((e) => [e.topic, e.t - T0])).toEqual([
      ['Heartbeat', 1000],
      ['SessionInfo', 2000],
      ['RaceControlMessages', 2000],
      ['SessionData', 2000],
    ]);
    expect(got).toMatchObject({ t0: T0, from: 'heartbeat', heartbeat: T0, skipped: 0 });
    expect(archiveEvents(new Map([['TimingData', '00:00:01.000{}']]))).toBeUndefined();
  });
});
