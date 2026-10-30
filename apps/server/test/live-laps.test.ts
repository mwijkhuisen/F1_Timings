import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLaps, type LapRow, type StintRow } from '../src/live/laps.ts';
import { createFeed, type Obj } from '../src/live/merge.ts';
import { archiveT0, type FeedEvent, parseFeedLine, parseJsonStream } from '../src/live/read.ts';

// fixtures/live/ is synthetic, hand-written in the P2a feed.jsonl format: every value is invented.
const read = (file: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/live', file), 'utf8')
    .split('\n')
    .flatMap(parseFeedLine);

/** Rows the way a replay builds them: every event through the merge, its delta into the laps. */
function build(events: readonly FeedEvent[], key: number, source: 'f1-live' | 'f1-archive' = 'f1-live') {
  const [feed, laps] = [createFeed(), createLaps(key, source)];
  for (const ev of events) {
    const delta = feed.apply(ev);
    if (delta !== undefined) laps.push(ev, delta);
  }
  return laps.rows();
}

type Time = [ms: number, set: string];
/** Expected rows: each time with the clock time it was set; every other field null or false unless `rest` has it. */
function session(session_key: number, day: string) {
  const clock = (hms: string) => Date.parse(`${day}T${hms}Z`);
  const at = (time?: Time) => (time ? clock(time[1]) : null);
  const lap = (
    driver: number,
    n: number,
    start: string,
    times: Partial<Record<'lap' | 's1' | 's2' | 's3', Time>> = {},
    rest: Partial<LapRow> = {},
  ): LapRow => ({
    session_key,
    source: 'f1-live',
    driver_number: driver,
    lap_number: n,
    date_start: new Date(clock(start)).toISOString(),
    lap_ms: times.lap?.[0] ?? null,
    s1_ms: times.s1?.[0] ?? null,
    s2_ms: times.s2?.[0] ?? null,
    s3_ms: times.s3?.[0] ?? null,
    i1_kph: null,
    i2_kph: null,
    st_kph: null,
    is_pit_out: false,
    is_pit_in: false,
    seg1: null,
    seg2: null,
    seg3: null,
    deleted: false,
    deleted_reason: null,
    quali_phase: null,
    at: { lap: at(times.lap), s1: at(times.s1), s2: at(times.s2), s3: at(times.s3) },
    ...rest,
  });
  const stint = (driver: number, n: number, start: number, end: number, compound: string, age: number): StintRow => ({
    session_key,
    source: 'f1-live',
    driver_number: driver,
    stint_number: n,
    lap_start: start,
    lap_end: end,
    compound,
    tyre_age_at_start: age,
  });
  return { lap, stint };
}

const practice = session(9001, '2026-01-10');
const PRACTICE = {
  laps: [
    // Garage out-lap: no S1 and no lap time; the ST in the message that started lap 2 came before its count.
    practice.lap(
      7,
      1,
      '12:01:00',
      { s2: [38_512, '12:01:50'], s3: [30_104, '12:02:20'] },
      { st_kph: 298, is_pit_out: true },
    ),
    // Lap time and S3 came 3 s into lap 3, so they are lap 2's; that message's ST went to lap 3. seg1[1] was written
    // in place and showed with S1; seg3[2], written in place 7 s into lap 3, never shows (lap 2 changed no more).
    practice.lap(
      7,
      2,
      '12:02:20',
      { lap: [91_250, '12:03:54'], s1: [28_100, '12:02:48'], s2: [33_050, '12:03:21'], s3: [30_100, '12:03:54'] },
      { i1_kph: 285, i2_kph: 262, seg1: [2049, 2051], seg3: [2048, 2049] },
    ),
    // No LastLapTime (it equalled lap 2's, so F1 sent no change): the sector sum, set with S3.
    practice.lap(
      7,
      3,
      '12:03:51',
      {
        lap: [91_250, '12:05:22.250'],
        s1: [28_200, '12:04:19'],
        s2: [33_000, '12:04:52'],
        s3: [30_050, '12:05:22.250'],
      },
      { i1_kph: 286, st_kph: 305 },
    ),
    // In-lap: lap 5 is an out-lap. Its lap time and S3 came 3 s after the pit-lane line started lap 5.
    practice.lap(
      7,
      4,
      '12:05:22.250',
      { lap: [107_600, '12:07:13'], s1: [29_900, '12:05:52'], s2: [38_400, '12:06:30'], s3: [39_300, '12:07:13'] },
      { is_pit_in: true },
    ),
    // Out-lap after the stop, from the pit-lane line: its 3:12 is kept (FastF1's 150 s filter is not used).
    practice.lap(
      7,
      5,
      '12:07:10',
      { lap: [192_000, '12:10:22'], s2: [40_200, '12:09:50'], s3: [32_000, '12:10:22'] },
      { is_pit_out: true },
    ),
    practice.lap(7, 6, '12:10:22', { s1: [28_500, '12:10:52'] }),
    // The stale 1:45.000 3 s after the garage exit had no lap before it: dropped.
    practice.lap(
      99,
      1,
      '12:01:05',
      { s2: [39_001, '12:02:00'], s3: [30_950, '12:02:33'] },
      { i2_kph: 250, is_pit_out: true },
    ),
    practice.lap(
      99,
      2,
      '12:02:30',
      { lap: [90_900, '12:04:00'], s1: [28_300, '12:03:00'], s2: [33_700, '12:03:30'], s3: [28_900, '12:04:00'] },
      { i1_kph: 283 },
    ),
    // "5:38.000" is no S3: OpenF1 reads sectors as plain seconds.
    practice.lap(99, 3, '12:04:00', { lap: [400_000, '12:10:40'], s1: [28_400, '12:04:28'], s2: [33_600, '12:05:02'] }),
    // Started after the chequered flag, which cuts only races.
    practice.lap(99, 4, '12:10:40'),
  ],
  // 7's HARD set came 90 s after the pit-lane count, so no correction. 99's StartLaps 3 was corrected to 2.
  stints: [
    practice.stint(7, 1, 1, 5, 'SOFT', 0),
    practice.stint(7, 2, 6, 6, 'HARD', 0),
    practice.stint(99, 1, 1, 4, 'MEDIUM', 2),
  ],
};

describe('createLaps', () => {
  it('practice: out-laps, late values, a lap time from its sectors, an in-lap and a stint change', () => {
    expect(build(read('practice.jsonl'), 9001)).toEqual(PRACTICE);
  });

  it('race: the +1 numbering, lap 1 from the start, the 10 s stint rule and the chequered-flag cut', () => {
    const { lap, stint } = session(9002, '2026-01-11');
    expect(build(read('race.jsonl'), 9002)).toEqual({
      laps: [
        // Lap 1 starts at the Utc of the "Started" status, not at that message's time; its time is the sector sum,
        // as S3 came before lap 2 started, and the late, equal LastLapTime changes nothing.
        lap(
          7,
          1,
          '14:00:00',
          { lap: [94_700, '14:01:35'], s1: [30_500, '14:00:31'], s2: [34_200, '14:01:05'], s3: [30_000, '14:01:35'] },
          { i1_kph: 290, seg1: [2049] },
        ),
        lap(
          7,
          2,
          '14:01:35',
          { lap: [99_000, '14:03:14'], s1: [29_800, '14:02:05'], s2: [33_900, '14:02:39'], s3: [35_300, '14:03:14'] },
          { is_pit_in: true },
        ),
        lap(
          7,
          3,
          '14:03:12',
          { lap: [124_000, '14:05:19'], s1: [52_000, '14:04:10'], s2: [34_100, '14:04:44'], s3: [37_900, '14:05:19'] },
          { is_pit_out: true },
        ),
        // No S1: when lap 2 started, the time became lap 2's start minus the Started time, and S1 the rest.
        lap(
          99,
          1,
          '14:00:00',
          {
            lap: [96_500, '14:01:36.500'],
            s1: [30_600, '14:01:36.500'],
            s2: [34_900, '14:01:06'],
            s3: [31_000, '14:01:36.500'],
          },
          { i1_kph: 287, seg1: [2048] },
        ),
        lap(99, 2, '14:01:36.500', {
          lap: [98_600, '14:03:15'],
          s1: [30_100, '14:02:07'],
          s2: [34_000, '14:02:41'],
          s3: [34_500, '14:03:15'],
        }),
        lap(99, 3, '14:03:15', {
          lap: [93_400, '14:04:48.500'],
          s1: [29_900, '14:03:45'],
          s2: [33_800, '14:04:19'],
          s3: [29_700, '14:04:48.500'],
        }),
        // Both laps 4 started after the chequered flag and never show.
      ],
      // The HARD set came 6 s after 7's count of 2, so stint 1 gives that lap up. lap_end is the raw count (no +1).
      stints: [stint(7, 1, 1, 1, 'MEDIUM', 0), stint(7, 2, 2, 3, 'HARD', 0), stint(99, 1, 1, 3, 'SOFT', 2)],
    });
  });

  it('reconnect duplicates and a mid-session full state give the same rows', () => {
    // A lost speed-trap message that the full state carries, then the three messages before the drop again.
    expect(build(read('practice-reconnect.jsonl'), 9001)).toEqual(PRACTICE);
  });

  it('a reconnect at any point k, with any m recent messages repeated, gives the clean rows', () => {
    const events = read('practice.jsonl');
    fc.assert(
      fc.property(fc.integer({ min: 1, max: events.length }), fc.integer({ min: 0, max: 6 }), (k, m) => {
        const head = events.slice(0, k);
        const feed = createFeed();
        for (const ev of head) feed.apply(ev);
        const { t } = head.at(-1) as FeedEvent;
        // The Subscribe completion's full state as JSON (the way P2a records it), then a replay of recent messages.
        const full = Object.entries(JSON.parse(JSON.stringify(feed.state)) as Obj).map(
          ([topic, payload]): FeedEvent => ({ t, topic, payload, full: true }),
        );
        const normal = head.filter((ev) => !ev.full);
        const replay = normal.slice(Math.max(0, normal.length - m));
        expect(build([...head, ...full, ...replay, ...events.slice(k)], 9001)).toEqual(PRACTICE);
      }),
      { numRuns: 100 },
    );
  });

  it('the archive form of practice gives the same rows as its feed.jsonl form, apart from source', () => {
    const events = read('practice.jsonl');
    const t0 = (events[0] as FeedEvent).t;
    // One .jsonStream per topic: a BOM, then lines of HH:MM:SS.mmm since t0 and the JSON payload, CRLF.
    const files = new Map<string, string>();
    for (const ev of events) {
      const line = `${new Date(ev.t - t0).toISOString().slice(11, 23)}${JSON.stringify(ev.payload)}\r\n`;
      files.set(ev.topic, (files.get(ev.topic) ?? '﻿') + line);
    }
    expect(archiveT0(parseJsonStream(files.get('Heartbeat') ?? '', 'Heartbeat', 0).events)).toBe(t0);
    // By time, then topic, as OpenF1 orders archive messages.
    const archive = [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([topic, text]) => parseJsonStream(text, topic, t0).events)
      .sort((a, b) => a.t - b.t);
    const archived = <T>(row: T) => ({ ...row, source: 'f1-archive' });
    expect(build(archive, 9001, 'f1-archive')).toEqual({
      laps: PRACTICE.laps.map(archived),
      stints: PRACTICE.stints.map(archived),
    });
  });

  it('PitOut marks the current lap whatever its value, except null', () => {
    const at = Date.parse('2026-01-10T12:00:00Z');
    const timing = (s: number, line: Obj): FeedEvent => ({
      t: at + s * 1000,
      topic: 'TimingData',
      payload: { Lines: { 7: line } },
    });
    const { laps } = build(
      [
        { t: at, topic: 'TimingAppData', payload: { Lines: { 7: { Stints: [{ Compound: 'SOFT' }] } } } },
        timing(1, { NumberOfLaps: 1, PitOut: false }),
        timing(90, { NumberOfLaps: 2, PitOut: null }),
      ],
      9001,
    );
    expect(laps.map((l) => [l.lap_number, l.is_pit_out])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('a Stints list all goes to stint 1, its last entry winning (OpenF1; FastF1 numbers it by position)', () => {
    const payload = {
      Lines: {
        7: {
          Stints: [
            { Compound: 'SOFT', StartLaps: 1 },
            { Compound: 'MEDIUM', StartLaps: 4 },
          ],
        },
      },
    };
    expect(build([{ t: 0, topic: 'TimingAppData', payload }], 9001).stints).toEqual([
      practice.stint(7, 1, 1, 1, 'MEDIUM', 4),
    ]);
  });

  it('race lap 1, completed when lap 2 starts, shows that only once lap 1 changes again', () => {
    const at = Date.parse('2026-01-11T14:00:00Z');
    const ev = (s: number, topic: string, payload: Obj): FeedEvent => ({ t: at + s * 1000, topic, payload });
    const timing = (s: number, line: Obj) => ev(s, 'TimingData', { Lines: { 7: line } });
    const events = [
      ev(-600, 'SessionInfo', { Type: 'Race' }),
      ev(-300, 'TimingAppData', { Lines: { 7: { Stints: [{ Compound: 'MEDIUM' }] } } }),
      timing(-60, { Sectors: { 0: { Segments: { 0: { Status: 2048 } } } } }),
      ev(0, 'SessionData', { StatusSeries: [{ Utc: '2026-01-11T14:00:00', SessionStatus: 'Started' }] }),
      timing(65, { Sectors: { 1: { Value: '34.200' } } }),
      timing(94, { Sectors: { 2: { Value: '30.000' } } }),
      timing(95, { NumberOfLaps: 1 }),
    ];
    expect(build(events, 9002).laps[0]).toMatchObject({ lap_number: 1, lap_ms: null, s1_ms: null, s3_ms: 30_000 });
    // The first S3 segment 2 s into lap 2 is lap 1's and creates its list: lap 1 shows again, completed.
    const later = [...events, timing(97, { Sectors: { 2: { Segments: { 0: { Status: 2049 } } } } })];
    expect(build(later, 9002).laps[0]).toMatchObject({ lap_ms: 95_000, s1_ms: 30_800, s3_ms: 30_000, seg3: [2049] });
  });
});
