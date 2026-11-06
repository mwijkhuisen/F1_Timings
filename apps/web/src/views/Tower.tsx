import { type Obj, type Views, view } from '@f1/contracts';
import { compoundOf, type Driver, teamColour, teamStyle } from '../lib/session.ts';
import { segClass } from './MiniSectors.tsx';

// The timing tower (A§13): one row per TimingData line, from the stream's state. Feed text is rendered as text only.

type Line = NonNullable<NonNullable<Views['TimingData']['Lines']>[string]>;
type Stint = NonNullable<
  NonNullable<NonNullable<NonNullable<Views['TimingAppData']['Lines']>[string]>['Stints']>[string]
>;

export type TowerRow = {
  driver: Driver;
  position: string | undefined;
  gap: string | undefined;
  interval: string | undefined;
  last: string | undefined;
  best: string | undefined;
  /** The driver's latest stint. */
  tyre: Stint | undefined;
  /** The whole typed line, for the columns built on it. */
  line: Line;
};

const NUMBER = /^\d{1,3}$/;

/** TimingData lines ordered by `Line` (then number), with the DriverList's Tla and team colour. */
export function towerRows(state: Obj): TowerRow[] {
  const list = view(state, 'DriverList') ?? {};
  const lines = view(state, 'TimingData')?.Lines ?? {};
  const apps = view(state, 'TimingAppData')?.Lines ?? {};
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
        tyre: Object.entries(apps[n]?.Stints ?? {})
          .filter(([i]) => NUMBER.test(i))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .at(-1)?.[1],
        line,
      };
    });
}

/** A flagged value's class: purple for the overall best, green for a personal best (as in the lap table). */
const flag = (v: { OverallFastest?: boolean | undefined; PersonalFastest?: boolean | undefined } | undefined) =>
  v?.OverallFastest ? 't-purple' : v?.PersonalFastest ? 't-green' : undefined;

const SECTORS = ['0', '1', '2'];

function Sector({ s }: { s: NonNullable<Line['Sectors']>[string] }) {
  const segs = Object.entries(s?.Segments ?? {})
    .filter(([i]) => NUMBER.test(i))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return (
    <td className="sector">
      <span className={flag(s)}>{s?.Value}</span>
      {segs.map(([i, seg]) => (
        <span key={i} className={`ms ${segClass(seg?.Status ?? null)}`} aria-hidden="true" />
      ))}
    </td>
  );
}

export function Tower({ state, sessionKey }: { state: Obj; sessionKey?: number | undefined }) {
  // After a session switch the feed shows the previous session until the new one's SessionInfo arrives.
  if (sessionKey !== undefined && view(state, 'SessionInfo')?.Key !== sessionKey)
    return <p className="muted">Waiting for the session: the feed still shows the previous one.</p>;
  const rows = towerRows(state);
  if (rows.length === 0) return <p className="muted">No timing yet.</p>;
  return (
    <div className="scroll">
      <table className="list tower" aria-label="Timing tower">
        <thead>
          <tr>
            {['Pos', 'Driver', 'Gap', 'Int', 'Last', 'Best', 'S1', 'S2', 'S3', 'Tyre', 'Pits'].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const { line } = r;
            const compound = r.tyre && (compoundOf(r.tyre.Compound ?? null) ?? 'unknown');
            return (
              <tr key={r.driver.number} className={line.Retired || line.Stopped ? 'out' : undefined}>
                <td>{r.position}</td>
                <th scope="row" className="drv" style={teamStyle(r.driver)} title={r.driver.name ?? undefined}>
                  {r.driver.acronym}
                </th>
                <td>{r.gap}</td>
                <td>{r.interval}</td>
                <td className={flag(line.LastLapTime)}>{r.last}</td>
                <td>{r.best}</td>
                {SECTORS.map((i) => (
                  <Sector key={i} s={line.Sectors?.[i]} />
                ))}
                <td>
                  {r.tyre && (
                    <span className={`cmp cmp-${compound}`} title={r.tyre.Compound}>
                      {compound?.[0]?.toUpperCase()}
                    </span>
                  )}
                  {r.tyre?.TotalLaps}
                </td>
                <td>
                  {line.NumberOfPitStops}
                  {line.InPit && <span className="badge">IN PIT</span>}
                  {line.PitOut && <span className="badge">OUT</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
