// @vitest-environment happy-dom
import { type Season, Standings as StandingsData } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { REVISION } from '../src/lib/api.ts';
import { latestCounted } from '../src/lib/season.ts';
import { Standings, StandingsView } from '../src/views/Standings.tsx';
import { season } from './season-data.ts';

// The standings page (#201, A§13): the standings after the season's latest race or sprint with data, shown at once.
// season-data's latest is the Mexico City race (9002): the São Paulo sprint after it is still `due`.
vi.mock('../src/views/Chart.tsx', () => ({
  Chart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));

const person = (position: number, full_name: string, acronym: string, team: string, points: number) => ({
  position,
  change: null,
  full_name,
  acronym,
  team_names: [team],
  team_colour: 'E10600',
  points,
  session_points: points,
});
const answer = StandingsData.parse({
  drivers: [person(1, 'Ann Alpha', 'ANN', 'Red', 25), person(2, 'Bob Beta', 'BOB', 'Blue', 18)],
  teams: [
    { position: 1, change: null, team_name: 'Red', team_colour: 'E10600', points: 25, session_points: 25 },
    { position: 2, change: null, team_name: 'Blue', team_colour: '0000EE', points: 18, session_points: 18 },
  ],
  rounds: [
    {
      session_key: 9002,
      meeting_name: 'Mexico City Grand Prix',
      session_name: 'Race',
      date_start: '2026-10-25T20:00:00.000Z',
      drivers: [{ full_name: 'Ann Alpha', points: 25 }],
      teams: [{ team_name: 'Red', points: 25 }],
    },
  ],
  provisional: false,
});
const EMPTY = { drivers: [], teams: [], rounds: [], provisional: false };
const RESULT = '/2026/1310-mexico-city/9002-race/result';
const render = (standings: StandingsData | null, slot = latestCounted(season), year = 2026) =>
  renderToStaticMarkup(<StandingsView year={year} slot={slot} standings={standings} />);

describe('the standings page', () => {
  const html = render(answer);

  it("heads the page with the year and links the session's Result tab by its names", () => {
    expect(html).toMatch(
      new RegExp(
        `^<h1 tabindex="-1">Standings 2026</h1><p class="muted">After the <a href="${RESULT}">Mexico City Grand Prix · Race</a></p><div class="standings-grid">`,
      ),
    );
  });

  it('shows both tables under the plain headings, then the chart', () => {
    const heads = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map(([, h]) => h);
    expect(heads).toEqual(['Drivers', 'Constructors', 'Points progression']);
    expect(html).toContain('<table class="result" aria-label="Drivers&#x27; standings">');
    expect(html).toContain('<table class="result" aria-label="Constructors&#x27; standings">');
    expect(html).toContain('<div role="img" aria-label="Points after each race and sprint"></div>');
    expect(html).not.toContain('class="scroll"');
  });

  it('says Provisional only when the standing is provisional', () => {
    expect(html).not.toContain('Provisional');
    expect(render({ ...answer, provisional: true })).toContain('<p class="muted">Provisional: from this session');
  });

  it('says there are none yet, without a session to ask or for an empty answer', () => {
    const none = '<h1 tabindex="-1">Standings 2022</h1><p>No standings for 2022 yet.</p>';
    expect(render(null, null, 2022)).toBe(none);
    expect(render(EMPTY, latestCounted(season), 2022)).toBe(none);
  });
});

// A real tree on msw: the page asks the season and the one session's standings, nothing else (msw fails the rest).
describe('the standings page requests', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    root.unmount();
    host.remove();
  });

  const mount = (data: Season) => {
    const urls: string[] = [];
    const seen = ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      urls.push(url.pathname + url.search);
    };
    server.use(
      http.get('*/api/v1/seasons/2026', (info) => {
        seen(info);
        return HttpResponse.json(data);
      }),
      http.get('*/api/v1/sessions/*/standings', (info) => {
        seen(info);
        return HttpResponse.json(answer);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    root.render(
      <QueryClientProvider client={client}>
        <Standings year={2026} />
      </QueryClientProvider>,
    );
    return urls;
  };

  it('asks /seasons/2026, then the latest counted session standings, and shows them at once', async () => {
    const urls = mount(season);
    await vi.waitFor(() => expect(host.querySelector('.standings-grid h2')?.textContent).toBe('Drivers'));
    expect(urls).toEqual(['/api/v1/seasons/2026', `/api/v1/sessions/9002/standings?v=${REVISION}`]);
    expect(host.querySelector('h1')?.textContent).toBe('Standings 2026');
    expect(host.querySelector(`a[href="${RESULT}"]`)?.textContent).toBe('Mexico City Grand Prix · Race');
    const grid = host.querySelector('.standings-grid');
    expect(
      [...(grid?.children ?? [])].map((c) => c.querySelector('table')?.getAttribute('aria-label') ?? c.className),
    ).toEqual(["Drivers' standings", "Constructors' standings", 'result-foot']);
  });

  it('asks no standings without a counted session, and says so', async () => {
    const urls = mount(season.filter((m) => m.meeting_key === 1300));
    await vi.waitFor(() => expect(host.textContent).toContain('No standings for 2026 yet.'));
    expect(urls).toEqual(['/api/v1/seasons/2026']);
  });
});
