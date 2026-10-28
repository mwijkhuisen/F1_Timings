import { type Lap, type SectorDelta, sectorDeltas } from '@f1/contracts';
import { type Driver, teamStyle } from '../lib/session.ts';
import { fmtDelta } from '../lib/time.ts';

// The sector-delta table (D5): the first selected driver is the reference (E4); every other
// driver gets a Δ S1/S2/S3 group, that driver − the reference. A Best-lap row heads it (E3).

type DeltaLap = Pick<Lap, 'driver_number' | 'lap_number' | 's1_ms' | 's2_ms' | 's3_ms' | 'deleted' | 'colour'>;

/** The driver's own best lap: the server colours exactly that lap purple or green (A§9). */
const bestOf = (laps: readonly DeltaLap[]) => laps.find((l) => l.colour.lap === 'purple' || l.colour.lap === 'green');

const Cells = ({ delta }: { delta: SectorDelta | undefined }) => (
  <>
    {(['s1', 's2', 's3'] as const).map((s) => {
      const v = delta?.[s] ?? null;
      return <td key={s}>{v === null ? '—' : fmtDelta(v)}</td>;
    })}
  </>
);

export function DeltaTable({ drivers, laps }: { drivers: readonly Driver[]; laps: readonly DeltaLap[] }) {
  const [ref, ...others] = drivers;
  if (!ref) return null;
  const lapsOf = (d: Driver) => laps.filter((l) => l.driver_number === d.number);
  const refLaps = lapsOf(ref);
  const refBest = bestOf(refLaps);
  const groups = others.map((d) => {
    const mine = lapsOf(d);
    const best = bestOf(mine);
    return {
      driver: d,
      best,
      // Lap 0 pairs the two best laps whatever their own numbers (E3).
      bestDelta:
        refBest && best ? sectorDeltas([{ ...refBest, lap_number: 0 }], [{ ...best, lap_number: 0 }])[0] : undefined,
      byLap: new Map(sectorDeltas(refLaps, mine).map((x) => [x.lap_number, x])),
    };
  });
  const lapNumbers = [...new Set(groups.flatMap((g) => [...g.byLap.keys()]))].sort((a, b) => a - b);
  const num = (l: DeltaLap | undefined) => (l ? `L${l.lap_number}` : 'L—');

  return (
    <div className="scroll">
      <table className="laps deltas" aria-label="Sector deltas">
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Lap
            </th>
            {groups.map(({ driver }) => (
              <th key={driver.number} scope="colgroup" colSpan={3} className="drv" style={teamStyle(driver)}>
                {driver.acronym} Δ vs {ref.acronym}
              </th>
            ))}
          </tr>
          <tr>
            {groups.flatMap(({ driver }) =>
              ['S1', 'S2', 'S3'].map((s) => (
                <th key={`${driver.number}-${s}`} scope="col">
                  {s}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {refBest && (
            <tr>
              <th scope="row">
                Best lap ({num(refBest)} vs {groups.map((g) => num(g.best)).join(', ')})
              </th>
              {groups.map((g) => (
                <Cells key={g.driver.number} delta={g.bestDelta} />
              ))}
            </tr>
          )}
          {lapNumbers.map((n) => (
            <tr key={n}>
              <th scope="row">{n}</th>
              {groups.map((g) => (
                <Cells key={g.driver.number} delta={g.byLap.get(n)} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
