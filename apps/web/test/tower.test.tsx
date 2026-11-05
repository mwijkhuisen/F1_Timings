import type { Obj } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tower, towerRows } from '../src/views/Tower.tsx';

// The timing tower (A§13) on a hand-built, synthetic feed state.

const seg = (...codes: number[]) => Object.fromEntries(codes.map((Status, i) => [String(i), { Status }]));
const state: Obj = {
  SessionInfo: { Key: 9965 },
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
        GapToLeader: '',
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
    expect(rows[1]).toMatchObject({ gap: '+1.5', interval: '+1.5', last: '1:31.000' });
    expect(rows[0]).toMatchObject({ last: '1:30.000', best: '1:29.000' });
  });

  it('takes the tyre from the last stint', () => {
    expect(rows[0]?.tyre).toMatchObject({ Compound: 'SOFT', TotalLaps: 7 });
    expect(rows[2]?.tyre).toBeUndefined();
  });
});

describe('the tower', () => {
  const html = renderToStaticMarkup(<Tower state={state} sessionKey={9965} />);
  const row = (tla: string) => html.split('<tr').find((r) => r.includes(`>${tla}</th>`)) ?? '';

  it('colours the last lap purple for the overall best and green for a personal best', () => {
    expect(row('AAA')).toContain('<td class="t-purple">1:30.000</td>');
    expect(row('BBB')).toContain('<td class="t-green">1:31.000</td>');
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
      <Tower state={{ DriverList: { '5': { Tla: '<b>' } }, TimingData: { Lines: { '5': { Line: 1 } } } }} />,
    );
    expect(evil).toContain('&lt;b&gt;');
  });
});
