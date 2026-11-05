import { type Obj, type Views, view } from '@f1/contracts';
import { type Driver, teamColour, teamStyle } from '../lib/session.ts';

// The timing tower (A§13): one row per TimingData line, from the stream's state. Feed text is rendered as text only.

type Line = NonNullable<NonNullable<Views['TimingData']['Lines']>[string]>;

export type TowerRow = {
  driver: Driver;
  position: string | undefined;
  gap: string | undefined;
  interval: string | undefined;
  last: string | undefined;
  best: string | undefined;
  /** The whole typed line, for the columns built on it. */
  line: Line;
};

const NUMBER = /^\d{1,3}$/;

/** TimingData lines ordered by `Line` (then number), with the DriverList's Tla and team colour. */
export function towerRows(state: Obj): TowerRow[] {
  const list = view(state, 'DriverList') ?? {};
  const lines = view(state, 'TimingData')?.Lines ?? {};
  return Object.entries(lines)
    .flatMap(([n, line]) => (line && NUMBER.test(n) ? [{ n: Number(n), line }] : []))
    .sort((a, b) => (a.line.Line ?? 999) - (b.line.Line ?? 999) || a.n - b.n)
    .map(({ n, line }) => {
      const d = list[n];
      return {
        driver: {
          number: n,
          acronym: d?.Tla ?? String(n),
          name: d?.FullName ?? null,
          team: teamColour(d?.TeamColour ?? null),
        },
        position: line.Position,
        gap: line.GapToLeader,
        interval: line.IntervalToPositionAhead?.Value,
        last: line.LastLapTime?.Value,
        best: line.BestLapTime?.Value,
        line,
      };
    });
}

export function Tower({ state }: { state: Obj }) {
  const rows = towerRows(state);
  if (rows.length === 0) return <p className="muted">No timing yet.</p>;
  return (
    <div className="scroll">
      <table className="list tower" aria-label="Timing tower">
        <thead>
          <tr>
            <th scope="col">Pos</th>
            <th scope="col">Driver</th>
            <th scope="col">Gap</th>
            <th scope="col">Int</th>
            <th scope="col">Last</th>
            <th scope="col">Best</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.driver.number}>
              <td>{r.position}</td>
              <th scope="row" className="drv" style={teamStyle(r.driver)} title={r.driver.name ?? undefined}>
                {r.driver.acronym}
              </th>
              <td>{r.gap}</td>
              <td>{r.interval}</td>
              <td>{r.last}</td>
              <td>{r.best}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
