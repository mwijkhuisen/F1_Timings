import type { Laps, Live, SessionDetail, Standings } from '@f1/contracts';
import { type ReactNode, useCallback, useState } from 'react';
import { useStandings } from '../lib/api.ts';
import { phaseName } from '../lib/quali.ts';
import { orderDrivers, plural, sourceWords, statusOf, teamColour, teamStyle } from '../lib/session.ts';
import { fmtDuration, fmtGap, fmtLap } from '../lib/time.ts';
import { NoData } from '../ui/NoData.tsx';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';
import { Chart } from './Chart.tsx';
import type { ChartTokens } from './lap-chart-option.ts';
import { fmtPoints, standingsChartOption, type Who } from './standings-chart-option.ts';

// The Result tab (#110, A§13): the classification as stored, only inside an opened session, never the default tab.
// Position, driver, team and laps, then the winner's time and the gaps (Q1–Q3 in qualifying), then DNF, DNS or DSQ.
// Nothing is interpolated: a lapped gap (stored as {NULL}) is "+n laps" from the stored lap counts, else '—' with a reason.

type Row = SessionDetail['results'][number];

const NONE = Number.POSITIVE_INFINITY;
/** Position (nulls last), then laps descending (nulls last), then number; two null positions give NaN, which falls through. */
const byClassification = (a: Row, b: Row) =>
  (a.position ?? NONE) - (b.position ?? NONE) || (b.laps ?? -1) - (a.laps ?? -1) || a.driver_number - b.driver_number;

/** A value, or '—' with why it is missing. */
const orNote = (value: ReactNode, id: string, reason: string) =>
  value ?? (
    <Note id={id} text={reason}>
      —
    </Note>
  );

/**
 * The winner's time (null without one, never "+0.000"), else the gap, else in a race "+n laps" behind the winner's laps
 * (a DNF too, never a DNS or DSQ), else null.
 */
function gapOf(r: Row, winner: Row | undefined, race: boolean): string | null {
  const time = r.durations_ms?.[0] ?? null;
  if (r.position === 1) return time === null ? null : fmtDuration(time);
  const gap = r.gaps_ms?.[0] ?? null;
  if (gap !== null) return fmtGap(gap);
  const behind = race && !r.dns && !r.dsq && r.laps !== null && winner?.laps != null ? winner.laps - r.laps : 0;
  return behind > 0 ? `+${plural(behind, 'lap')}` : null;
}

/**
 * An official Q time with its gap; NO LAP when the laps are loaded and none of the driver's is within 1 ms (A§9).
 * `laps` is null while they load, and for a Jolpica session, which has no lap rows by design.
 */
function QCell({ r, p, laps, name, source }: { r: Row; p: number; laps: Laps | null; name: string; source: string }) {
  const id = `r-${r.driver_number}-q${p}`;
  const time = r.durations_ms?.[p] ?? null;
  if (time === null) return <td>{orNote(null, id, `No ${name} time in ${source}`)}</td>;
  const gap = r.gaps_ms?.[p] ?? null;
  const noLap =
    laps !== null &&
    !laps.some((l) => l.driver_number === r.driver_number && l.lap_ms !== null && Math.abs(l.lap_ms - time) <= 1);
  return (
    <td>
      {fmtLap(time)}
      {noLap && (
        <Note id={`${id}-nolap`} text="Official time, no lap in the data">
          <span className="badge">NO LAP</span>
        </Note>
      )}
      {gap !== null && <small className="margin">{gap === 0 ? 'fastest' : fmtGap(gap)}</small>}
    </td>
  );
}

export function ResultTable({ detail, laps }: { detail: SessionDetail; laps: Laps | null }) {
  const race = detail.session.type === 'Race';
  const qualifying = detail.session.type === 'Qualifying';
  const source = sourceWords(detail.session.source);
  const rows = detail.results.toSorted(byClassification);
  const winner = rows.find((r) => r.position === 1);
  const drivers = new Map(orderDrivers(detail, rows).map((d) => [d.number, d]));
  const teams = new Map(detail.drivers.map((d) => [d.driver_number, d.team_name]));
  const phases = qualifying ? Math.max(0, ...rows.map((r) => r.durations_ms?.length ?? 0)) : 0;
  const names = Array.from({ length: phases }, (_, p) => phaseName(detail.session.name, p + 1));
  const lapRows = detail.session.source === 'jolpica' ? null : laps;
  return (
    <>
      {race && (
        <p className="muted">The official order includes time penalties; the gap chart's line crossings do not.</p>
      )}
      <Scroll label="Result">
        <table className="result" aria-label="Result">
          <thead>
            <tr>
              <th scope="col">Pos</th>
              <th scope="col">Driver</th>
              <th scope="col">Team</th>
              <th scope="col">Laps</th>
              {qualifying ? (
                names.map((n) => (
                  <th key={n} scope="col">
                    {n}
                  </th>
                ))
              ) : (
                <th scope="col">Time / gap</th>
              )}
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = r.driver_number;
              const d = drivers.get(n);
              return (
                <tr key={n}>
                  <td>{orNote(r.position, `r-${n}-pos`, `No position in ${source}`)}</td>
                  <th scope="row" className="drv" style={d && teamStyle(d)} title={d?.name ?? undefined}>
                    {d?.acronym ?? n}
                  </th>
                  <td className="team">{teams.get(n)}</td>
                  <td>{orNote(r.laps, `r-${n}-laps`, `No lap count in ${source}`)}</td>
                  {qualifying ? (
                    names.map((name, p) => <QCell key={name} r={r} p={p} laps={lapRows} name={name} source={source} />)
                  ) : (
                    <td>{orNote(gapOf(r, winner, race), `r-${n}-gap`, `No gap in ${source}`)}</td>
                  )}
                  <td>{statusOf(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}

const upDown = (change: number) => (change > 0 ? `▲ ${change}` : change < 0 ? `▼ ${-change}` : '–');
const upDownWords = (change: number) => (change > 0 ? `up ${change}` : change < 0 ? `down ${-change}` : 'no change');

/** Place change (positive = up): the cue, with its words for a screen reader; nothing without a previous place. */
function ChangeCell({ change }: { change: number | null }) {
  if (change === null) return <td />;
  return (
    <td>
      <span aria-hidden="true">{upDown(change)}</span>
      <span className="vh">{upDownWords(change)}</span>
    </td>
  );
}

type Place = { position: number; change: number | null; points: number; session_points: number };

function StandingsTable({
  label,
  head,
  rows,
}: {
  label: string;
  head: string;
  rows: { id: string; name: string; sub?: string; title?: string; colour: string | null; r: Place }[];
}) {
  return (
    <Scroll label={label}>
      <table className="result" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Pos</th>
            <th scope="col">Change</th>
            <th scope="col">{head}</th>
            <th scope="col">Points</th>
            <th scope="col">This session</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, name, sub, title, colour, r }) => (
            <tr key={id}>
              <td>{r.position}</td>
              <ChangeCell change={r.change} />
              <th
                scope="row"
                className="drv"
                style={teamStyle({ number: 0, acronym: name, name: null, team: teamColour(colour) })}
                title={title}
              >
                {name}
                {sub && <small className="margin">{sub}</small>}
              </th>
              <td>{fmtPoints(r.points)}</td>
              <td>+{fmtPoints(r.session_points)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

/**
 * The standings after a race or sprint (P8, A§13), under the classification: the drivers' and constructors' tables
 * and the points chart (the tables are its text alternative). Nothing when the answer has no rows.
 */
export function StandingsSection({ standings, sprint }: { standings: Standings; sprint: boolean }) {
  const [who, setWho] = useState<Who>('drivers');
  const option = useCallback((t: ChartTokens) => standingsChartOption(standings, who, t), [standings, who]);
  if (standings.drivers.length === 0 && standings.teams.length === 0) return null;
  return (
    <section className="standings">
      <h2>Standings after this {sprint ? 'sprint' : 'race'}</h2>
      {standings.provisional && (
        <p className="muted">Provisional: from this session's classification until OpenF1's next standings.</p>
      )}
      <h3>Drivers</h3>
      <StandingsTable
        label="Drivers' standings"
        head="Driver"
        rows={standings.drivers.map((d) => ({
          id: d.full_name,
          name: d.acronym ?? d.full_name,
          sub: d.team_names.join(' / '),
          title: d.full_name,
          colour: d.team_colour,
          r: d,
        }))}
      />
      <h3>Constructors</h3>
      <StandingsTable
        label="Constructors' standings"
        head="Team"
        rows={standings.teams.map((t) => ({ id: t.team_name, name: t.team_name, colour: t.team_colour, r: t }))}
      />
      <div className="panel-title">
        <h3>Points progression</h3>
        <fieldset className="segmented" aria-label="Chart">
          <button type="button" aria-pressed={who === 'drivers'} onClick={() => setWho('drivers')}>
            Drivers
          </button>
          <button type="button" aria-pressed={who === 'teams'} onClick={() => setWho('teams')}>
            Constructors
          </button>
        </fieldset>
      </div>
      <p className="muted">After each race and sprint of the season so far, in order.</p>
      <Chart label="Points after each race and sprint" option={option} />
    </section>
  );
}

/** Asks for the standings of a race-type session, which the tab renders only for those; a failure is a short line. */
function StandingsLoader({ detail }: { detail: SessionDetail }) {
  const q = useStandings(detail.session.session_key);
  if (q.data) return <StandingsSection standings={q.data} sprint={detail.session.name === 'Sprint'} />;
  return q.isError ? <p className="muted">Standings did not load.</p> : null;
}

/** The tab: the table, or why there is no result (`noDataText`). `laps` is null while they load. */
export function ResultTab({
  detail,
  laps,
  live,
  now,
}: {
  detail: SessionDetail;
  laps: Laps | null;
  live: Live | null;
  now: number;
}) {
  if (detail.results.length === 0) return <NoData session={detail.session} live={live} what="results" now={now} />;
  return (
    <>
      <ResultTable detail={detail} laps={laps} />
      {detail.session.type === 'Race' && <StandingsLoader detail={detail} />}
    </>
  );
}
