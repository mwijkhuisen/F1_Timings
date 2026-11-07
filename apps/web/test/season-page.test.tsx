// @vitest-environment happy-dom
import type { Live } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { Season, SeasonView, Start } from '../src/views/Season.tsx';
import { live, NOW, recordings, season, seasons } from './season-data.ts';

// The season page (A§13, P4c): this weekend first with every state in words, Up next, the other meetings as cards,
// and never a result. The static renders run in happy-dom too, which renderToStaticMarkup does not mind.

const render = (now: number, l: Live | null = live) =>
  renderToStaticMarkup(<SeasonView year={2026} season={season} live={l} recordings={recordings} now={now} />);

describe('the season page', () => {
  // Countdown reads the clock itself.
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
    expect(html).toContain('<span class="state recorded">recorded · <a href="/replay/41">Replay</a></span>');
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
    expect(html).toContain('<li><s>Race<span class="vh"> (cancelled)</span></s>');
    expect(html).not.toMatch(/href="[^"]*9010/);
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
});
