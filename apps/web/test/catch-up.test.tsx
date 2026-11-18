import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CatchUpEvent } from '../src/lib/replay.ts';
import { CatchUp } from '../src/views/CatchUp.tsx';

// The catch-up dialog (#234, A§13) as markup: synthetic events, data as props. The interaction is in player.test.tsx.

const T0 = Date.parse('2026-10-25T20:00:00Z'); // 21:00:00 in Amsterdam
const min = (m: number) => T0 + m * 60_000;
const driver = (number: number, acronym: string, team: string | null = null) => ({
  number,
  acronym,
  name: null,
  team,
});
const EVENTS: CatchUpEvent[] = [
  { kind: 'fastest', t: min(1), driver: driver(1, 'AAA', '#3671C6'), lap: 3, ms: 85_619, part: null },
  {
    kind: 'incident',
    t: min(2),
    text: 'TURN 5 INCIDENT INVOLVING CAR 3 (CCC) NOTED - LEAVING THE TRACK',
    lap: 6,
    noted: true,
  },
  { kind: 'stop', t: min(3), driver: driver(2, 'BBB'), lap: 12, compound: 'HARD' },
  { kind: 'deleted', t: min(4), driver: driver(3, 'CCC'), lap: 10 },
  { kind: 'flag', t: min(5), flag: 'sc', lap: 13 },
  { kind: 'flag', t: min(6), flag: 'red', lap: null },
  { kind: 'fastest', t: min(7), driver: driver(2, 'BBB'), lap: 9, ms: 80_500, part: 'Q2' },
];
const html = (events = EVENTS, laps: [number, number] | null = [1, 17], minutes = 27) =>
  renderToStaticMarkup(
    <CatchUp events={events} laps={laps} minutes={minutes} year={2026} onReplay={() => {}} onClose={() => {}} />,
  );
/** The markup of each list row, in order. */
const rows = (markup: string) => [...markup.matchAll(/<li class="ev">(.*?)<\/li>/g)].map((m) => m[1] ?? '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, '');

describe('CatchUp', () => {
  it('heads the dialog with the window, the title and the count, and closes with no value', () => {
    const h = html();
    expect(h).toMatch(/^<dialog class="catchup" aria-labelledby="([^"]+)"><form method="dialog">/);
    expect(h).toContain('<p class="eyebrow">Catch-up · L1–L17 · 27 min</p>');
    expect(h).toMatch(/<h2 id="[^"]+">While you were away<\/h2>/);
    expect(h).toContain('7 events before this point. Nothing after it is shown.');
    expect(h).toContain('<button type="submit" value="" aria-label="Close">×</button>');
    expect(h).toContain('<button type="submit" value="" class="primary">Continue at L17</button>');
    // Outside a race: no laps.
    const practice = html(EVENTS.slice(0, 1), null, 1);
    expect(practice).toContain('<p class="eyebrow">Catch-up · 1 min</p>');
    expect(practice).toContain('1 event before this point.');
    expect(practice).toContain('>Continue</button>');
  });

  it('a chip per kind present, all pressed (D2), with its count', () => {
    const chips = [...html().matchAll(/<button type="button" aria-pressed="(\w+)">(.*?)<\/button>/g)];
    expect(chips.map((c) => [c[1], text(c[2] ?? '')])).toEqual([
      ['true', 'Fastest laps 2'],
      ['true', 'Investigations 1'],
      ['true', 'Pit stops 1'],
      ['true', 'Deleted laps 1'],
      ['true', 'Flags 2'],
    ]);
    expect(html(EVENTS.slice(0, 1))).not.toContain('Pit stops');
  });

  it('a row per event, oldest first: the time, the tag, the facts and a replay button with its T', () => {
    const r = rows(html());
    expect(r).toHaveLength(7);
    expect(r.map((x) => text(x))).toEqual([
      '21:01:00Fastest lapAAA · L3 1:25.619, overall best›',
      '21:02:00InvestigationTURN 5 INCIDENT INVOLVING CAR 3 (CCC) NOTED - LEAVING THE TRACK · L6›',
      '21:03:00Pit stopBBB · L12 Hhard tyres›',
      '21:04:00Lap deletedCCC · L10›',
      '21:05:00SCSafety car · L13›',
      '21:06:00REDRed flag›',
      '21:07:00Fastest lapBBB · Q2 L9 1:20.500, overall best›',
    ]);
    // The fastest-lap time is the overall best's box; the team bar is .drv with the team's custom properties.
    expect(r[0]).toContain('<b class="drv" style="--team:#3671C6;--team-l:');
    expect(r[0]).toContain('<span class="t-purple">1:25.619</span><span class="vh">, overall best</span>');
    // Colour is data: the investigation and SC amber, the red flag live, every other tag neutral.
    expect(r.map((x) => /<span class="(tag[^"]*)">/.exec(x)?.[1])).toEqual([
      'tag',
      'tag warn',
      'tag',
      'tag',
      'tag warn',
      'tag live',
      'tag',
    ]);
    expect(r[2]).toContain('<span class="cmp cmp-hard" aria-hidden="true">H</span><span class="vh">hard tyres</span>');
    expect(r[0]).toContain(`<button type="submit" value="${min(1)}" aria-label="Replay from 21:01:00">›</button>`);
  });

  it('the legend shows the overall-best box, only when a fastest lap is listed', () => {
    expect(html()).toContain(
      '<ul class="legend"><li><span class="t-purple" aria-hidden="true">0:00.000</span> overall best at the time</li></ul>',
    );
    const none = html(EVENTS.filter((e) => e.kind !== 'fastest'));
    expect(none).not.toContain('class="legend"');
    expect(none).toContain('class="primary">Continue at L17</button>');
  });

  it('an empty window says so, with no chips and no list', () => {
    const h = html([]);
    expect(h).toContain('<p class="muted">Nothing happened before this point.</p>');
    expect(h).not.toContain('aria-pressed');
    expect(rows(h)).toEqual([]);
  });

  it('sets no style but the team custom properties', () => {
    const styles = [...html().matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(styles.length).toBeGreaterThan(0);
    for (const v of styles) expect(v).toMatch(/^(--(team|team-l|x|w):[^;]*;?)+$/);
  });
});
