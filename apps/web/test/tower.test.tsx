import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Obj } from '@f1/contracts';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Trend } from '../src/lib/crossings.ts';
import { fmtHm } from '../src/lib/time.ts';
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
    expect(html.match(/class="vh">, (overall|personal) best/g)).toHaveLength(3);
  });

  it('shows the gap and interval as text, and — with its reason in the title and the popover', () => {
    expect(row('AAA')).toContain(
      '<td class="gap"><span class="muted">Leader</span></td><td class="int"><button type="button" class="note" popoverTarget="tower-int-1" ' +
        'aria-describedby="tower-int-1" title="Leader: no car ahead">—</button>',
    );
    expect(row('BBB')).toMatch(
      /<td class="gap">\+1\.5<span class="badge"[^>]*>STOP<\/span><span class="vh">, stopped<\/span><\/td><td class="int">\+1\.5<\/td>/,
    );
    expect(row('DDD')).toContain(
      '<td class="gap"><button type="button" class="note" popoverTarget="tower-gap-4" aria-describedby="tower-gap-4" ' +
        'title="No gap in the feed">—</button><div popover="auto" id="tower-gap-4" class="pop">No gap in the feed</div></td>',
    );
    expect(row('DDD')).toMatch(/<div popover="auto" id="tower-int-4" class="pop">No interval in the feed<\/div>/);
    // A retired driver keeps the values the feed still sends.
    expect(row('CCC')).toMatch(
      /<td class="gap">\+9\.1<span class="badge"[^>]*>RET<\/span><span class="vh">, retired<\/span><\/td><td class="int">\+4\.2<\/td>/,
    );
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
    expect(row('CCC')).not.toMatch(/IN PIT|>OUT</);
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

  it('says RET or STOP in the Gap cell, a word that stays when forced colours drop the --muted row (#102)', () => {
    const badge = (word: string, words: string) =>
      `<span class="badge" aria-hidden="true">${word}</span><span class="vh">, ${words}</span></td>`;
    expect(row('CCC')).toContain(`+9.1${badge('RET', 'retired')}`);
    expect(row('BBB')).toContain(`+1.5${badge('STOP', 'stopped')}`);
    expect([row('AAA'), row('DDD')].join('')).not.toMatch(/RET|STOP/);
    // A retired car without a gap keeps its "Retired" reason behind the — and gets the word too; Retired wins.
    const one = (line: object) =>
      renderToStaticMarkup(
        <Tower state={{ ...state, TimingData: { Lines: { '1': { Line: 1, Position: '2', ...line } } } }} />,
      );
    expect(one({ Retired: true })).toContain(`>Retired</div>${badge('RET', 'retired')}`);
    expect(one({ Retired: true, Stopped: true })).not.toContain('STOP');
    // Under forced colours tr.out's --muted turns into CanvasText; the badge is text in a border, which forced
    // colours keep, and no forced-colours rule touches the tower's out rows or badges.
    const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
    const forced = css
      .split('@media (forced-colors: active) {')
      .slice(1)
      .map((b) => b.slice(0, b.indexOf('\n}\n')));
    expect(forced.length).toBeGreaterThan(0);
    for (const block of forced) expect(block).not.toMatch(/tr\.out|\.tower[^{]*\.badge/);
    expect(/\n\.badge \{[^}]*border: 1px solid/.test(css)).toBe(true);
  });

  it('waits while the feed shows another session, and shows the rows once it matches', () => {
    const waiting = renderToStaticMarkup(<Tower state={state} sessionKey={9964} />);
    expect(waiting).toBe('<p class="muted">Waiting for the session: the feed still shows the previous one.</p>');
    expect(renderToStaticMarkup(<Tower state={{ ...state, SessionInfo: undefined }} sessionKey={9965} />)).toContain(
      'Waiting for the session',
    );
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Timing tower"><table');
  });

  it('the waiting line gives the start time when the session has one', () => {
    const starts = '2026-10-25T20:00:00.000Z';
    expect(renderToStaticMarkup(<Tower state={state} sessionKey={9964} starts={starts} />)).toBe(
      `<p class="muted">Waiting for the session: the feed still shows the previous one. Starts about ${fmtHm(Date.parse(starts))}.</p>`,
    );
  });

  it('renders feed text as text', () => {
    const evil = renderToStaticMarkup(
      <Tower
        state={{
          SessionInfo: { Type: 'Race' },
          DriverList: { '5': { Tla: '<b>' } },
          TimingData: {
            NoEntries: { '0': 1 },
            Lines: { '5': { Line: 1, GapToLeader: '<i>', IntervalToPositionAhead: { Value: '&x' } } },
          },
        }}
      />,
    );
    expect(evil).toContain('&lt;b&gt;');
    expect(evil).toContain('<td class="gap">&lt;i&gt;</td><td class="int">&amp;x</td>');
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
    expect(row('AAA')).toContain('<td class="gap"><span class="muted">Leader</span></td>');
    expect(row('AAA')).toContain('<div popover="auto" id="tower-int-1" class="pop">Leader: no car ahead</div>');
  });

  it('marks an Int under a second bold with a dot and the words, not 1.000 s, a lapped or a retired car', () => {
    expect(row('BBB')).toContain('<td class="int close">+0.400<span class="vh">, within a second</span></td>');
    expect(html.match(/within a second/g)).toHaveLength(1);
    expect(row('CCC')).toContain('<td class="int">+1.000</td>');
    expect(row('EEE')).toContain('<td class="int">+0.200</td>');
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

describe('the knock-out line in qualifying', () => {
  // Six cars; NoEntries holds the cars per part, so NoEntries[SessionPart] is the last place through.
  const field = (part: number, o: { type?: string; name?: string; status?: string; entries?: Obj } = {}): Obj => ({
    SessionInfo: { Key: 9, Type: o.type ?? 'Qualifying', Name: o.name ?? 'Qualifying' },
    SessionStatus: { Status: o.status ?? 'Started' },
    DriverList: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), { Tla: `D${n}` }])),
    TimingData: {
      SessionPart: part,
      NoEntries: o.entries ?? { '0': 6, '1': 4, '2': 2 },
      Lines: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), { Line: n, Position: String(n) }])),
    },
  });
  const html = (s: Obj) => renderToStaticMarkup(<Tower state={s} />);
  const rows = (h: string) => h.split('<tr').filter((r) => r.includes('</th>') && r.includes('class="drv"'));
  const cutRows = (h: string) => rows(h).filter((r) => r.startsWith(' class="cut"'));
  const labels = (h: string) => [...h.matchAll(/<tr class="cutlabel">.*?<\/tr>/g)].map((m) => m[0]);

  it('sits under the 4th row in Q1 and the 2nd in Q2, the label row right after it', () => {
    for (const [part, last] of [
      [1, 'D4'],
      [2, 'D2'],
    ] as const) {
      const h = html(field(part));
      expect(cutRows(h)).toHaveLength(1);
      expect(cutRows(h)[0]).toContain(`>${last}</th>`);
      expect(labels(h)).toHaveLength(1);
      expect(h).toMatch(new RegExp(`class="cut">.*?>${last}</th>.*?</tr><tr class="cutlabel">`));
    }
  });

  it('keeps the other row classes beside cut', () => {
    const s = field(1);
    ((s.TimingData as Obj).Lines as Obj)['4'] = { Line: 4, Retired: true };
    expect(renderToStaticMarkup(<Tower state={s} focus="4" />)).toContain('<tr class="out focus cut">');
  });

  it('is absent in Q3, before Q1, outside qualifying and when every car goes through', () => {
    expect(labels(html(field(3)))).toEqual([]);
    expect(html(field(3))).not.toContain('class="cut');
    expect(html(field(0))).not.toContain('cutlabel');
    expect(html(field(1, { type: 'Race' }))).not.toContain('cutlabel');
    expect(html(field(1, { entries: { '1': 6 } }))).not.toContain('cutlabel');
    expect(html(field(1, { entries: { '1': 9 } }))).not.toContain('cutlabel');
    expect(html(field(1, { entries: {} }))).not.toContain('cutlabel');
  });

  it('says "<next part> above · drop zone below", whatever the session status', () => {
    expect(labels(html(field(1)))[0]).toContain('<span>Q2 above · drop zone below</span>');
    expect(labels(html(field(2)))[0]).toContain('<span>Q3 above · drop zone below</span>');
    for (const status of ['Finished', 'Finalised', 'Aborted'])
      expect(labels(html(field(1, { status })))[0]).toContain('<span>Q2 above · drop zone below</span>');
    expect(html(field(1, { status: 'Finished' }))).not.toContain('knocked out');
  });

  it('draws no line while the session is Inactive: before Q1 and between the parts', () => {
    expect(html(field(1, { status: 'Inactive' }))).not.toContain('cutlabel');
    expect(html(field(2, { status: 'Inactive' }))).not.toContain('cutlabel');
    expect(html(field(2, { status: 'Started' }))).toContain('cutlabel');
  });

  it('names the parts SQ in a sprint qualifying', () => {
    expect(labels(html(field(1, { name: 'Sprint Qualifying' })))[0]).toContain('SQ2 above · drop zone below');
    expect(labels(html(field(2, { name: 'Sprint Shootout', status: 'Finished' })))[0]).toContain(
      'SQ3 above · drop zone below',
    );
  });

  it('spans the header: colSpan equals the number of header cells', () => {
    const h = html(field(1));
    const head = h.slice(h.indexOf('<thead>'), h.indexOf('</thead>'));
    expect(labels(h)[0]).toContain(`<td colSpan="${head.split('<th ').length - 1}">`);
  });
});

describe('the finish-line speed', () => {
  it('shows only in the panel: FL is no tower cell', () => {
    const s: Obj = {
      SessionInfo: { Type: 'Race' },
      DriverList: { '1': { Tla: 'AAA' } },
      TimingData: { Lines: { '1': { Line: 1, Position: '1', Speeds: { FL: { Value: '333' } } } } },
      TimingStats: { Lines: { '1': { BestSpeeds: { FL: { Value: '333' } } } } },
    };
    expect(renderToStaticMarkup(<Tower state={s} />)).not.toContain('333');
  });
});

describe('mono times and the position face (#235)', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {\n`);
    return at < 0 ? undefined : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).trim();
  };
  const STACK = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
  const MONO = '.tower th.drv ~ td:not(.pc, .tr, :nth-last-child(-n + 2))';
  const RIGHT = '.tower td:is(.gap, .int)';

  it('names a mono face only in the --mono token; every other font is a stack variable or the system face', () => {
    expect(rule(':root')).toContain(`--mono: ${STACK};`);
    const rest = css.replace(`--mono: ${STACK};`, '').replaceAll('var(--mono)', '');
    expect(rest).not.toMatch(/mono|menlo|consolas|courier|monaco/i);
    const fonts = [...css.matchAll(/[\s;{]font(?:-family)?:\s*([^;]+);/g)].map((m) => m[1]);
    expect(fonts).toContain('var(--mono)');
    const allowed = ['var(--mono)', 'var(--display)', 'system-ui, sans-serif', 'inherit'];
    expect(fonts.filter((f) => !allowed.includes(f ?? ''))).toEqual([]);
  });

  it('sets Gap, Int, Last, Best and S1–S3 in --mono at 14 px and right-aligns Gap and Int, no other cell, and adds no style', async () => {
    expect(rule(MONO)).toBe('font-family: var(--mono);\n  font-size: 14px;');
    expect(rule(RIGHT)).toBe('text-align: right;');
    const trend = new Map<number, { one: Trend; three: Trend }>([[2, { one: { delta: -400 }, three: { delta: 200 } }]]);
    const window = new Window();
    const doc = window.document;
    // With and without the places and trend columns, a purple and a green last lap, badges and a close interval.
    for (const tower of [
      <Tower key="a" state={state} />,
      <Tower key="b" state={raceState()} trend={trend} />,
      <Tower key="c" state={practiceState()} />,
      <Tower key="d" state={qualifyingState()} />,
    ]) {
      const html = renderToStaticMarkup(tower);
      // The only style attributes are the driver cells' team colours, as custom properties.
      for (const [s] of html.matchAll(/ style="[^"]*"/g)) expect(s).toMatch(/^ style="(--team(-l)?:[^;"]+;?)+"$/);
      doc.body.innerHTML = html;
      const heads = [...doc.querySelectorAll('thead th')].map((th) => th.textContent);
      const rows = [...doc.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('th.drv'));
      expect(rows.length).toBeGreaterThan(0);
      const cells = (tr: (typeof rows)[number], selector: string) =>
        [...tr.children].flatMap((c, i) => (c.matches(selector) ? [heads[i]] : []));
      for (const tr of rows) {
        expect(cells(tr, MONO)).toEqual(['Gap', 'Int', 'Last', 'Best', 'S1', 'S2', 'S3']);
        expect(cells(tr, RIGHT)).toEqual(['Gap', 'Int']);
      }
    }
    await window.happyDOM.close();
  });

  it('keeps the purple box, the green bold and the close interval on a mono cell, the words and badges in the system face', () => {
    // The mono rule sets the face and size only. A mono face gives bold the advance of regular, so a personal best
    // or a close interval never widens its column.
    expect(rule('.t-purple')).toMatch(/font-weight: 700;[\s\S]*outline: 2px solid currentColor;/);
    expect(rule('.t-green')).toContain('font-weight: 700;');
    expect(rule('.tower td.int.close')).toBe('font-weight: 700;');
    expect(renderToStaticMarkup(<Tower state={state} />)).toMatch(
      /<td class="t-purple">1:30\.000.*<td class="t-green">1:31\.000/,
    );
    expect(renderToStaticMarkup(<Tower state={raceState()} />)).toContain('<td class="int close">+0.400');
    expect(rule('.tower td :is(.muted, .badge, .pop)')).toBe('font-family: system-ui, sans-serif;');
  });

  it('sets the position in --display, 18 px bold, centred in its sticky 48 px column, and not the cut label', () => {
    expect(css).toContain(
      '\n.tower thead tr:first-child th:first-child,\n.tower td:first-child {\n  width: 48px;\n  min-width: 48px;\n  text-align: center;\n}',
    );
    expect(css).toContain(
      '.tower td:first-child {\n  position: sticky;\n  left: 0;\n  background: var(--bg);\n  font-family: var(--display);\n  font-size: 18px;\n  font-weight: 700;\n}',
    );
    expect(rule('.tower tr.cutlabel td:first-child')).toContain('font: inherit;');
  });
});

describe('the phone column order (#237)', () => {
  const trend = new Map<number, { one: Trend; three: Trend }>([[2, { one: { delta: -400 }, three: { delta: 200 } }]]);
  const s = raceState();
  Object.assign((s.TimingData as { Lines: Record<string, object> }).Lines['2'] ?? {}, {
    LastLapTime: { Value: '1:31.111' },
    BestLapTime: { Value: '1:30.222' },
  });
  const window = new Window();
  const words = (h: string) => h.replace(/(Places since the start|Interval change at the line over )/, '');
  /** The heads and BBB's cells, with matchMedia answering `(max-width: 640px)` with `matches`, or missing. */
  const render = (matches: boolean | undefined) => {
    if (matches !== undefined)
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: matches && q === '(max-width: 640px)' }));
    try {
      window.document.body.innerHTML = renderToStaticMarkup(<Tower state={s} trend={trend} />);
    } finally {
      vi.unstubAllGlobals();
    }
    const doc = window.document;
    const row = [...doc.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('th.drv')?.textContent === 'BBB');
    return {
      heads: [...doc.querySelectorAll('thead th')].map((th) => words(th.textContent ?? '')),
      cells: [...(row?.children ?? [])],
    };
  };

  it('runs Pos, Driver, Gap, Int, Last, Best, ±, 1 lap, 3 laps under 640 px, the cells under their heads', () => {
    const { heads, cells } = render(true);
    expect(heads).toEqual([
      'Pos',
      'Driver',
      'Gap',
      'Int',
      'Last',
      'Best',
      '±',
      '1 lap',
      '3 laps',
      'S1',
      'S2',
      'S3',
      'Tyre',
      'Pits',
    ]);
    expect(cells).toHaveLength(heads.length);
    expect(cells[2]?.textContent).toBe('+0.400');
    expect(cells[3]?.textContent).toBe('+0.400, within a second');
    expect(cells[4]?.textContent).toBe('1:31.111');
    expect(cells[5]?.textContent).toBe('1:30.222');
    expect(cells.slice(6, 9).map((c) => c.className)).toEqual(['pc', 'tr', 'tr']);
  });

  it('keeps the wide order without the match or without matchMedia', () => {
    for (const matches of [false, undefined]) {
      const { heads, cells } = render(matches);
      expect(heads.slice(0, 9)).toEqual(['Pos', 'Driver', '±', 'Gap', 'Int', '1 lap', '3 laps', 'Last', 'Best']);
      expect(cells[7]?.textContent).toBe('1:31.111');
    }
  });

  it('marks Gap and Int by class, so no rule depends on their place', () => {
    const { cells } = render(true);
    expect(cells[2]?.classList.contains('gap')).toBe(true);
    expect(cells[3]?.classList.contains('int')).toBe(true);
  });
});
