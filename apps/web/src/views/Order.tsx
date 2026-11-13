import { useMemo } from 'react';
import { type CrossLap, lapOneGains, runningOrder } from '../lib/crossings.ts';
import { type Driver, teamStyle } from '../lib/session.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';
import { Places } from './Tower.tsx';

// The running order (A§13, #115): who was in which place at the line after each lap, from the crossings in the lap
// rows (lib/crossings.ts). A car whose crossing is unknown is never ranked: it follows its row's ranked cars, with the
// reason behind a tap. Races and sprints only; the caller decides.

const noun = (n: number) => `${n} driver${n === 1 ? '' : 's'}`;

export function Order({
  drivers,
  laps,
  grid,
  noGrid,
}: {
  drivers: readonly Driver[];
  laps: readonly CrossLap[];
  /** Grid position by driver number; null when the source has none. */
  grid: ReadonlyMap<number, number> | null;
  /** The reason shown in the Grid row when there is no grid. */
  noGrid: string;
}) {
  const rows = useMemo(() => runningOrder(laps), [laps]);
  if (!laps.some((l) => l.date_start !== null))
    return <p className="muted">No line crossings in this session's data.</p>;

  const byNumber = new Map(drivers.map((d) => [d.number, d]));
  const driver = (n: number): Driver => byNumber.get(n) ?? { number: n, acronym: String(n), name: null, team: null };
  const gridOrder = [...(grid ?? [])]
    .filter(([, p]) => Number.isInteger(p) && p >= 1)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);
  const gains = lapOneGains(rows[0], grid ?? new Map());
  const width = rows.reduce((w, r) => Math.max(w, r.order.length + r.missing.length), gridOrder.length);

  const places = Array.from({ length: width }, (_, i) => `P${i + 1}`);

  const cell = (n: number, extra?: { gain?: number | undefined; incomplete?: boolean }) => {
    const d = driver(n);
    return (
      <td key={n} className={extra?.incomplete ? 'drv muted' : 'drv'} style={teamStyle(d)} title={d.name ?? undefined}>
        {d.acronym}
        {extra?.incomplete && <span className="vh">, order incomplete</span>}
        {extra?.gain !== undefined && (
          <span className="gain">
            <Places places={extra.gain} />
          </span>
        )}
      </td>
    );
  };

  return (
    <>
      <p className="muted">
        The order at the line, from the timing data. It can differ from the classification where a time penalty applies.
      </p>
      <Scroll label="Running order">
        <table className="list order" aria-label="Running order">
          <thead>
            <tr>
              <th scope="col" className="ln">
                Lap
              </th>
              {places.map((p) => (
                <th key={p} scope="col">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="ln">
                Grid
              </th>
              {gridOrder.length > 0 ? (
                gridOrder.map((n) => cell(n))
              ) : (
                <td colSpan={Math.max(1, width)} className="muted">
                  {noGrid}
                </td>
              )}
            </tr>
            {rows.map((r) => (
              <tr key={r.lap}>
                <th scope="row" className="ln">
                  {r.missing.length > 0 ? (
                    <Note id={`ord-${r.lap}`} text={`${noun(r.missing.length)} without a crossing: order incomplete`}>
                      {r.lap}
                      <span aria-hidden="true">*</span>
                    </Note>
                  ) : (
                    r.lap
                  )}
                </th>
                {r.order.map((n) =>
                  cell(n, { gain: r.lap === 1 ? gains.get(n) : undefined, incomplete: r.missing.length > 0 }),
                )}
                {r.missing.map((n) => {
                  const d = driver(n);
                  return (
                    <td key={n} className="drv muted" style={teamStyle(d)} title={d.name ?? undefined}>
                      <Note id={`ord-${r.lap}-${n}`} text={`No crossing for ${d.acronym} after lap ${r.lap}`}>
                        {d.acronym} —
                      </Note>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}
