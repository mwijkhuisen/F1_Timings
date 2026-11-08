import type { Laps, SessionDetail } from '@f1/contracts';
import { useCallback, useMemo, useState } from 'react';
import { useRaceControl } from '../lib/api.ts';
import type { Driver } from '../lib/session.ts';
import { trackPeriods } from '../lib/track.ts';
import { Chart } from './Chart.tsx';
import { DeltaTable, Duel } from './DeltaTable.tsx';
import { gapChartOption } from './gap-chart-option.ts';
import { type ChartTokens, lapChartOption } from './lap-chart-option.ts';

/**
 * The comparison (A§13), of the selected drivers in pick order, the first the reference: the lap-time chart beside
 * the gap chart and the duel, then the reference choice and the sector deltas. Race control (races only, the same
 * query as the Laps tab) bands both charts once it arrives.
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
  const [yWindow, setWindow] = useState<'fit' | '107'>('fit');
  const lapOption = useCallback(
    (t: ChartTokens) => lapChartOption(drivers, laps, t, { window: yWindow, periods }),
    [drivers, laps, yWindow, periods],
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
      {rc.error && <p className="muted">Race control did not load: no SC, VSC or red-flag bands.</p>}
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
            <Chart label={`Gap to ${ref.acronym}: ${names(others)}`} option={gapOption} />
          </section>
          <section className="card">
            <h2>Best laps, sector by sector</h2>
            <Duel drivers={drivers} laps={laps} />
          </section>
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
