import type { Lap, Laps, SessionDetail } from '@f1/contracts';
import { useState } from 'react';
import { type Speed, speedTable, speedTops } from '../lib/bests.ts';
import { phaseName } from '../lib/quali.ts';
import { orderDrivers, teamStyle } from '../lib/session.ts';
import { fmtDelta, fmtLap } from '../lib/time.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// The speed traps and own bests (#114, A§13), under the lap table: each driver's top speed per trap with its lap, the
// session's top per column boxed (the Laps tile's purple), then the own best lap, the sum of the best sectors and the
// gap between them. In qualifying a Q1 | Q2 | Q3 switch picks the phase of the own bests; the speeds cover the session.
// Every `—` says why.

const COLUMNS = [
  ['i1_kph', 'i1', 'I1'],
  ['i2_kph', 'i2', 'I2'],
  ['st_kph', 'st', 'ST'],
] as const satisfies readonly (readonly [Speed, 'i1' | 'i2' | 'st' | 'top', string])[];
const TOP = ['top_kph', 'top', 'Top'] as const satisfies readonly [Speed, 'top', string];

// With `telemetry` (P7b, D1: only inside an opened session) a Top column follows ST and a Full throttle column follows
// the own best lap; the player's table leaves them out.
export function SpeedTable({
  detail,
  laps,
  telemetry = false,
}: {
  detail: SessionDetail;
  laps: Laps;
  telemetry?: boolean;
}) {
  const qualifying = detail.session.type === 'Qualifying';
  const phases = qualifying
    ? [...new Set(laps.flatMap((l) => (l.quali_phase === null ? [] : [l.quali_phase])))].sort((a, b) => a - b)
    : [];
  // Opens on the latest phase with laps, and follows it while no phase is picked.
  const [picked, setPicked] = useState<number | null>(null);
  const phase = picked !== null && phases.includes(picked) ? picked : (phases.at(-1) ?? null);
  const rows = speedTable(laps, phase);
  const tops = speedTops(laps);
  const drivers = new Map(orderDrivers(detail, laps).map((d) => [d.number, d]));
  const own = phase === null ? '' : `${phaseName(detail.session.name, phase)} `;
  const where = phase === null ? '' : ` in ${phaseName(detail.session.name, phase)}`;
  const lapText = (l: Lap) => `L${l.lap_number}`;
  const columns = telemetry ? [...COLUMNS, TOP] : COLUMNS;
  return (
    <>
      <h2>Speed traps and own bests</h2>
      {phases.length > 1 && (
        <div className="controls">
          <span className="label" aria-hidden="true">
            Phase
          </span>
          <fieldset className="segmented" aria-label="Phase">
            {phases.map((p) => (
              <button key={p} type="button" aria-pressed={p === phase} onClick={() => setPicked(p)}>
                {phaseName(detail.session.name, p)}
              </button>
            ))}
          </fieldset>
        </div>
      )}
      <ul className="legend" aria-label="Speed traps legend">
        <li>boxed: the fastest in the session</li>
        <li>under a speed: the lap of that reading</li>
        {telemetry && <li>Top: telemetry, anywhere on the lap</li>}
      </ul>
      <Scroll label="Speed traps and own bests">
        <table className="speeds" aria-label="Speed traps and own bests">
          <thead>
            <tr>
              <th scope="col">Driver</th>
              {columns.map(([, , label]) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
              <th scope="col">{own}Best lap</th>
              {telemetry && <th scope="col">{own}Full throttle</th>}
              <th scope="col">{own}Sum of best sectors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = drivers.get(r.driver);
              return (
                <tr key={r.driver}>
                  <th scope="row" className="drv" style={d && teamStyle(d)}>
                    {d?.acronym ?? r.driver}
                  </th>
                  {columns.map(([field, key, label]) => {
                    const l = r[key];
                    const kph = l?.[field] ?? null;
                    return (
                      <td key={field}>
                        {l === null || kph === null ? (
                          <Note
                            id={`speed-${r.driver}-${label}`}
                            text={
                              field === 'top_kph'
                                ? 'No telemetry on a valid lap'
                                : 'No speed-trap reading on a valid lap'
                            }
                          >
                            —
                          </Note>
                        ) : (
                          <>
                            {l === tops[field] ? (
                              <span className="t-purple">
                                {kph}
                                <span className="vh">, fastest</span>
                              </span>
                            ) : (
                              kph
                            )}
                            <small className="under">{lapText(l)}</small>
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    {r.lap?.lap_ms == null ? (
                      <Note
                        id={`speed-${r.driver}-lap`}
                        text={phase === null ? 'No valid lap with a time' : `No valid lap${where}`}
                      >
                        —
                      </Note>
                    ) : (
                      <>
                        {fmtLap(r.lap.lap_ms)}
                        <small className="under">{lapText(r.lap)}</small>
                      </>
                    )}
                  </td>
                  {telemetry && (
                    <td>
                      {r.lap?.lap_ms == null ? (
                        <Note
                          id={`speed-${r.driver}-ft`}
                          text={phase === null ? 'No valid lap with a time' : `No valid lap${where}`}
                        >
                          —
                        </Note>
                      ) : r.lap.full_throttle === null ? (
                        <Note
                          id={`speed-${r.driver}-ft`}
                          text={
                            r.lap.top_kph === null
                              ? 'No telemetry for this lap'
                              : 'Too few telemetry samples on this lap'
                          }
                        >
                          —
                        </Note>
                      ) : (
                        <>
                          {Math.round(r.lap.full_throttle * 100)} %<small className="under">{lapText(r.lap)}</small>
                        </>
                      )}
                    </td>
                  )}
                  <td>
                    {r.sum === null ? (
                      <Note id={`speed-${r.driver}-sum`} text={`Needs a valid time in S1, S2 and S3${where}`}>
                        —
                      </Note>
                    ) : (
                      <>
                        {fmtLap(r.sum)}
                        {r.lap?.lap_ms != null && (
                          <small className="under">{`${fmtDelta(r.sum - r.lap.lap_ms)} to own best lap`}</small>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}
