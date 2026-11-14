import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Obj } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Trend } from '../src/lib/crossings.ts';
import { Tower, towerRows } from '../src/views/Tower.tsx';
import { practiceState, qualifyingState, raceState } from './feed-state.ts';

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
          '1': { Compound: 'SOFT', TotalLaps: 7, StartLaps: 0, New: 'true' },
        },
      },
      '2': { Stints: { '0': { Compound: 'MYSTERY', TotalLaps: 3 } } },
      '4': { Stints: { '0': { Compound: 'SOFT', TotalLaps: 12, StartLaps: 3, New: 'false' } } },
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

  it('reads GapToLeader and IntervalToPositionAhead, the leader is "Leader" and a lapped car shows its laps', () => {
    expect(gaps(race)).toEqual([
      [1, { leader: true }, reason('Leader: no car ahead')],
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

  it('colours the last lap purple for the overall best and green for a personal best, with the words', () => {
    expect(row('AAA')).toContain('<td class="t-purple">1:30.000<span class="vh">, overall best</span></td>');
    expect(row('BBB')).toContain('<td class="t-green">1:31.000<span class="vh">, personal best</span></td>');
    expect(html.match(/class="vh">, /g)).toHaveLength(3);
  });

  it('shows the gap and interval as text, and — with its reason in the title and the popover', () => {
    expect(row('AAA')).toContain(
      '<td><span class="muted">Leader</span></td><td><button type="button" class="note" popoverTarget="tower-int-1" ' +
        'aria-describedby="tower-int-1" title="Leader: no car ahead">—</button>',
    );
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
    expect(ids).toEqual(['tower-int-1', 'tower-tyre-3', 'tower-gap-4', 'tower-int-4']);
  });

  it('shows — with "No stint in the feed" behind a tap for a driver without a stint', () => {
    expect(row('CCC')).toContain(
      '<td><button type="button" class="note" popoverTarget="tower-tyre-3" aria-describedby="tower-tyre-3" ' +
        'title="No stint in the feed">—</button><div popover="auto" id="tower-tyre-3" class="pop">No stint in the feed</div></td>',
    );
  });

  it('shows the mini-sector legend above its scroll box', () => {
    expect(html).toMatch(/^<p class="legend">[\s\S]*?<\/p><div class="scroll"[^>]*><table class="list tower"/);
    expect(html).toContain('<span class="ms ms-purple" aria-hidden="true"></span> overall best</span>');
  });

  it('shows each sector value in its colour with its mini-sector boxes', () => {
    expect(row('AAA')).toContain(
      '<span class="t-green">30.1<span class="vh">, personal best</span></span><span class="ms ms-purple" aria-hidden="true"></span>' +
        '<span class="ms ms-green" aria-hidden="true"></span><span class="ms ms-yellow" aria-hidden="true"></span>',
    );
    expect(row('AAA')).toContain('<td class="sector"><span>31.2</span><span class="ms ms-pit"');
    expect(row('AAA')).toContain('ms-none');
    expect(row('AAA')).toContain('ms-grey');
  });

  // New or used comes from the stint's New ("true" or "false"), no longer from StartLaps (P4d).
  it('shows the tyre as a hidden compound dot, its words and its laps, a used set dashed', () => {
    expect(row('AAA')).toContain(
      '<span class="cmp cmp-soft" title="Soft, new set" aria-hidden="true">S</span><span class="vh">soft tyres, new set, </span>7',
    );
    expect(row('DDD')).toContain(
      '<span class="cmp cmp-soft used" title="Soft, used set" aria-hidden="true">S</span><span class="vh">soft tyres, used set, </span>12',
    );
    expect(row('BBB')).toContain(
      '<span class="cmp cmp-unknown" title="MYSTERY" aria-hidden="true">?</span><span class="vh">unknown tyres, </span>3',
    );
  });

  it('says neither new nor used without a New of "true" or "false"', () => {
    const stint = (New: unknown) =>
      renderToStaticMarkup(
        <Tower
          state={{
            ...state,
            TimingAppData: {
              Lines: { '1': { Stints: { '0': { Compound: 'HARD', TotalLaps: 4, StartLaps: 9, New } } } },
            },
          }}
        />,
      );
    for (const New of [undefined, 'yes', true])
      expect(stint(New)).toContain(
        '<span class="cmp cmp-hard" title="Hard" aria-hidden="true">H</span><span class="vh">hard tyres, </span>4',
      );
  });

  // #126: the session's year picks the compounds; without one (no session detail yet) it is today's map.
  it("names a tyre in its season's words: 2018's Ultrasoft, unknown from 2019", () => {
    const tyre = (Compound: string, year?: number) =>
      renderToStaticMarkup(
        <Tower
          state={{ ...state, TimingAppData: { Lines: { '1': { Stints: { '0': { Compound, TotalLaps: 4 } } } } } }}
          year={year}
        />,
      );
    expect(tyre('ULTRASOFT', 2018)).toContain(
      '<span class="cmp cmp-ultrasoft" title="Ultrasoft" aria-hidden="true">US</span><span class="vh">ultrasoft tyres, </span>4',
    );
    expect(tyre('HARD', 2018)).toContain('<span class="cmp cmp-hard-2018" title="Hard" aria-hidden="true">H</span>');
    for (const year of [2019, undefined])
      expect(tyre('ULTRASOFT', year)).toContain(
        '<span class="cmp cmp-unknown" title="ULTRASOFT" aria-hidden="true">?</span><span class="vh">unknown tyres, </span>4',
      );
    expect(tyre('TEST_UNKNOWN', 2020)).toContain(
      '<span class="cmp cmp-test" title="Test tyre" aria-hidden="true">T</span><span class="vh">test tyres, </span>4',
    );
  });

  it('shows the pit stops with the IN PIT and OUT badges', () => {
    expect(row('AAA')).toContain('2<span class="badge">IN PIT</span>');
    expect(row('BBB')).toContain('0<span class="badge">OUT</span>');
    expect(row('CCC')).not.toContain('badge');
    // IN PIT wins over a stale OUT.
    const both = renderToStaticMarkup(
      <Tower state={{ ...state, TimingData: { Lines: { '1': { Line: 1, InPit: true, PitOut: true } } } }} />,
    );
    expect(both).toContain('<span class="badge">IN PIT</span>');
    expect(both).not.toContain('>OUT<');
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
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Timing tower"><table');
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

describe('places since the start (races only)', () => {
  it('is GridPos − Position in a race, and none without a usable grid position', () => {
    expect(towerRows(raceState()).map((r) => [r.driver.acronym, r.places])).toEqual([
      ['AAA', 2],
      ['BBB', -1],
      ['CCC', -1],
      ['DDD', 'none'],
      ['EEE', 0],
    ]);
    for (const GridPos of ['0', '100', 'P3', undefined]) {
      const s = raceState({ extra: { TimingAppData: { Lines: { '1': { GridPos } } } } });
      expect(towerRows(s)[0]?.places).toBe('none');
    }
  });

  it('is undefined in practice and qualifying, and the column is hidden there', () => {
    for (const s of [practiceState(), qualifyingState()]) {
      expect(towerRows(s).map((r) => r.places)).toEqual([undefined, undefined]);
      const html = renderToStaticMarkup(<Tower state={s} />);
      expect(html).not.toContain('Places since the start');
      expect(html).not.toContain('class="pc"');
    }
  });

  it('hides the column in a race without any grid position', () => {
    const html = renderToStaticMarkup(<Tower state={raceState({ extra: { TimingAppData: { Lines: {} } } })} />);
    expect(html).not.toContain('Places since the start');
    expect(html).not.toContain('tower-pc-');
  });

  const html = renderToStaticMarkup(<Tower state={raceState()} />);
  const row = (tla: string) => html.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';

  it('shows ▲ gained in --fg, ▼ lost and – muted, the glyphs hidden and the words for a screen reader', () => {
    expect(html).toContain(
      '<th scope="col" title="Places since the start"><span aria-hidden="true">±</span><span class="vh">Places since the start</span></th>',
    );
    expect(row('AAA')).toContain(
      '<td class="pc"><span><span aria-hidden="true">▲2</span><span class="vh">gained 2 places</span></span></td>',
    );
    expect(row('BBB')).toContain(
      '<td class="pc"><span class="muted"><span aria-hidden="true">▼1</span><span class="vh">lost 1 place</span></span></td>',
    );
    expect(row('EEE')).toContain(
      '<td class="pc"><span class="muted"><span aria-hidden="true">–</span><span class="vh">no change</span></span></td>',
    );
    expect(row('DDD')).toContain(
      '<td class="pc"><button type="button" class="note" popoverTarget="tower-pc-4" aria-describedby="tower-pc-4" ' +
        'title="No grid position in the feed">—</button>',
    );
  });

  it('adds the column to the legend, with the used set', () => {
    expect(html).toMatch(
      /<p class="legend">.*<span><span aria-hidden="true">▲<\/span> places since the start<\/span><span><span class="cmp used" aria-hidden="true"><\/span> used set<\/span><\/p>/,
    );
    const practice = renderToStaticMarkup(<Tower state={practiceState()} />);
    expect(practice).not.toContain('places since the start');
    expect(practice).toContain('used set</span></p>');
  });
});

describe('the tower in a race', () => {
  const html = renderToStaticMarkup(<Tower state={raceState()} />);
  const row = (tla: string) => html.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';

  it('names the leader "Leader", muted, with an Int reason', () => {
    expect(row('AAA')).toContain('<td><span class="muted">Leader</span></td>');
    expect(row('AAA')).toContain('<div popover="auto" id="tower-int-1" class="pop">Leader: no car ahead</div>');
  });

  it('marks an Int under a second bold with a dot and the words, not 1.000 s, a lapped or a retired car', () => {
    expect(row('BBB')).toContain('<td class="int close">+0.400<span class="vh">, within a second</span></td>');
    expect(html.match(/within a second/g)).toHaveLength(1);
    expect(row('CCC')).toContain('<td>+1.000</td>');
    expect(row('EEE')).toContain('<td>+0.200</td>');
  });

  it('marks nothing within a second outside races', () => {
    expect(renderToStaticMarkup(<Tower state={practiceState()} />)).not.toContain('within a second');
  });

  it('shows practice and qualifying leaders as "Fastest…", not "Leader"', () => {
    expect(renderToStaticMarkup(<Tower state={practiceState()} />)).not.toContain('Leader');
    expect(renderToStaticMarkup(<Tower state={qualifyingState()} />)).toContain('Fastest in Q2: no gap');
  });
});

describe('focus', () => {
  it('makes each driver a toggle button when the page handles focus, and raises the focused row', () => {
    const html = renderToStaticMarkup(<Tower state={raceState()} focus="2" onFocus={() => {}} />);
    expect(html).toContain('<button type="button" aria-pressed="false">AAA</button>');
    expect(html).toContain('<tr class="focus"><td>2</td>');
    expect(html).toContain('<button type="button" aria-pressed="true">BBB</button>');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // A retired, focused row keeps both classes.
    expect(renderToStaticMarkup(<Tower state={raceState()} focus="5" onFocus={() => {}} />)).toContain(
      '<tr class="out focus">',
    );
  });

  it('keeps the driver as text without a handler', () => {
    expect(renderToStaticMarkup(<Tower state={raceState()} focus="2" />)).not.toContain('aria-pressed');
  });

  it('gives the driver button the whole cell and the global 44 px tap target', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
    const at = css.indexOf('\n.tower .drv button {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('width: 100%;');
    expect(rule).not.toMatch(/min-(width|height)/);
  });
});

describe('the closing trend at the line (race, with a trend)', () => {
  const trend = new Map<number, { one: Trend; three: Trend }>([
    [2, { one: { delta: -400 }, three: { delta: 200 } }],
    [3, { one: { delta: 20 }, three: { missing: 5 } }],
    [4, { one: null, three: null }],
  ]);
  const html = renderToStaticMarkup(<Tower state={raceState()} trend={trend} />);
  const row = (tla: string) => html.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';
  const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);

  it('puts two headed columns right after Int, each read as an interval change at the line', () => {
    const i = headers.indexOf('Int');
    expect(headers.slice(i + 1, i + 3)).toEqual([
      '<span class="vh">Interval change at the line over </span>1 lap',
      '<span class="vh">Interval change at the line over </span>3 laps',
    ]);
    expect(headers[i + 3]).toBe('Last');
  });

  it('shows ▼ closing and ▲ pulling away with one decimal and the words', () => {
    expect(row('BBB')).toContain(
      '<td class="tr"><span><span aria-hidden="true">▼0.4</span><span class="vh">closing 0.4 s on the car ahead</span></span></td>' +
        '<td class="tr"><span class="muted"><span aria-hidden="true">▲0.2</span><span class="vh">car ahead pulling away 0.2 s</span></span></td>',
    );
  });

  it('shows a value that rounds to 0.0 without an arrow, as no change', () => {
    expect(row('CCC')).toContain(
      '<td class="tr"><span class="muted"><span aria-hidden="true">0.0</span><span class="vh">no change</span></span></td>',
    );
  });

  it('shows — with the lap behind a tap where a crossing is missing', () => {
    expect(row('CCC')).toContain(
      '<div popover="auto" id="tower-t3-3" class="pop">No crossing for both cars on lap 5</div>',
    );
    expect(row('CCC')).toMatch(/title="No crossing for both cars on lap 5">—<\/button>/);
  });

  it('leaves a blank trend, a car without an entry and the leader as empty cells', () => {
    expect(row('DDD')).toContain('<td class="tr"></td><td class="tr"></td>');
    expect(row('EEE')).toContain('<td class="tr"></td><td class="tr"></td>');
    expect(row('AAA')).toContain('<td class="tr"></td><td class="tr"></td>');
  });

  it('leaves a retired or stopped car blank, whatever its trend', () => {
    const own = { one: { delta: -400 }, three: { delta: 200 } };
    const out = renderToStaticMarkup(
      <Tower
        state={state}
        trend={
          new Map([
            [2, own],
            [3, own],
          ])
        }
      />,
    );
    const rowOf = (tla: string) => out.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';
    // 2 is stopped, 3 retired.
    expect(rowOf('BBB')).toContain('<td class="tr"></td><td class="tr"></td>');
    expect(rowOf('CCC')).toContain('<td class="tr"></td><td class="tr"></td>');
  });

  it('adds one item to the legend', () => {
    expect(html).toContain(
      'At the line: <span aria-hidden="true">▼</span> closing on the car ahead, <span aria-hidden="true">▲</span> car ahead pulling away, over 1 and 3 laps',
    );
  });

  it('has no trend columns without a trend, nor outside a race', () => {
    for (const none of [
      renderToStaticMarkup(<Tower state={raceState()} />),
      renderToStaticMarkup(<Tower state={practiceState()} trend={trend} />),
    ]) {
      expect(none).not.toContain('class="tr"');
      expect(none).not.toContain('Interval change');
      expect(none).not.toContain('At the line');
    }
  });
});
