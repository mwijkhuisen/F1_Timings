import type { Obj } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tower, towerRows } from '../src/views/Tower.tsx';

// The timing tower (A§13) on hand-built, synthetic feed states.

const seg = (...codes: number[]) => Object.fromEntries(codes.map((Status, i) => [String(i), { Status }]));
const state: Obj = {
  SessionInfo: { Key: 9965, Type: 'Race' },
  DriverList: {
    '1': { Tla: 'AAA', FullName: 'Ann A', TeamColour: 'FF0000' },
    '2': { Tla: 'BBB', FullName: 'Bob B', TeamColour: '00FF00' },
    '3': { Tla: 'CCC' },
    '4': { Tla: 'DDD' },
  },
  TimingData: {
    Lines: {
      '3': { Line: 3, Position: '3', GapToLeader: '+9.1', IntervalToPositionAhead: { Value: '+4.2' }, Retired: true },
      '1': {
        Line: 1,
        Position: '1',
        GapToLeader: 'LAP 5',
        IntervalToPositionAhead: { Value: 'LAP 5' },
        LastLapTime: { Value: '1:30.000', OverallFastest: true, PersonalFastest: true },
        BestLapTime: { Value: '1:29.000', Lap: 4 },
        NumberOfPitStops: 2,
        InPit: true,
        Sectors: {
          '0': { Value: '30.1', PersonalFastest: true, Segments: seg(2051, 2049, 2048) },
          '1': { Value: '31.2', Segments: seg(2064, 0, 9999) },
        },
      },
      '2': {
        Line: 2,
        Position: '2',
        GapToLeader: '+1.5',
        IntervalToPositionAhead: { Value: '+1.5' },
        LastLapTime: { Value: '1:31.000', PersonalFastest: true },
        NumberOfPitStops: 0,
        PitOut: true,
        Stopped: true,
      },
      '4': { Line: 4, Position: '4' },
    },
  },
  TimingAppData: {
    Lines: {
      '1': {
        Stints: {
          '0': { Compound: 'HARD', TotalLaps: 20 },
          '1': { Compound: 'SOFT', TotalLaps: 7 },
        },
      },
      '2': { Stints: { '0': { Compound: 'MYSTERY', TotalLaps: 3 } } },
    },
  },
};

describe('towerRows', () => {
  const rows = towerRows(state);

  it('orders by Line and names the drivers from the DriverList', () => {
    expect(rows.map((r) => r.driver.acronym)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(rows[0]?.driver).toMatchObject({ number: 1, name: 'Ann A', team: '#FF0000' });
  });

  it('takes the gap, interval, last and best lap from the line', () => {
    expect(rows[1]).toMatchObject({ gap: { value: '+1.5' }, interval: { value: '+1.5' }, last: '1:31.000' });
    expect(rows[0]).toMatchObject({ last: '1:30.000', best: '1:29.000' });
  });

  it('takes the tyre from the last stint', () => {
    expect(rows[0]?.tyre).toMatchObject({ Compound: 'SOFT', TotalLaps: 7 });
    expect(rows[2]?.tyre).toBeUndefined();
  });
});

// Gap and Int per session type (A§11.3): the fields each type sends, as the F1 archive check found them. Every line
// below also carries another type's field, which must not be read.
const gaps = (s: Obj) => towerRows(s).map((r) => [r.driver.number, r.gap, r.interval]);
const value = (v: string) => ({ value: v });
const reason = (r: string) => ({ reason: r });

describe('Gap and Int in a race', () => {
  const race: Obj = {
    SessionInfo: { Key: 9003, Type: 'Race', Name: 'Race' },
    TimingData: {
      Lines: {
        '1': { Line: 1, Position: '1', GapToLeader: 'LAP 12', IntervalToPositionAhead: { Value: 'LAP 12' } },
        '2': {
          Line: 2,
          Position: '2',
          GapToLeader: '+2.345',
          IntervalToPositionAhead: { Value: '+2.345', Catching: true },
          TimeDiffToFastest: '+9.999',
        },
        '3': { Line: 3, Position: '3', GapToLeader: '1L', IntervalToPositionAhead: { Value: '+40.100' } },
        '4': { Line: 4, Position: '4', GapToLeader: '', IntervalToPositionAhead: { Value: '' }, Retired: true },
        '5': { Line: 5, Position: '5', GapToLeader: '', IntervalToPositionAhead: { Value: '' } },
        '6': { Line: 6, Position: '6', TimeDiffToFastest: '+1.000', TimeDiffToPositionAhead: '+1.000' },
      },
    },
  };

  it('reads GapToLeader and IntervalToPositionAhead, the leader its lap and a lapped car its laps', () => {
    expect(gaps(race)).toEqual([
      [1, value('LAP 12'), value('LAP 12')],
      [2, value('+2.345'), value('+2.345')],
      [3, value('1L'), value('+40.100')],
      [4, reason('Retired'), reason('Retired')],
      [5, reason('No gap in the feed'), reason('No interval in the feed')],
      [6, reason('No gap in the feed'), reason('No interval in the feed')],
    ]);
  });

  it('is the same for a sprint, which is of type Race too', () => {
    const sprint = { ...race, SessionInfo: { Key: 9004, Type: 'Race', Name: 'Sprint' } };
    expect(gaps(sprint)).toEqual(gaps(race));
  });
});

describe('Gap and Int in practice', () => {
  const practice: Obj = {
    SessionInfo: { Key: 9001, Type: 'Practice', Name: 'Practice 1' },
    TimingData: {
      Lines: {
        '1': {
          Line: 1,
          Position: '1',
          BestLapTime: { Value: '1:30.000', Lap: 6 },
          TimeDiffToFastest: '',
          TimeDiffToPositionAhead: '',
        },
        '2': {
          Line: 2,
          Position: '2',
          BestLapTime: { Value: '1:30.500', Lap: 4 },
          TimeDiffToFastest: '+0.500',
          TimeDiffToPositionAhead: '+0.500',
          GapToLeader: '+9.999',
          IntervalToPositionAhead: { Value: '+9.999' },
        },
        '3': {
          Line: 3,
          Position: '3',
          BestLapTime: { Value: '1:31.200', Lap: 2 },
          TimeDiffToFastest: '+1.200',
          TimeDiffToPositionAhead: '+0.700',
        },
        '4': { Line: 4, Position: '4', BestLapTime: { Value: '' }, TimeDiffToFastest: '', TimeDiffToPositionAhead: '' },
        '5': { Line: 5, Position: '5', Retired: true, TimeDiffToFastest: '', TimeDiffToPositionAhead: '' },
      },
    },
  };

  it('reads TimeDiffToFastest and TimeDiffToPositionAhead from the line', () => {
    expect(gaps(practice)).toEqual([
      [1, reason('Fastest lap: no gap'), reason('Fastest lap: no car ahead')],
      [2, value('+0.500'), value('+0.500')],
      [3, value('+1.200'), value('+0.700')],
      [4, reason('No lap time yet'), reason('No lap time yet')],
      [5, reason('Retired'), reason('Retired')],
    ]);
  });
});

describe('Gap and Int in qualifying', () => {
  // Stats and BestLapTimes hold one entry per part, keyed by SessionPart − 1; the interval is spelt TimeDifftoPositionAhead.
  const diff = (gap: string, interval: string) => ({ TimeDiffToFastest: gap, TimeDifftoPositionAhead: interval });
  const quali = (part: number | undefined, name = 'Qualifying'): Obj => ({
    SessionInfo: { Key: 9002, Type: 'Qualifying', Name: name },
    TimingData: {
      ...(part === undefined ? {} : { SessionPart: part }),
      NoEntries: { '0': 20, '1': 15, '2': 10 },
      Lines: {
        '1': {
          Line: 1,
          Position: '1',
          Stats: { '0': diff('+0.100', '+0.100'), '1': diff('', ''), '2': diff('', '') },
          BestLapTimes: { '0': { Value: '1:29.100' }, '1': { Value: '1:28.500' }, '2': { Value: '' } },
        },
        '2': {
          Line: 2,
          Position: '2',
          Stats: { '0': diff('', ''), '1': diff('+0.250', '+0.250') },
          BestLapTimes: { '0': { Value: '1:29.000' }, '1': { Value: '1:28.750' } },
          TimeDiffToFastest: '+9.999',
          GapToLeader: '+9.999',
        },
        '3': {
          Line: 3,
          Position: '3',
          Stats: { '0': diff('+0.300', '+0.200'), '1': diff('', '') },
          BestLapTimes: { '0': { Value: '1:29.300' }, '1': { Value: '' } },
        },
        '4': {
          Line: 4,
          Position: '16',
          KnockedOut: true,
          Stats: { '0': diff('+1.200', '+0.050'), '1': diff('', '') },
          BestLapTimes: { '0': { Value: '1:30.200' } },
        },
      },
    },
  });

  it("reads the current part's Stats: in Q2 the second entry", () => {
    expect(gaps(quali(2))).toEqual([
      [1, reason('Fastest in Q2: no gap'), reason('Fastest in Q2: no car ahead')],
      [2, value('+0.250'), value('+0.250')],
      [3, reason('No time in Q2 yet'), reason('No time in Q2 yet')],
      [4, reason('Knocked out: no time in Q2'), reason('Knocked out: no time in Q2')],
    ]);
  });

  it('reads the first entry in Q1', () => {
    expect(gaps(quali(1)).slice(2)).toEqual([
      [3, value('+0.300'), value('+0.200')],
      [4, value('+1.200'), value('+0.050')],
    ]);
  });

  it('names the parts SQ1–SQ3 in a sprint qualifying', () => {
    expect(gaps(quali(2, 'Sprint Qualifying'))[0]).toEqual([
      1,
      reason('Fastest in SQ2: no gap'),
      reason('Fastest in SQ2: no car ahead'),
    ]);
    expect(gaps(quali(3, 'Sprint Shootout'))[2]).toEqual([
      3,
      reason('No time in SQ3 yet'),
      reason('No time in SQ3 yet'),
    ]);
  });

  it('has no gaps before Q1 (SessionPart 0) or without a part', () => {
    expect(gaps(quali(0)).flatMap(([, g, i]) => [g, i])).toEqual(Array(8).fill(reason('Q1 has not started')));
    expect(gaps(quali(0, 'Sprint Qualifying'))[0]?.[1]).toEqual(reason('SQ1 has not started'));
    expect(gaps(quali(undefined))[0]?.[1]).toEqual(reason('No qualifying part in the feed'));
  });
});

describe('Gap and Int without a known session type', () => {
  const lines = { '1': { Line: 1, GapToLeader: '+1.000', TimeDiffToFastest: '+1.000' } };

  it('reads nothing and says why', () => {
    expect(gaps({ TimingData: { Lines: lines } })).toEqual([
      [1, reason('No session type in the feed'), reason('No session type in the feed')],
    ]);
    expect(gaps({ SessionInfo: { Type: 'Testing' }, TimingData: { Lines: lines } })).toEqual([
      [1, reason('Unknown session type'), reason('Unknown session type')],
    ]);
  });
});

describe('the tower', () => {
  const html = renderToStaticMarkup(<Tower state={state} sessionKey={9965} />);
  const row = (tla: string) => html.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';

  it('colours the last lap purple for the overall best and green for a personal best', () => {
    expect(row('AAA')).toContain('<td class="t-purple">1:30.000</td>');
    expect(row('BBB')).toContain('<td class="t-green">1:31.000</td>');
  });

  it('shows the gap and interval as text, and — with its reason in the title and the popover', () => {
    expect(row('AAA')).toContain('<td>LAP 5</td><td>LAP 5</td>');
    expect(row('BBB')).toContain('<td>+1.5</td><td>+1.5</td>');
    expect(row('DDD')).toContain(
      '<td><button type="button" class="note" popoverTarget="tower-gap-4" aria-describedby="tower-gap-4" ' +
        'title="No gap in the feed">—</button><div popover="auto" id="tower-gap-4" class="pop">No gap in the feed</div></td>',
    );
    expect(row('DDD')).toMatch(/<div popover="auto" id="tower-int-4" class="pop">No interval in the feed<\/div>/);
    // A retired driver keeps the values the feed still sends.
    expect(row('CCC')).toContain('<td>+9.1</td><td>+4.2</td>');
  });

  it('gives every note a unique id', () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(ids).toEqual(['tower-gap-4', 'tower-int-4']);
  });

  it('shows the mini-sector legend above its scroll box', () => {
    expect(html).toMatch(/^<p class="legend">[\s\S]*?<\/p><div class="scroll"[^>]*><table class="list tower"/);
    expect(html).toContain('<span class="ms ms-purple" aria-hidden="true"></span> overall best</span>');
  });

  it('shows each sector value in its colour with its mini-sector boxes', () => {
    expect(row('AAA')).toContain(
      '<span class="t-green">30.1</span><span class="ms ms-purple" aria-hidden="true"></span>' +
        '<span class="ms ms-green" aria-hidden="true"></span><span class="ms ms-yellow" aria-hidden="true"></span>',
    );
    expect(row('AAA')).toContain('ms-pit');
    expect(row('AAA')).toContain('ms-none');
    expect(row('AAA')).toContain('ms-grey');
  });

  it('shows the tyre as a compound dot with its laps', () => {
    expect(row('AAA')).toContain('<span class="cmp cmp-soft" title="SOFT">S</span>7');
    expect(row('BBB')).toContain('cmp-unknown');
  });

  it('shows the pit stops with the IN PIT and OUT badges', () => {
    expect(row('AAA')).toContain('2<span class="badge">IN PIT</span>');
    expect(row('BBB')).toContain('0<span class="badge">OUT</span>');
    expect(row('CCC')).not.toContain('badge');
  });

  it('mutes a retired or stopped driver', () => {
    expect(row('BBB')).toContain('class="out"');
    expect(row('CCC')).toContain('class="out"');
    expect(row('AAA')).not.toContain('class="out"');
  });

  it('waits while the feed shows another session, and shows the rows once it matches', () => {
    const waiting = renderToStaticMarkup(<Tower state={state} sessionKey={9964} />);
    expect(waiting).toBe('<p class="muted">Waiting for the session: the feed still shows the previous one.</p>');
    expect(renderToStaticMarkup(<Tower state={{ ...state, SessionInfo: undefined }} sessionKey={9965} />)).toContain(
      'Waiting for the session',
    );
    expect(html).toContain('aria-label="Timing tower"');
  });

  it('renders feed text as text', () => {
    const evil = renderToStaticMarkup(
      <Tower
        state={{
          SessionInfo: { Type: 'Race' },
          DriverList: { '5': { Tla: '<b>' } },
          TimingData: { Lines: { '5': { Line: 1, GapToLeader: '<i>', IntervalToPositionAhead: { Value: '&x' } } } },
        }}
      />,
    );
    expect(evil).toContain('&lt;b&gt;');
    expect(evil).toContain('<td>&lt;i&gt;</td><td>&amp;x</td>');
  });
});
