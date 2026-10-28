import type { Laps } from '@f1/contracts';
import type { Driver } from '../lib/session.ts';
import { DeltaTable } from './DeltaTable.tsx';
import { LapChart } from './LapChart.tsx';

/** The comparison (A§13): the lap-time chart and the sector deltas of the selected drivers, in pick order. */
export function Compare({ drivers, laps }: { drivers: readonly Driver[]; laps: Laps }) {
  if (drivers.length < 2) return <p>Pick at least 2 drivers.</p>;
  return (
    <>
      <LapChart drivers={drivers} laps={laps} />
      <h2>Sector deltas</h2>
      <DeltaTable drivers={drivers} laps={laps} />
    </>
  );
}
