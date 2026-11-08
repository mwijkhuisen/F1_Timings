import type { Laps } from '@f1/contracts';
import { useCallback } from 'react';
import type { Driver } from '../lib/session.ts';
import { Chart } from './Chart.tsx';
import { DeltaTable } from './DeltaTable.tsx';
import { type ChartTokens, lapChartOption } from './lap-chart-option.ts';

/** The comparison (A§13): the lap-time chart and the sector deltas of the selected drivers, in pick order. */
export function Compare({ drivers, laps }: { drivers: readonly Driver[]; laps: Laps }) {
  const lapOption = useCallback(
    (t: ChartTokens) => lapChartOption(drivers, laps, t, { window: 'fit', periods: [] }),
    [drivers, laps],
  );
  if (drivers.length < 2) return <p>Pick at least 2 drivers.</p>;
  return (
    <>
      <Chart label={`Lap times: ${drivers.map((d) => d.acronym).join(', ')}`} option={lapOption} />
      <h2>Sector deltas</h2>
      <DeltaTable drivers={drivers} laps={laps} />
    </>
  );
}
