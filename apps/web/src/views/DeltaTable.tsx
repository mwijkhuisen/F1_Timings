import { type Lap, type SectorDelta, sectorDeltas } from '@f1/contracts';
import type { CSSProperties } from 'react';
import { type Driver, teamStyle } from '../lib/session.ts';
import { fmtDelta, fmtLap } from '../lib/time.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// The sector-delta table (D5): the first selected driver is the reference (E4); every other
// driver gets a Δ S1/S2/S3 group, that driver − the reference. A Best-lap row heads it (E3).
// Above it on Compare, the duel (C7): each other driver's best lap against the reference's, sector by sector.

type DeltaLap = Pick<
  Lap,
  'driver_number' | 'lap_number' | 'lap_ms' | 's1_ms' | 's2_ms' | 's3_ms' | 'deleted' | 'colour'
>;

const SECTORS = ['s1', 's2', 's3'] as const;
type Sector = (typeof SECTORS)[number];

/**
 * Why a delta is `—` (#99): a lap missing ("No lap 12 for NOR"; `lap` null is the Best-lap row, "No best lap for NOR"),
 * a deleted lap, or a sector time missing ("No S2 time for NOR", "for NOR and VER" when both are).
 */
export function deltaReason(
  sector: Sector,
  pair: readonly (readonly [Driver, DeltaLap | undefined])[],
  lap: number | null,
): string {
  const who = (missing: (l: DeltaLap | undefined) => boolean) =>
    pair
      .filter(([, l]) => missing(l))
      .map(([d]) => d.acronym)
      .join(' and ');
  const noLap = who((l) => l === undefined);
  if (noLap) return lap === null ? `No best lap for ${noLap}` : `No lap ${lap} for ${noLap}`;
  if (pair.some(([, l]) => l?.deleted)) return 'Deleted lap';
  return `No ${sector.toUpperCase()} time for ${who((l) => l?.[`${sector}_ms` as const] === null)}`;
}

/** The driver's own best lap: the server colours exactly that lap purple or green (A§9). */
const bestOf = (laps: readonly DeltaLap[]) => laps.find((l) => l.colour.lap === 'purple' || l.colour.lap === 'green');

/** Lap 0 pairs the two best laps whatever their own numbers (E3). */
const bestDeltas = (ref: DeltaLap | undefined, other: DeltaLap | undefined) =>
  ref && other ? sectorDeltas([{ ...ref, lap_number: 0 }], [{ ...other, lap_number: 0 }])[0] : undefined;

/** A bar's half-width: |Δ| / `full` ms of the half, capped at the half (50 %). */
const barWidth = (ms: number, full: number) =>
  ({ '--w': `${Math.min(50, (Math.abs(ms) / full) * 50).toFixed(1)}%` }) as CSSProperties;

/** `id`: unique on the page, per row and driver; `reason` says why a sector is `—`. */
const Cells = ({
  delta,
  id,
  reason,
}: {
  delta: SectorDelta | undefined;
  id: string;
  reason: (s: Sector) => string;
}) => (
  <>
    {SECTORS.map((s) => {
      const v = delta?.[s] ?? null;
      if (v === null)
        return (
          <td key={s}>
            <Note id={`${id}-${s}`} text={reason(s)}>
              —
            </Note>
          </td>
        );
      // A bar from the centre hairline: left when faster than the reference, 500 ms fills the half. None for 0.
      return (
        <td key={s} className="dc">
          {fmtDelta(v)}
          {v !== 0 && <i className={v < 0 ? 'db neg' : 'db pos'} aria-hidden="true" style={barWidth(v, 500)} />}
        </td>
      );
    })}
  </>
);

/** "RUS L41 1:21.316": the lap time coloured purple or green, as the server coloured it. */
const BestLap = ({ driver, lap }: { driver: Driver; lap: DeltaLap }) => (
  <>
    {driver.acronym} L{lap.lap_number}{' '}
    <span className={`t-${lap.colour.lap}`}>{lap.lap_ms === null ? '—' : fmtLap(lap.lap_ms)}</span>
  </>
);

/**
 * The duel (C7): one block per other driver, its own best lap against the reference's, sector by sector. A bar
 * grows from the centre toward the faster driver, in that driver's colour; 300 ms fills the half.
 */
export function Duel({ drivers, laps }: { drivers: readonly Driver[]; laps: readonly DeltaLap[] }) {
  const [ref, ...others] = drivers;
  if (!ref) return null;
  const bestOfDriver = (d: Driver) => bestOf(laps.filter((l) => l.driver_number === d.number));
  const refBest = bestOfDriver(ref);
  return (
    <>
      {others.map((d) => {
        const best = bestOfDriver(d);
        if (!refBest || !best)
          return (
            <p key={d.number} className="muted">
              {d.acronym} vs {ref.acronym}: no best lap to compare.
            </p>
          );
        const delta = bestDeltas(refBest, best);
        return (
          <div key={d.number} className="duelbox">
            <h3>
              <BestLap driver={d} lap={best} /> vs <BestLap driver={ref} lap={refBest} />
            </h3>
            <dl className="duel">
              {SECTORS.map((s) => {
                const v = delta?.[s] ?? null;
                const faster = v !== null && v < 0 ? d : ref;
                return (
                  <div key={s}>
                    <dt>{s.toUpperCase()}</dt>
                    <dd className="track" aria-hidden="true">
                      {v !== null && v !== 0 && (
                        <span
                          className={v < 0 ? 'fill r' : 'fill l'}
                          style={{ ...teamStyle(faster), ...barWidth(v, 300) }}
                        />
                      )}
                    </dd>
                    <dd className="val">
                      {v === null ? (
                        <Note
                          id={`duel-${d.number}-${s}`}
                          text={deltaReason(
                            s,
                            [
                              [d, best],
                              [ref, refBest],
                            ],
                            null,
                          )}
                        >
                          —
                        </Note>
                      ) : (
                        fmtDelta(v)
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="duelaxis">
              <span>◀ {ref.acronym} faster</span>
              <span>{d.acronym} faster ▶</span>
            </p>
            {best.lap_ms !== null && refBest.lap_ms !== null && (
              <p className="foot">Lap {fmtDelta(best.lap_ms - refBest.lap_ms)}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

export function DeltaTable({ drivers, laps }: { drivers: readonly Driver[]; laps: readonly DeltaLap[] }) {
  const [ref, ...others] = drivers;
  if (!ref) return null;
  const lapsOf = (d: Driver) => laps.filter((l) => l.driver_number === d.number);
  const byNumber = (ls: readonly DeltaLap[]) => new Map(ls.map((l) => [l.lap_number, l]));
  const refLaps = lapsOf(ref);
  const refBest = bestOf(refLaps);
  const refByLap = byNumber(refLaps);
  const groups = others.map((d) => {
    const mine = lapsOf(d);
    const best = bestOf(mine);
    const own = byNumber(mine);
    return {
      driver: d,
      best,
      bestDelta: bestDeltas(refBest, best),
      byLap: new Map(sectorDeltas(refLaps, mine).map((x) => [x.lap_number, x])),
      /** Why a sector of lap `n` (null: the best laps) is `—`, the other driver first. */
      reason: (n: number | null) => (s: Sector) =>
        deltaReason(
          s,
          [
            [d, n === null ? best : own.get(n)],
            [ref, n === null ? refBest : refByLap.get(n)],
          ],
          n,
        ),
    };
  });
  const lapNumbers = [...new Set(groups.flatMap((g) => [...g.byLap.keys()]))].sort((a, b) => a - b);
  const num = (l: DeltaLap | undefined) => (l ? `L${l.lap_number}` : 'L—');

  return (
    <>
      {refLaps.length === 0 && <p className="muted">{ref.acronym} has no laps in this session: no deltas.</p>}
      <Scroll label="Sector deltas">
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
            {/* Always there: a missing best lap shows L— and — cells. Two lines, so two drivers fit 390 px. */}
            <tr>
              <th scope="row">
                Best lap
                <br />
                {num(refBest)} vs {groups.map((g) => num(g.best)).join(', ')}
              </th>
              {groups.map((g) => (
                <Cells
                  key={g.driver.number}
                  delta={g.bestDelta}
                  id={`dt-best-${g.driver.number}`}
                  reason={g.reason(null)}
                />
              ))}
            </tr>
            {lapNumbers.map((n) => (
              <tr key={n}>
                <th scope="row">{n}</th>
                {groups.map((g) => (
                  <Cells
                    key={g.driver.number}
                    delta={g.byLap.get(n)}
                    id={`dt-${n}-${g.driver.number}`}
                    reason={g.reason(n)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}
