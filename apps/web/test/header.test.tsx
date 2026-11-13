import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionDetail } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Route } from '../src/lib/routes.ts';
import type { Theme } from '../src/lib/theme.ts';
import { HeaderView } from '../src/views/Header.tsx';
import { SessionHead } from '../src/views/SessionHead.tsx';
import { fetched } from './laps.ts';
import { live, recordings, season, seasons } from './season-data.ts';

// The header's switcher and links, and the session head (A§13, P4c), on the hand-built 2026.

const SP = '/2026/1320-sao-paulo';
const header = (route: Route | null, theme: Theme = 'dark') =>
  renderToStaticMarkup(
    <HeaderView route={route} seasons={seasons} season={route ? season : undefined} theme={theme} onTheme={() => {}} />,
  );
/** The opening tag of the first element with this attribute. */
const tag = (html: string, attr: string) => html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0];

describe('the session switcher', () => {
  const html = header({ id: 'session', year: 2026, meeting: 1320, session: 9104, view: 'compare' });

  it('steps to the previous and next session, skipping a cancelled one and keeping the view', () => {
    const prev = tag(html, 'aria-label="Previous session"');
    expect(prev).toContain(`href="${SP}/9103-sprint-qualifying/compare"`);
    expect(prev).toContain('title="São Paulo Grand Prix · Sprint Qualifying"');
    expect(tag(html, 'aria-label="Next session"')).toContain(`href="${SP}/9105-sprint/compare"`);
  });

  it('opens each menu as a native popover', () => {
    for (const id of ['menu-season', 'menu-meeting', 'menu-session']) {
      expect(html).toContain(`popoverTarget="${id}"`);
      expect(html).toContain(`<div popover="auto" id="${id}" class="pop menu">`);
    }
    expect(html).toContain('aria-label="Meeting São Paulo">São Paulo <span class="caret" aria-hidden="true">▾</span>');
  });

  it('lists the seasons, the current one marked', () => {
    expect(html).toContain('<a aria-current="page" href="/2026">2026</a>');
    expect(html).toContain('<a href="/2027">2027</a>');
    expect(html).toContain('<a href="/2025">2025</a>');
  });

  it('lists the meetings, each to the session of the same name or its first, a cancelled one struck', () => {
    expect(html).toContain(`<a aria-current="page" href="${SP}/9104-practice-3/compare">São Paulo</a>`);
    expect(html).toContain('<a href="/2026/1310-mexico-city/9001-qualifying/compare">Mexico City</a>');
    expect(html).toContain('<a href="/2026/1300-pre-season-testing/9000-day-1/compare">Pre-Season Testing</a>');
    expect(html).toContain('<li><s>Emilia Romagna<span class="vh"> (cancelled)</span></s></li>');
    expect(html).not.toMatch(/href="[^"]*1315/);
  });

  it("lists the meeting's sessions, keeping the view, a cancelled one struck", () => {
    expect(html).toContain(`<a aria-current="page" href="${SP}/9104-practice-3/compare">Practice 3</a>`);
    expect(html).toContain(`<a href="${SP}/9107-race/compare">Race</a>`);
    expect(html).toContain('<li><s>Practice 2<span class="vh"> (cancelled)</span></s></li>');
    expect(html).not.toMatch(/href="[^"]*9102/);
  });

  it('shows only the season menu on a year page, and "Season" elsewhere', () => {
    const year = header({ id: 'year', year: 2026 });
    expect(year).toContain('<a aria-current="page" href="/2026">2026</a>');
    expect(year).not.toContain('menu-meeting');
    expect(year).not.toContain('class="step"');
    const status = header({ id: 'status' });
    expect(status).toContain('<button type="button" popoverTarget="menu-season">Season <span class="caret"');
    expect(status).not.toContain('aria-current="page" href="/2026"');
  });

  it('falls back to the year menu for a session missing from the season', () => {
    const missing = header({ id: 'session', year: 2026, meeting: 1320, session: 1, view: 'laps' });
    expect(missing).toContain('<a aria-current="page" href="/2026">2026</a>');
    expect(missing).not.toContain('class="step"');
    expect(missing).not.toContain('menu-meeting');
    expect(missing).not.toContain('menu-session');
  });

  it('has no steps on a cancelled session, but keeps its meeting and session menus', () => {
    const cancelled = header({ id: 'session', year: 2026, meeting: 1320, session: 9102, view: 'laps' });
    expect(cancelled).toContain('<a aria-current="page" href="/2026">2026</a>');
    expect(cancelled).not.toContain('class="step"');
    expect(cancelled).toContain('popoverTarget="menu-meeting"');
    expect(cancelled).toContain('aria-label="Session Practice 2">Practice 2 <span class="caret"');
  });
});

describe('the page links', () => {
  const links = (route: Route | null, theme?: Theme) => {
    const html = header(route, theme);
    return html.slice(html.indexOf('aria-label="Pages"'));
  };
  const routes: [string, Route | null, string | null][] = [
    ['/', { id: 'latest' }, null],
    ['/2026', { id: 'year', year: 2026 }, null],
    ['a session', { id: 'session', year: 2026, meeting: 1320, session: 9104, view: 'laps' }, null],
    ['/live', { id: 'live' }, '/live'],
    ['/replay', { id: 'replays' }, '/replay'],
    ['/replay/41', { id: 'replay', recording: 41 }, null],
    ['/status', { id: 'status' }, '/status'],
    ['not found', null, null],
  ];

  it.each(routes)('%s: Live, Replays and Status, the current one marked', (_name, route, current) => {
    const html = links(route);
    for (const [to, text] of [
      ['/live', 'Live'],
      ['/replay', 'Replays'],
      ['/status', 'Status'],
    ])
      expect(html).toContain(`${to === current ? 'aria-current="page" ' : ''}href="${to}">${text}</a>`);
    expect(html.match(/aria-current/g)?.length ?? 0).toBe(current ? 1 : 0);
  });

  it('ends with the moon, pressed on the dark theme only', () => {
    for (const [theme, pressed] of [
      ['dark', true],
      ['light', false],
    ] as const)
      expect(links({ id: 'live' }, theme)).toMatch(
        new RegExp(
          `Status</a></nav><button type="button" class="theme" aria-pressed="${pressed}" aria-label="Dark theme"`,
        ),
      );
  });
});

describe('the session head', () => {
  const detail = SessionDetail.parse({
    session: {
      session_key: 9103,
      meeting_key: 1320,
      type: 'Practice',
      name: 'Sprint Qualifying',
      date_start: '2026-11-06T18:30:00.000Z',
      date_end: '2026-11-06T19:30:00.000Z',
      ingest_state: 'fetched',
      is_cancelled: false,
      ...fetched,
    },
    meeting: {
      meeting_key: 1320,
      year: 2026,
      name: 'São Paulo Grand Prix',
      official_name: null,
      location: 'Interlagos',
      country_code: 'BRA',
      circuit_short_name: 'Interlagos',
      gmt_offset: '-03:00:00',
      date_start: null,
      date_end: null,
      is_cancelled: false,
    },
    drivers: [],
    results: [],
  });
  const head = (props: Partial<Parameters<typeof SessionHead>[0]>) =>
    renderToStaticMarkup(
      <SessionHead detail={detail} season={season} recordings={recordings} view="stints" {...props} />,
    );
  const html = head({});

  it('has the year, round and place above the meeting, with the session boxed in the h1', () => {
    expect(html).toContain('<p class="eyebrow">2026 · Round 2 · Interlagos</p>');
    expect(html).toContain('<h1 tabindex="-1">São Paulo Grand Prix <span class="kind">Sprint Qualifying</span></h1>');
  });

  it("pills the weekend's sessions, keeping the view, the current one marked and a cancelled one struck", () => {
    expect(html).toContain('<nav class="wk" aria-label="This weekend&#x27;s sessions">');
    expect(html).toContain(`<a aria-current="page" href="${SP}/9103-sprint-qualifying/stints">SQ</a>`);
    expect(html).toContain(`<a href="${SP}/9101-practice-1/stints">FP1</a>`);
    expect(html).toContain('<s>FP2<span class="vh"> (cancelled)</span></s>');
    expect(html).not.toMatch(/href="[^"]*9102/);
  });

  it('links the replay only when the session has a recording', () => {
    expect(html).toContain('<a href="/replay/41">Replay</a>');
    expect(head({ recordings: [] })).not.toContain('/replay/');
    expect(head({ recordings: null })).not.toContain('/replay/');
  });

  it('says on the meta line whether the data is final or provisional, and nothing before the first fetch (#99)', () => {
    const meta = (session: Partial<SessionDetail['session']>) =>
      /<p class="muted">([\s\S]*?)<\/p>/
        .exec(head({ detail: { ...detail, session: { ...detail.session, ...session } }, recordings: [] }))?.[1]
        ?.replace(/<!-- -->/g, '');
    expect(meta({})).toBe('Fri 6 Nov 2026, 19:30 · Interlagos · data provisional');
    expect(meta({ ingest_state: 'final' })).toBe('Fri 6 Nov 2026, 19:30 · Interlagos · data final');
    expect(meta({ ingest_state: 'failed', fetch_count: 1 })).toContain(' · data provisional');
    expect(meta({ ingest_state: 'scheduled', fetch_count: 0 })).toBe('Fri 6 Nov 2026, 19:30 · Interlagos');
  });

  it('shows "Live now · Follow" only while /live names an open recording of this session', () => {
    const open = { ...live, session: live.session && { ...live.session, session_key: 9103 } };
    expect(head({ live: open })).toContain(' · Live now · <a href="/live">Follow</a></p>');
    expect(head({ live })).not.toContain('Follow'); // another session's recording
    expect(
      head({
        live: { ...open, recording: open.recording && { ...open.recording, ended_at: '2026-11-06T19:40:00.000Z' } },
      }),
    ).not.toContain('Follow');
    expect(head({ live: null })).not.toContain('Follow');
  });

  it('leaves out the round and the pills until the season loads', () => {
    const bare = head({ season: null });
    expect(bare).toContain('<p class="eyebrow">2026 · Interlagos</p>');
    expect(bare).not.toContain('class="wk"');
  });
});

describe('the popover position (#72)', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  /** The declarations of the rule whose selector is exactly `selector`, from `from`. */
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`\n${selector} {`, from);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('anchors at the button under @supports, and leaves the base rule centred', () => {
    const at = css.indexOf('@supports (position-area: bottom) {');
    expect(at).toBeGreaterThanOrEqual(0);
    const pop = rule('  .pop', at);
    expect(pop).toContain('position-anchor: auto;');
    expect(pop).toContain('position-area: bottom span-right;');
    expect(pop).toMatch(/position-try-fallbacks:[^;]*flip-inline[^;]*flip-block/);
    expect(pop).toContain('inset: auto;');
    expect(pop).toContain('margin: 4px 8px 4px 0;');
    // An unsupported browser keeps the browser's centred popover.
    expect(rule('.pop')).not.toMatch(/position-|inset|margin/);
  });
});
