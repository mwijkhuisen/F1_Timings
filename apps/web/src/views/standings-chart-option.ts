import type { Standings } from '@f1/contracts';
import { teamColour } from '../lib/session.ts';
import { type ChartTokens, endLabel, grid, lapAxis, lineStyles, plain, tooltip } from './lap-chart-option.ts';

// The points progression chart's ECharts option (P8, A§13). Pure: no ECharts import at runtime, no HTML.

export type Who = 'drivers' | 'teams';

/** Points as shown: whole numbers, and halves or quarters without float noise (a shortened race, 12.5). */
export const fmtPoints = (n: number) => String(Math.round(n * 100) / 100);

/**
 * One line per driver (or team) of the final standing, in standing order: cumulative points after each counted
 * session in `rounds`, a gap (null) where the person has no entry yet. The x axis counts the sessions (1…n, the
 * lap axis' value axis); the tooltip names the session. Colours and line types are the lap chart's (C2), so
 * teammates differ by line type. Drivers end in their acronym; a team name is too long for the margin, so teams have
 * the legend only.
 */
export function standingsChartOption(standings: Standings, who: Who, tokens: ChartTokens) {
  const people =
    who === 'drivers'
      ? standings.drivers.map((d) => ({
          key: d.full_name,
          name: plain(d.acronym ?? d.full_name),
          colour: d.team_colour,
        }))
      : standings.teams.map((t) => ({ key: t.team_name, name: plain(t.team_name), colour: t.team_colour }));
  const styles = lineStyles(
    people.map((p, i) => ({ number: i, acronym: p.name, name: null, team: teamColour(p.colour) })),
    tokens,
  );
  const points = standings.rounds.map(
    (r) =>
      new Map(
        (who === 'drivers' ? r.drivers : r.teams).map((p) => ['full_name' in p ? p.full_name : p.team_name, p.points]),
      ),
  );
  const lines = people.map((p, i) => {
    const { color, type } = styles[i] as (typeof styles)[number];
    return {
      type: 'line' as const,
      name: p.name,
      color,
      lineStyle: { type },
      symbol: 'none',
      // [round, points], null before the person's first entry so the line starts where he does.
      data: points.map((m, n) => [n + 1, m.get(p.key) ?? null]),
      connectNulls: true,
      ...endLabel(p.name, tokens, who === 'drivers'),
    };
  });
  // The leaders first, as many lines as there are people.
  const at = (n: number) =>
    people
      .map((p, i) => ({ name: (lines[i] as (typeof lines)[number]).name, v: points[n]?.get(p.key) ?? 0 }))
      .filter((p) => p.v > 0)
      .sort((a, b) => b.v - a.v)
      .map((p) => `${p.name} ${fmtPoints(p.v)}`);
  return {
    backgroundColor: 'transparent',
    textStyle: { color: tokens.fg },
    grid,
    // One scrolling row: 22 drivers or 11 team names wrap to five rows on a phone, into the plot (P8 review).
    legend: {
      type: 'scroll' as const,
      top: 0,
      data: lines.map((l) => l.name),
      itemWidth: 36,
      textStyle: { color: tokens.fg },
      pageTextStyle: { color: tokens.muted },
      pageIconColor: tokens.fg,
      pageIconInactiveColor: tokens.muted,
    },
    xAxis: lapAxis(standings.rounds.length, tokens),
    yAxis: {
      type: 'value' as const,
      min: 0,
      axisLabel: { color: tokens.muted },
      splitLine: { lineStyle: { color: tokens.line } },
    },
    tooltip: tooltip(tokens, (i) => {
      const r = standings.rounds[i];
      return [r ? `${plain(r.meeting_name ?? '')} · ${plain(r.session_name ?? '')}` : '', ...at(i)];
    }),
    series: lines,
  };
}
