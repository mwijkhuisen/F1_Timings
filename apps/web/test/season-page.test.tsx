// @vitest-environment happy-dom
import { type Live, Recordings } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { Season, SeasonView, Start } from '../src/views/Season.tsx';
import { FakeCaches } from './caches.ts';
import { sessionDetail } from './laps.ts';
import { live, NOW, recordings, season, seasons } from './season-data.ts';

// The season page (A§13, P4c): this weekend first with every state in words, Up next, the other meetings as cards,
// and never a result. The static renders run in happy-dom too, which renderToStaticMarkup does not mind.

const render = (now: number, l: Live | null = live) =>
  renderToStaticMarkup(<SeasonView year={2026} season={season} live={l} recordings={recordings} now={now} />);

describe('the season page', () => {
  // The view takes `now` as a prop; the clock is faked only so nothing else can leak in.
  let html = '';
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    html = render(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('heads the page with the year and this weekend, its round of the season and country', () => {
    expect(html).toContain('<h1 tabindex="-1">2026</h1>');
    expect(html).toContain('<section class="weekend" aria-label="This weekend">');
    expect(html).toContain('<p class="eyebrow">This weekend · Round 2 of 3 · BRA</p><h2>São Paulo Grand Prix</h2>');
    expect(html).toContain('Interlagos · Amsterdam time, track time beside it');
  });

  it('gives every session of the weekend its state in words', () => {
    expect(html).toContain('<span class="state ready">laps ready</span>');
    expect(html).toContain('<span class="state cancelled">cancelled</span>');
    expect(html).toContain('<span class="state recorded">recorded</span>');
    expect(html).toContain('<span class="state pending">laps pending</span>');
    expect(html).toContain('<span class="state live">live now · <a href="/live">Follow</a></span>');
    expect(html).toContain('<span class="state next">next</span>');
    expect(html).toContain('<span class="state scheduled">scheduled</span>');
    // The open recording is followed live, never offered as a replay.
    expect(html).not.toContain('/replay/42');
  });

  it('links each session to its laps, and strikes a cancelled one without a link', () => {
    expect(html).toContain('<a href="/2026/1320-sao-paulo/9101-practice-1/laps">Practice 1</a>');
    // The weekend row says "cancelled" in its state, so its name needs no hidden word.
    expect(html).toContain('<li><s>Practice 2</s>');
    expect(html).not.toMatch(/href="[^"]*9102/);
    // A cancelled meeting's sessions are not linked either.
    expect(html).toContain('<h3><s>Emilia Romagna Grand Prix<span class="vh"> (cancelled)</span></s></h3>');
    expect(html).toContain('<li><s>Race</s>');
    expect(html).not.toMatch(/href="[^"]*9010/);
  });

  it('links a recorded session to its replay with Laps beside it, in This weekend', () => {
    expect(html).toContain(
      '<span class="name"><a href="/replay/41">Sprint Qualifying</a><span class="laps"> · <a href="/2026/1320-sao-paulo/9103-sprint-qualifying/laps">Laps</a></span></span>',
    );
    // An open recording is not a replay: the live Sprint links to its laps only.
    expect(html).toContain('<a href="/2026/1320-sao-paulo/9105-sprint/laps">Sprint</a>');
  });

  it('shows the start in Amsterdam time with the time at the track beside it', () => {
    expect(html).toContain(
      '<time dateTime="2026-11-06T14:30:00.000Z">Fri 6 Nov 2026, 15:30</time> · 11:30 at the track',
    );
  });

  it('counts down to the next session of the weekend, with a link to Live', () => {
    expect(html).toContain('<p class="eyebrow">Up next</p><p class="count">3 h 30 min</p>');
    expect(html).toContain('Qualifying · <time dateTime="2026-11-07T18:00:00.000Z">');
    expect(html).toContain('<a class="btnlink" href="/live">Open Live</a>');
  });

  it('lists the other meetings as cards in season order, with their round and country', () => {
    expect(html).toContain('<h2 class="eyebrow sect">The rest of 2026</h2>');
    const cards = [...html.matchAll(/<article class="meeting"><p class="eyebrow">([^<]*)<\/p><h3>(.*?)<\/h3>/g)];
    expect(cards.map(([, eyebrow, name]) => `${eyebrow} | ${name}`)).toEqual([
      'BRN | Pre-Season Testing',
      'Round 1 · MEX | Mexico City Grand Prix',
      'ITA | <s>Emilia Romagna Grand Prix<span class="vh"> (cancelled)</span></s>',
      'Round 3 · USA | Las Vegas Grand Prix',
    ]);
    expect(html).toContain('<a href="/2026/1310-mexico-city/9002-race/laps">Race</a>');
  });

  it('does the same on a card, and links a session without a recording to its laps', () => {
    const ended = Recordings.parse([
      {
        id: 43,
        session_key: 9002,
        year: 2026,
        meeting_name: 'Mexico City Grand Prix',
        session_name: 'Race',
        session_type: 'Race',
        date_start: '2026-10-25T20:00:00.000Z',
        started_at: '2026-10-25T19:00:00.000Z',
        ended_at: '2026-10-25T22:10:00.000Z',
        complete: true,
      },
      ...recordings,
    ]);
    const card = renderToStaticMarkup(
      <SeasonView year={2026} season={season} live={live} recordings={ended} now={NOW} />,
    );
    expect(card).toContain(
      '<span class="name"><a href="/replay/43">Race</a><span class="laps"> · <a href="/2026/1310-mexico-city/9002-race/laps">Laps</a></span></span><time class="when" dateTime="2026-10-25T20:00:00.000Z">',
    );
    expect(card).toContain('<span class="state recorded">recorded</span>');
    // Mexico's Qualifying has no recording: its name is its laps link, as before.
    expect(html).toContain('<li><a href="/2026/1310-mexico-city/9001-qualifying/laps">Qualifying</a>');
    expect(html).toContain('<li><a href="/2026/1320-sao-paulo/9101-practice-1/laps">Practice 1</a>');
  });

  it('gives every session on a card its state in words', () => {
    const cards = html.slice(html.indexOf('<div class="meetings">'));
    expect(cards.match(/<li>/g)).toHaveLength(cards.match(/<span class="state /g)?.length ?? -1);
    expect(cards).toContain('<li><s>Race</s><time class="when" dateTime="2026-11-01T13:00:00.000Z">');
    expect(cards).toContain('<span class="state cancelled">cancelled</span>');
    expect(cards).toContain('<span class="state ready">laps ready</span>');
    expect(cards).toContain('<span class="state scheduled">scheduled</span>');
  });

  it('says "track time beside it" only with a parsable gmt_offset', () => {
    const bad = season.map((m) => ({ ...m, gmt_offset: 'abc' }));
    const html = renderToStaticMarkup(
      <SeasonView year={2026} season={bad} live={live} recordings={recordings} now={NOW} />,
    );
    expect(html).toContain('Interlagos · Amsterdam time</p>');
    expect(html).not.toContain('at the track');
  });

  it('has no weekend and no Up next after the last race', () => {
    // Nothing recording: an open recording would keep its weekend in progress.
    const after = render(Date.parse('2026-12-01T00:00:00.000Z'), null);
    expect(after).not.toContain('This weekend');
    expect(after).not.toContain('Up next');
    expect(after).toContain('<h2 class="eyebrow sect">Meetings</h2>');
  });
});

describe('the season page renders no result', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  // The machine-readable instants in dateTime carry milliseconds (":00.000Z"), which are not results.
  it.each([
    ['during a weekend', NOW],
    ['after the last race', Date.parse('2026-12-01T00:00:00.000Z')],
  ])('%s', (_name, now) => {
    const html = render(now).replace(/dateTime="[^"]*"/g, '');
    expect(html).not.toMatch(/\d+:\d\d\.\d{3}/); // a lap time
    expect(html).not.toMatch(/[+−-]\d+\.\d{3}/); // a gap
    expect(html).not.toMatch(/\bP\d{1,2}\b/); // a position
    expect(html).not.toMatch(/position|pole|winner|fastest/i);
  });
});

// A real tree in happy-dom on msw: the page asks for these and nothing under /sessions/.
describe('the season page requests', () => {
  let root: Root;
  let host: HTMLElement;
  let client: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    client.clear();
  });

  const mount = (ui: ReactNode) => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

  /** Every pathname requested during the test. */
  const requested = () => {
    const paths: string[] = [];
    const listener = ({ request }: { request: Request }) => {
      paths.push(new URL(request.url).pathname);
    };
    server.events.on('request:start', listener);
    onTestFinished(() => server.events.removeListener('request:start', listener));
    return paths;
  };

  it('/2026 requests the season, /live and /recordings only', async () => {
    server.use(
      http.get('*/api/v1/seasons/2026', () => HttpResponse.json(season)),
      http.get('*/api/v1/live', () => HttpResponse.json(live)),
      http.get('*/api/v1/recordings', () => HttpResponse.json(recordings)),
    );
    const paths = requested();
    mount(<Season year={2026} />);
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('2026'));
    await vi.waitFor(() => expect(paths).toHaveLength(3));
    expect([...paths].sort()).toEqual(['/api/v1/live', '/api/v1/recordings', '/api/v1/seasons/2026']);
  });

  const start = async (recording: Live['recording']) => {
    history.replaceState(null, '', '/');
    server.use(
      http.get('*/api/v1/seasons', () => HttpResponse.json(seasons)),
      http.get('*/api/v1/live', () => HttpResponse.json({ ...live, recording })),
    );
    const paths = requested();
    mount(<Start />);
    await vi.waitFor(() => expect(location.pathname).not.toBe('/'));
    expect(paths.filter((p) => p.startsWith('/api/v1/sessions/'))).toEqual([]);
    return location.pathname;
  };

  it('/ goes to the newest season with a session when nothing is recording', async () => {
    expect(await start(live.recording && { ...live.recording, ended_at: '2026-11-07T15:10:00.000Z' })).toBe('/2026');
  });

  it('/ goes to /live while a recording is open', async () => {
    expect(await start(live.recording)).toBe('/live');
  });

  // #121, D4: the worker's caches hold one final session's detail.
  const saved = async () => {
    const caches = new FakeCaches();
    const d = sessionDetail('Race', 'Race');
    const body = { ...d, session: { ...d.session, session_key: 11002 } };
    await (await caches.open('f1-0123456789ab')).put('/api/v1/sessions/11002', Response.json(body));
    vi.stubGlobal('caches', caches.storage);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    return vi.spyOn(caches, 'keys');
  };

  it('/ lists the saved sessions under the error when /seasons fails', async () => {
    history.replaceState(null, '', '/');
    await saved();
    server.use(
      http.get('*/api/v1/seasons', () => new HttpResponse(null, { status: 503 })),
      http.get('*/api/v1/live', () => HttpResponse.json(live)),
    );
    mount(<Start />);
    await vi.waitFor(() => expect(host.querySelector('section[aria-label="Saved on this device"]')).not.toBeNull());
    expect(host.querySelector('h2')?.textContent).toBe('Saved on this device');
    expect(host.querySelector('section a')?.getAttribute('href')).toBe('/2026/1300-mexico-city/11002-race/laps');
    expect(location.pathname).toBe('/');
  });

  it('/ never reads the saved sessions when /seasons answers', async () => {
    const keys = await saved();
    expect(await start(live.recording)).toBe('/live');
    expect(keys).not.toHaveBeenCalled();
  });
});

// The page keeps its own clock and refetches while the weekend has started. Date and the intervals are faked; the
// promises and msw's responses stay real.
describe('the season page moves', () => {
  let root: Root;
  let host: HTMLElement;
  let client: QueryClient;
  let seasonRequests: number;
  const countSeason = ({ request }: { request: Request }) => {
    if (new URL(request.url).pathname === '/api/v1/seasons/2026') seasonRequests++;
  };

  const ended = Recordings.parse(recordings.filter((r) => r.ended_at !== null));
  const qualifying = {
    session_key: 9106,
    meeting_name: 'São Paulo Grand Prix',
    session_name: 'Qualifying',
    date_start: '2026-11-07T18:00:00.000Z',
    date_end: '2026-11-07T19:00:00.000Z',
  };
  const liveOf = (recording: Live['recording']) => ({ session: qualifying, recording });

  const mount = (now: string) => {
    vi.useFakeTimers({ now: Date.parse(now), toFake: ['Date', 'setInterval', 'clearInterval'] });
    seasonRequests = 0;
    server.events.on('request:start', countSeason);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(
      <QueryClientProvider client={client}>
        <Season year={2026} />
      </QueryClientProvider>,
    );
  };

  afterEach(() => {
    root.unmount();
    host.remove();
    client.clear();
    server.events.removeListener('request:start', countSeason);
    vi.useRealTimers();
  });

  const stateOf = (name: string) =>
    [...host.querySelectorAll('.weekend .sess li')]
      .find((li) => li.textContent?.startsWith(name))
      ?.querySelector('.state')?.textContent;
  const upNext = () => host.querySelector('.upnext')?.textContent ?? '';

  it('moves Qualifying from next to live now, and Up next on to the Race, without a remount', async () => {
    server.use(
      http.get('*/api/v1/seasons/2026', () => HttpResponse.json(season)),
      http.get('*/api/v1/live', () => HttpResponse.json(liveOf(null))),
      http.get('*/api/v1/recordings', () => HttpResponse.json(ended)),
    );
    mount('2026-11-07T17:59:00.000Z');
    await vi.waitFor(() => expect(stateOf('Qualifying')).toBe('next'));
    expect(upNext()).toContain('Qualifying');

    server.use(
      http.get('*/api/v1/live', () =>
        HttpResponse.json(liveOf({ id: 44, started_at: '2026-11-07T17:00:00.000Z', ended_at: null, complete: false })),
      ),
    );
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => expect(stateOf('Qualifying')).toBe('live now · Follow'));
    expect(upNext()).toContain('Race');
    expect(upNext()).not.toContain('Qualifying');
  });

  const answer = (liveBody: Parameters<typeof HttpResponse.json>[0]) =>
    server.use(
      http.get('*/api/v1/seasons/2026', () => HttpResponse.json(season)),
      http.get('*/api/v1/live', () => HttpResponse.json(liveBody)),
      http.get('*/api/v1/recordings', () => HttpResponse.json(ended)),
    );

  it('refetches the season every 5 min while the weekend is in progress', async () => {
    answer(liveOf(null));
    mount('2026-11-07T17:59:00.000Z');
    await vi.waitFor(() => expect(stateOf('Qualifying')).toBe('next'));
    expect(seasonRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await vi.waitFor(() => expect(seasonRequests).toBeGreaterThan(1));
  });

  it('turns a recording that ends into a replay link after the 5 min poll, without a remount', async () => {
    server.use(
      http.get('*/api/v1/seasons/2026', () => HttpResponse.json(season)),
      http.get('*/api/v1/live', () =>
        HttpResponse.json(liveOf({ id: 45, started_at: '2026-11-07T17:00:00.000Z', ended_at: null, complete: false })),
      ),
      http.get('*/api/v1/recordings', () => HttpResponse.json(ended)),
    );
    mount('2026-11-07T18:30:00.000Z');
    await vi.waitFor(() => expect(stateOf('Qualifying')).toBe('live now · Follow'));

    const done = {
      id: 45,
      started_at: '2026-11-07T17:00:00.000Z',
      ended_at: '2026-11-07T19:05:00.000Z',
      complete: true,
    };
    server.use(
      http.get('*/api/v1/live', () => HttpResponse.json(liveOf(done))),
      http.get('*/api/v1/recordings', () =>
        HttpResponse.json(
          Recordings.parse([
            {
              ...done,
              session_key: 9106,
              year: 2026,
              meeting_name: 'São Paulo Grand Prix',
              session_name: 'Qualifying',
              session_type: 'Qualifying',
              date_start: qualifying.date_start,
            },
            ...ended,
          ]),
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await vi.waitFor(() => expect(stateOf('Qualifying')).toBe('recorded'));
    const link = [...host.querySelectorAll('.weekend .sess li')]
      .find((li) => li.textContent?.startsWith('Qualifying'))
      ?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/replay/45');
  });

  it('starts polling when the weekend begins: nothing before the first session counts as started', async () => {
    answer({ session: null, recording: null });
    mount('2026-11-06T14:28:00.000Z'); // two minutes before São Paulo FP1
    await vi.waitFor(() => expect(host.querySelector('.weekend h2')?.textContent).toBe('São Paulo Grand Prix'));
    await vi.advanceTimersByTimeAsync(60_000); // 14:29, not started
    await new Promise((r) => setTimeout(r, 50));
    expect(seasonRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(seasonRequests).toBeGreaterThan(1));
  });

  it("stops polling once the weekend's grace day is over", async () => {
    answer({ session: null, recording: null });
    mount('2026-11-09T17:59:00.000Z'); // the Race ended 2026-11-08T18:00Z: the grace day ends at 2026-11-09T18:00Z
    await vi.waitFor(() => expect(host.querySelector('.weekend h2')?.textContent).toBe('São Paulo Grand Prix'));
    await vi.advanceTimersByTimeAsync(2 * 60_000); // past the first minute ticks: now Las Vegas is the weekend
    await vi.waitFor(() => expect(host.querySelector('.weekend h2')?.textContent).toBe('Las Vegas Grand Prix'));
    await new Promise((r) => setTimeout(r, 50));
    const after = seasonRequests;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(seasonRequests).toBe(after);
  });

  it('does not refetch while the weekend has not started', async () => {
    answer({ session: null, recording: null });
    mount('2026-11-15T12:00:00.000Z'); // São Paulo's grace day is over, Las Vegas is next
    await vi.waitFor(() => expect(host.querySelector('.weekend h2')?.textContent).toBe('Las Vegas Grand Prix'));
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(seasonRequests).toBe(1);
  });
});
