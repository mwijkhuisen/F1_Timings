import type { Lap, SessionDetail } from '@f1/contracts';
import { Fragment } from 'react';
import { hasPole, margin, type Phase, type PhaseCell, phaseName, type Quali, type QualiRow } from '../lib/quali.ts';
import { orderDrivers, teamStyle } from '../lib/session.ts';
import { fmtDelta, fmtLap } from '../lib/time.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// Qualifying by phase (P4b): each driver's best per phase with its margin to that phase's cut-off,
// the gap to pole and the timed laps. A labelled 2 px --fg line marks each knock-out (owner D4).

const same = (a: Lap | null, b: Lap | null) =>
  a !== null && b !== null && a.driver_number === b.driver_number && a.lap_number === b.lap_number;

const marginText = (m: number) => (m < 0 ? `${fmtDelta(m)} inside` : m > 0 ? `${fmtDelta(m)} out` : 'on the cut-off');

/** "Deleted in Q2: 1:15.437 (lap 12), TRACK LIMITS AT TURN 4". */
const deletedText = (laps: Lap[], name: string) =>
  `Deleted in ${name}: ${laps
    .map(
      (l) =>
        `${l.lap_ms === null ? '—' : fmtLap(l.lap_ms)} (lap ${l.lap_number})${l.deleted_reason ? `, ${l.deleted_reason}` : ''}`,
    )
    .join('; ')}`;

function PhaseTd({
  row,
  cell,
  phase,
  p,
  name,
}: {
  row: QualiRow;
  cell: PhaseCell;
  phase: Phase;
  p: number;
  name: (p: number) => string;
}) {
  const id = `q-${row.driver}-${p}`;
  const del = cell.deleted.length > 0 && (
    <Note id={`${id}-del`} text={deletedText(cell.deleted, name(p))}>
      <span className="badge">DEL</span>
    </Note>
  );
  if (!cell.best?.lap_ms) {
    const reason =
      row.reached === 0
        ? 'No laps in the data'
        : p > row.reached
          ? `Knocked out in ${name(row.reached)}`
          : `No valid lap in ${name(p)}`;
    return (
      <td>
        <Note id={id} text={reason}>
          —
        </Note>
        {del}
      </td>
    );
  }
  const m = margin(cell, phase);
  return (
    <td>
      <span className={same(cell.best, phase.fastest) ? 't-purple' : undefined}>{fmtLap(cell.best.lap_ms)}</span>
      {del}
      {m !== null && <small className="margin">{marginText(m)}</small>}
    </td>
  );
}

export function QualiTable({ detail, quali }: { detail: SessionDetail; quali: Quali }) {
  const { phases, rows } = quali;
  if (phases.length === 0) return <p>No qualifying phases in the data: see Every lap.</p>;
  const name = (p: number) => phaseName(detail.session.name, p);
  const n = phases.length;
  const pole = phases.at(-1)?.fastest ?? null;
  const poleWord = hasPole(quali) ? 'pole' : 'fastest';
  const drivers = new Map(
    orderDrivers(
      detail,
      rows.map((r) => ({ driver_number: r.driver })),
    ).map((d) => [d.number, d]),
  );
  // Phase p's line sits under the last driver through it (rows are ordered by phase reached), when rows follow.
  const cutAfter = new Map<number, number[]>();
  for (let p = n - 1; p >= 1; p--) {
    const through = rows.filter((r) => r.reached > p).length;
    if (through > 0 && through < rows.length) cutAfter.set(through - 1, [...(cutAfter.get(through - 1) ?? []), p]);
  }
  return (
    <>
      <ul className="legend" aria-label="Legend">
        <li>
          <span className="t-purple">fastest</span> of the phase
        </li>
        <li>
          <span className="muted">−0.212 inside</span> margin to that phase's cut-off
        </li>
      </ul>
      <Scroll label="Qualifying by phase">
        <table className="quali" aria-label="Qualifying by phase">
          <thead>
            <tr>
              <th scope="col">Driver</th>
              {phases.map((_, i) => (
                <th key={name(i + 1)} scope="col">
                  {name(i + 1)}
                </th>
              ))}
              <th scope="col">{`To ${poleWord}`}</th>
              <th scope="col">Timed laps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const d = drivers.get(r.driver);
              const last = r.cells[n - 1]?.best ?? null;
              const cuts = cutAfter.get(i) ?? [];
              return (
                <Fragment key={r.driver}>
                  <tr className={cuts.length > 0 ? 'cut' : undefined}>
                    <th scope="row" className="drv" style={d && teamStyle(d)} title={d?.name ?? undefined}>
                      {d?.acronym ?? r.driver}
                    </th>
                    {r.cells.map((cell, j) => (
                      <PhaseTd key={name(j + 1)} row={r} cell={cell} phase={phases[j] as Phase} p={j + 1} name={name} />
                    ))}
                    <td>
                      {last?.lap_ms && pole?.lap_ms ? (
                        same(last, pole) ? (
                          <span className="muted">{poleWord}</span>
                        ) : (
                          fmtDelta(last.lap_ms - pole.lap_ms)
                        )
                      ) : (
                        <Note id={`q-${r.driver}-pole`} text={`Not in ${name(n)}`}>
                          —
                        </Note>
                      )}
                    </td>
                    <td>{r.timed}</td>
                  </tr>
                  {cuts.map((p) => (
                    <tr key={p} className="cutlabel">
                      <td colSpan={n + 3}>
                        <span>
                          {name(p + 1)} above · knocked out in {name(p)} below
                        </span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}
