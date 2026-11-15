// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Standings } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { HttpResponse, http } from 'msw';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { REVISION } from '../src/lib/api.ts';
import { init } from '../src/lib/echarts.ts';
import type { ChartTokens } from '../src/views/lap-chart-option.ts';
import { ResultTab, StandingsSection } from '../src/views/Result.tsx';
import { standingsChartOption } from '../src/views/standings-chart-option.ts';
import { result, sessionDetail } from './laps.ts';

// P8 (A§13): the standings section of the Result tab, its chart, and the spoiler rule. The chart's own canvas is
// stubbed in the mounted tests: they are about what is asked, not drawn.
vi.mock('../src/views/Chart.tsx', () => ({
  Chart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));

const tokens: ChartTokens = {
  fg: '#f0f0f5',
  muted: '#9b9ba8',
  line: '#34343f',
  bg: '#15151e',
  amber: '#ffb020',
  live: '#ff6b6b',
  rain: '#4da6ff',
  light: false,
};

/** After round 2 (two counted sessions): Red Bull's two drivers share a colour, as teammates do. */
const standings = Standings.parse({
  drivers: [
    {
      position: 1,
      change: 1,
      full_name: 'Max Verstappen',
      acronym: 'VER',
      team_names: ['Red Bull Racing', 'Racing Bulls'],
      team_colour: '3671C6',
      points: 33,
      session_points: 25,
    },
    {
      position: 2,
      change: -2,
      full_name: 'Lando Norris',
      acronym: 'NOR',
      team_names: ['McLaren'],
      team_colour: 'FF8000',
      points: 18.5,
      session_points: 0,
    },
    {
      position: 3,
      change: 0,
      full_name: 'Sergio Perez',
      acronym: 'PER',
      team_names: ['Red Bull Racing'],
      team_colour: '3671C6',
      points: 8,
      session_points: 8,
    },
    {
      position: 4,
      change: null,
      full_name: 'No Colour',
      acronym: null,
      team_names: ['Nobody'],
      team_colour: null,
      points: 0,
      session_points: 0,
    },
  ],
  teams: [
    { position: 1, change: null, team_name: 'Red Bull Racing', team_colour: '3671C6', points: 41, session_points: 33 },
    { position: 2, change: 2, team_name: 'McLaren', team_colour: 'FF8000', points: 18.5, session_points: 0 },
  ],
  rounds: [
    {
      session_key: 1,
      meeting_name: 'Bahrain {Grand} Prix',
      session_name: 'Race',
      date_start: '2026-03-01T15:00:00.000Z',
      drivers: [
        { full_name: 'Max Verstappen', points: 8 },
        { full_name: 'Lando Norris', points: 18.5 },
      ],
      teams: [
        { team_name: 'Red Bull Racing', points: 8 },
        { team_name: 'McLaren', points: 18.5 },
      ],
    },
    {
      session_key: 2,
      meeting_name: 'Saudi Arabian Grand Prix',
      session_name: 'Race',
      date_start: '2026-03-08T15:00:00.000Z',
      drivers: [
        { full_name: 'Max Verstappen', points: 33 },
        { full_name: 'Lando Norris', points: 18.5 },
        { full_name: 'Sergio Perez', points: 8 },
      ],
      teams: [
        { team_name: 'Red Bull Racing', points: 41 },
        { team_name: 'McLaren', points: 18.5 },
      ],
    },
  ],
  provisional: false,
});

const render = (s: Standings, sprint = false) =>
  renderToStaticMarkup(<StandingsSection standings={s} sprint={sprint} />);
const rows = (html: string, label: string) => {
  const table =
    new RegExp(`<table class="result" aria-label="${label.replace("'", '&#x27;')}">([\\s\\S]*?)</table>`).exec(
      html,
    )?.[1] ?? '';
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, tr = '']) =>
    [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, c = '']) => c.replace(/<[^>]*>/g, '')),
  );
};

describe('the standings section', () => {
  const html = render(standings);

  it('is headed by the session: race or sprint', () => {
    expect(html).toContain('<h2>Standings after this race</h2>');
    expect(render(standings, true)).toContain('<h2>Standings after this sprint</h2>');
  });

  it('has the drivers table: place, change in words, driver and team, points and this session', () => {
    expect(rows(html, "Drivers' standings")).toEqual([
      ['Pos', 'Change', 'Driver', 'Points', 'This session'],
      ['1', '▲ 1up 1', 'VERRed Bull Racing / Racing Bulls', '33', '+25'],
      ['2', '▼ 2down 2', 'NORMcLaren', '18.5', '+0'],
      ['3', '–no change', 'PERRed Bull Racing', '8', '+8'],
      ['4', '', 'No ColourNobody', '0', '+0'],
    ]);
    // The session's team comes first, in the cell and the team bar is the team colour.
    expect(html).toContain('class="drv" style="--team:#3671C6;--team-l:#3671C6" title="Max Verstappen"');
    expect(html).toContain('<span class="vh">up 1</span>');
  });

  it('has the constructors table the same way', () => {
    expect(rows(html, "Constructors' standings")).toEqual([
      ['Pos', 'Change', 'Team', 'Points', 'This session'],
      ['1', '', 'Red Bull Racing', '41', '+33'],
      ['2', '▲ 2up 2', 'McLaren', '18.5', '+0'],
    ]);
  });

  it('puts each table in a named scroll box', () => {
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Drivers&#x27; standings">');
    expect(html).toContain('<div class="scroll" tabindex="0" role="region" aria-label="Constructors&#x27; standings">');
  });

  it("says Provisional only when the standing is from the session's own classification", () => {
    const caption = "Provisional: from this session's classification until OpenF1's next standings.";
    expect(html).not.toContain('Provisional');
    expect(render({ ...standings, provisional: true })).toContain(
      `<p class="muted">${caption.replace("'", '&#x27;').replace("'", '&#x27;')}</p>`,
    );
  });

  it('has the chart, named, with a pressed Drivers button and a Constructors one', () => {
    expect(html).toContain('<div role="img" aria-label="Points after each race and sprint"></div>');
    expect(html).toContain('aria-pressed="true">Drivers</button>');
    expect(html).toContain('aria-pressed="false">Constructors</button>');
  });

  it('shows nothing without rows', () => {
    expect(render({ ...standings, drivers: [], teams: [], rounds: [] })).toBe('');
  });
});

// The tab asks for the standings in a race-type session only, and shows what it gets.
describe('the Result tab and the standings request', () => {
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

  const mount = (type: string, name: string, answer: () => Response) => {
    const urls: string[] = [];
    server.use(
      http.get('*/api/v1/sessions/*/standings', ({ request }) => {
        urls.push(new URL(request.url).pathname + new URL(request.url).search);
        return answer();
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    const detail = sessionDetail(type, name, [[1, 'VER']], [result(1, 1)]);
    root.render(
      <QueryClientProvider client={client}>
        <ResultTab detail={detail} laps={null} live={null} now={0} />
      </QueryClientProvider>,
    );
    return urls;
  };

  it('asks for a race and shows its section', async () => {
    const urls = mount('Race', 'Race', () => HttpResponse.json(standings));
    await vi.waitFor(() => expect(host.querySelector('.standings h2')?.textContent).toBe('Standings after this race'));
    expect(urls).toEqual([`/api/v1/sessions/11000/standings?v=${REVISION}`]);
    // The classification stays above it.
    expect(host.querySelector('table[aria-label="Result"]')).not.toBeNull();
  });

  it('words a sprint', async () => {
    mount('Race', 'Sprint', () => HttpResponse.json(standings));
    await vi.waitFor(() =>
      expect(host.querySelector('.standings h2')?.textContent).toBe('Standings after this sprint'),
    );
  });

  it('never asks for a qualifying or a practice', async () => {
    const urls = mount('Qualifying', 'Qualifying', () => HttpResponse.json(standings));
    await vi.waitFor(() => expect(host.querySelector('table[aria-label="Result"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toEqual([]);
    expect(host.querySelector('.standings')).toBeNull();
  });

  it('shows no section for empty arrays', async () => {
    const urls = mount('Race', 'Race', () =>
      HttpResponse.json({ drivers: [], teams: [], rounds: [], provisional: false }),
    );
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector('.standings')).toBeNull();
    expect(host.querySelector('table[aria-label="Result"]')).not.toBeNull();
  });

  it('keeps the classification and says so when the standings fail', async () => {
    mount('Race', 'Race', () => new HttpResponse(null, { status: 500 }));
    await vi.waitFor(() => expect(host.textContent).toContain('Standings did not load.'));
    expect(host.querySelector('table[aria-label="Result"]')).not.toBeNull();
  });
});

describe('standingsChartOption', () => {
  const option = standingsChartOption(standings, 'drivers', tokens);
  const lines = option.series as { name: string; color: string; lineStyle: { type: string }; data: unknown[] }[];

  it('has one line per driver in the team colour, cumulative per counted session, null before the first entry', () => {
    expect(lines.map((l) => l.name)).toEqual(['VER', 'NOR', 'PER', 'No Colour']);
    expect(lines[0]).toMatchObject({ color: '#3671C6' });
    expect(lines[0]?.data).toEqual([
      [1, 8],
      [2, 33],
    ]);
    expect(lines[2]?.data).toEqual([
      [1, null],
      [2, 8],
    ]);
    // No team colour: --muted, as the lap chart does.
    expect(lines[3]?.color).toBe(tokens.muted);
    expect(option.xAxis).toMatchObject({ min: 0.5, max: 2.5 });
  });

  it('draws teammates in different line types (C2)', () => {
    expect(lines[0]?.lineStyle.type).toBe('solid');
    expect(lines[2]?.lineStyle.type).toBe('dashed');
    expect(lines[1]?.lineStyle.type).toBe('solid');
  });

  it('has one line per team, without end labels', () => {
    const teams = standingsChartOption(standings, 'teams', tokens);
    expect((teams.series as { name: string }[]).map((l) => l.name)).toEqual(['Red Bull Racing', 'McLaren']);
    expect(teams.series[0]).toMatchObject({ endLabel: { show: false } });
    expect(option.series[0]).toMatchObject({ endLabel: { show: true, formatter: 'VER' } });
  });

  it('names the session in the tooltip, strips rich-text markup, and lists the leaders first', () => {
    const f = option.tooltip.formatter as (p: { dataIndex: number }[]) => string;
    expect(f([{ dataIndex: 0 }])).toBe('Bahrain Grand Prix · Race\nNOR 18.5\nVER 8');
    expect(f([{ dataIndex: 1 }])).toBe('Saudi Arabian Grand Prix · Race\nVER 33\nNOR 18.5\nPER 8');
  });
});

// The chart laid out by ECharts itself at phone width (the lap chart's method, compare.test.tsx): a full grid of
// ten teams in 24 rounds.
describe('the standings chart at 390 px', () => {
  use([SVGRenderer]);
  const COLOURS = ['3671C6', 'FF8000', 'E80020', '27F4D2', '229971', '0093CC', '6692FF', 'B6BABD', '52E252', 'FF87BC'];
  const names = ['Red Bull', 'McLaren', 'Ferrari', 'Mercedes', 'Aston', 'Alpine', 'Williams', 'Haas', 'Sauber', 'RB'];
  const big = Standings.parse({
    drivers: names.flatMap((team, t) =>
      [0, 1].map((k) => ({
        position: 1 + 2 * t + k,
        change: null,
        full_name: `Driver ${t}-${k}`,
        acronym: `D${t}${k}`,
        team_names: [team],
        team_colour: COLOURS[t],
        points: 10,
        session_points: 1,
      })),
    ),
    teams: names.map((team, t) => ({
      position: t + 1,
      change: null,
      team_name: `${team} Racing Team`,
      team_colour: COLOURS[t],
      points: 20,
      session_points: 2,
    })),
    rounds: Array.from({ length: 24 }, (_, n) => ({
      session_key: n,
      meeting_name: 'Grand Prix',
      session_name: 'Race',
      date_start: '2026-03-01T15:00:00.000Z',
      drivers: names.flatMap((_, t) =>
        [0, 1].map((k) => ({ full_name: `Driver ${t}-${k}`, points: (n + 1) * (20 - 2 * t - k) })),
      ),
      teams: names.map((team, t) => ({ team_name: `${team} Racing Team`, points: (n + 1) * (40 - 4 * t) })),
    })),
    provisional: false,
  });

  type Box = { x: number; y: number; width: number; height: number };
  const draw = (o: object) => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 390, height: 320 });
    try {
      chart.setOption({ ...o, animation: false });
      return chart
        .getZr()
        .storage.getDisplayList()
        .map((el) => {
          const e = el as unknown as {
            type: string;
            style: { text?: string; stroke?: string; lineDash?: unknown };
            transform?: number[];
            getBoundingRect(): { clone(): Box & { applyTransform(m: number[]): void } };
          };
          const box = e.getBoundingRect().clone();
          if (e.transform) box.applyTransform(e.transform);
          return { el: e, box };
        });
    } finally {
      chart.dispose();
    }
  };

  for (const who of ['drivers', 'teams'] as const) {
    it(`lays out the ${who} lines, legend and axes inside the box`, () => {
      const list = draw(standingsChartOption(big, who, tokens));
      const n = who === 'drivers' ? 20 : 10;
      const polylines = list.filter(({ el }) => el.type === 'ec-polyline');
      expect(polylines.length).toBeGreaterThanOrEqual(n);
      // Nothing is drawn past the 390 px width or the 320 px height (legend text wraps, end labels fit the margin).
      for (const { el, box } of list) {
        if (!Number.isFinite(box.width) || !Number.isFinite(box.x)) continue;
        expect(box.x, el.style.text ?? el.type).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width, el.style.text ?? el.type).toBeLessThanOrEqual(391);
        expect(box.y + box.height, el.style.text ?? el.type).toBeLessThanOrEqual(321);
      }
    });
  }

  it('gives the teammates of one colour different dashes', () => {
    const list = draw(standingsChartOption(big, 'drivers', tokens));
    const dashes = (colour: string) =>
      new Set(
        list
          .filter(({ el }) => el.type === 'ec-polyline' && el.style.stroke === `#${colour}`)
          .map(({ el }) => JSON.stringify(el.style.lineDash ?? null)),
      );
    // Two drivers per colour: two line types.
    expect(dashes('FF8000').size).toBe(2);
  });
});

// The spoiler rule (A§13): standings live in the Result tab and nowhere else.
describe('the spoiler rule', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(src.length + 1)
        .replaceAll('\\', '/'),
    );
  const using = (re: RegExp) => files.filter((f) => re.test(readFileSync(join(src, f), 'utf8'))).sort();

  it('has the standings query used by views/Result.tsx alone', () => {
    expect(using(/useStandings/)).toEqual(['lib/api.ts', 'views/Result.tsx']);
    expect(using(/standings-chart-option/)).toEqual(['views/Result.tsx']);
    expect(using(/Standings after/)).toEqual(['views/Result.tsx']);
  });

  it('keeps the Result tab out of the season page, the live pages and the player: only Session.tsx uses it', () => {
    expect(using(/from '(?:\.\/|\.\.\/views\/)Result\.tsx'/)).toEqual(['views/Session.tsx']);
    expect(using(/Result\.tsx'/)).toEqual(['views/Session.tsx']);
  });
});
