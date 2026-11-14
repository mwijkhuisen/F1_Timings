import type { Laps, RaceControl, SessionDetail, Stints } from '@f1/contracts';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useRaceControl, useStints } from '../lib/api.ts';
import { cycleText, PIT_WINDOW, pitCycles } from '../lib/crossings.ts';
import type { Driver } from '../lib/session.ts';
import { type Period, trackPeriods } from '../lib/track.ts';
import { Chart } from './Chart.tsx';
import { DeltaTable, Duel } from './DeltaTable.tsx';
import { gapChartLabel, gapChartOption } from './gap-chart-option.ts';
import { type ChartTokens, lapChartOption } from './lap-chart-option.ts';

/**
 * The pit cycles of every pair of the picked drivers (A§13, #115): one sentence each, from the stints, the line
 * crossings and race control, undefined while they load. `settled` (the player, #112, D1) lists a cycle only once its
 * after line is crossed.
 */
export function PitCycles({
  drivers,
  laps,
  periods,
  stints,
  rc,
  failed,
  settled = false,
}: {
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  stints: Stints | undefined;
  rc: readonly Pick<RaceControl[number], 'date' | 'message'>[] | undefined;
  failed: boolean;
  settled?: boolean;
}) {
  const lines = useMemo(() => {
    if (!stints || !rc) return null;
    const name = (n: number) => drivers.find((d) => d.number === n)?.acronym ?? String(n);
    return drivers.flatMap((a, i) =>
      drivers.slice(i + 1).flatMap((b) =>
        pitCycles(a.number, b.number, laps, stints, periods, rc)
          .filter((c) => !settled || c.after !== null)
          .map((c) => cycleText(c, name)),
      ),
    );
  }, [stints, rc, drivers, laps, periods, settled]);
  return (
    <section className="card">
      <h2>Pit cycles</h2>
      {failed ? (
        <p className="muted">Pit cycles need the stints and race control, which did not load.</p>
      ) : lines === null ? (
        <p className="muted">Loading pit cycles…</p>
      ) : lines.length === 0 ? (
        <p className="muted">No pit cycles within {PIT_WINDOW} laps for the picked drivers.</p>
      ) : (
        <ul className="cycles">
          {lines.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The session page's pit cycles: the stints from `/stints` (races only, so only they fetch it), race control as Compare's. */
function StoredPitCycles({
  session,
  rc,
  ...rest
}: {
  session: number;
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  rc: ReturnType<typeof useRaceControl>;
}) {
  const stints = useStints(session);
  return <PitCycles {...rest} stints={stints.data} rc={rc.data} failed={!!(stints.error || rc.error)} />;
}

/**
 * The comparison (A§13), of the selected drivers in pick order, the first the reference: the lap-time chart beside
 * the gap chart and the duel, then the reference choice and the sector deltas. `periods` band both charts; `children`
 * is the side column's last card. The session page's `Compare` and the player (#112) feed it.
 */
export function Comparison({
  detail,
  drivers,
  laps,
  periods,
  rcFailed = false,
  onReference,
  children,
}: {
  detail: SessionDetail;
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  rcFailed?: boolean;
  onReference: (driver: number) => void;
  children?: ReactNode;
}) {
  const [yWindow, setWindow] = useState<'fit' | '107'>('fit');
  const lapOption = useCallback(
    (t: ChartTokens) => lapChartOption(drivers, laps, t, { window: yWindow, periods, year: detail.meeting.year }),
    [drivers, laps, yWindow, periods, detail.meeting.year],
  );
  const gapOption = useCallback(
    (t: ChartTokens) => gapChartOption(drivers, laps, t, periods),
    [drivers, laps, periods],
  );

  const [ref, ...others] = drivers;
  if (!ref || others.length === 0) return <p>Pick at least 2 drivers.</p>;
  const names = (ds: readonly Driver[]) => ds.map((d) => d.acronym).join(', ');
  return (
    <>
      {rcFailed && <p className="muted">Race control did not load: no SC, VSC or red-flag bands.</p>}
      <div className="cgrid">
        <section className="card">
          <div className="panel-title">
            <h2>Lap times</h2>
            <fieldset className="segmented" aria-label="Window">
              <button type="button" aria-pressed={yWindow === 'fit'} onClick={() => setWindow('fit')}>
                Fit
              </button>
              <button type="button" aria-pressed={yWindow === '107'} onClick={() => setWindow('107')}>
                107 %
              </button>
            </fieldset>
          </div>
          <p className="keys">
            <span aria-hidden="true">●</span> own best · <span aria-hidden="true">○</span> deleted ·{' '}
            <span aria-hidden="true">▲</span> above the window
          </p>
          <Chart label={`Lap times: ${names(drivers)}`} option={lapOption} />
        </section>
        <div className="side">
          <section className="card">
            <div className="panel-title">
              <h2>Gap to {ref.acronym}</h2>
              <p>seconds at each line crossing</p>
            </div>
            <Chart label={gapChartLabel(drivers, laps)} option={gapOption} />
          </section>
          <section className="card">
            <h2>Best laps, sector by sector</h2>
            <Duel drivers={drivers} laps={laps} />
          </section>
          {children}
        </div>
      </div>
      <div className="controls">
        <span className="label" aria-hidden="true">
          Reference
        </span>
        <fieldset className="segmented" aria-label="Reference">
          {drivers.map((d) => (
            <button key={d.number} type="button" aria-pressed={d === ref} onClick={() => onReference(d.number)}>
              {d.acronym}
            </button>
          ))}
        </fieldset>
      </div>
      <h2>Sector deltas</h2>
      <DeltaTable drivers={drivers} laps={laps} />
    </>
  );
}

/**
 * The session page's comparison: race control (races only, the same query as the Laps tab) bands both charts once it
 * arrives, and in a race the pit cycles close the side column.
 */
export function Compare({
  session,
  detail,
  drivers,
  laps,
  onReference,
}: {
  session: number;
  detail: SessionDetail;
  drivers: readonly Driver[];
  laps: Laps;
  onReference: (driver: number) => void;
}) {
  const rc = useRaceControl(session, detail.session.type === 'Race' && laps.length > 0);
  const periods = useMemo(() => (rc.data ? trackPeriods(rc.data).periods : []), [rc.data]);
  return (
    <Comparison
      detail={detail}
      drivers={drivers}
      laps={laps}
      periods={periods}
      rcFailed={rc.error != null}
      onReference={onReference}
    >
      {detail.session.type === 'Race' && (
        <StoredPitCycles session={session} drivers={drivers} laps={laps} periods={periods} rc={rc} />
      )}
    </Comparison>
  );
}
