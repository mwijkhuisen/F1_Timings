import type { Lap } from '@f1/contracts';
import { type Driver, teamStyle } from '../lib/session.ts';

// The mini-sector grid with the speed traps (D6): per selected driver, one row per lap.

/** The class of an OpenF1 segment code (A§6.1). Unknown codes are grey; 0 and a null element have no data. */
export function segClass(code: number | null): string {
  switch (code) {
    case 2048:
      return 'ms-yellow';
    case 2049:
      return 'ms-green';
    case 2051:
      return 'ms-purple';
    case 2064:
      return 'ms-pit';
    case 0:
    case null:
      return 'ms-none';
    default:
      return 'ms-grey';
  }
}

const TITLE: Record<string, string> = {
  'ms-purple': 'overall best',
  'ms-green': 'personal best',
  'ms-yellow': 'other',
  'ms-pit': 'pit lane',
  'ms-none': 'no data',
};
const titleOf = (code: number | null) => TITLE[segClass(code)] ?? `unknown code ${code}`;

const SECTORS = ['seg1', 'seg2', 'seg3'] as const;
const SPEEDS = ['i1_kph', 'i2_kph', 'st_kph'] as const;

const Seg = ({ code }: { code: number | null }) => (
  <span className={`ms ${segClass(code)}`} role="img" aria-label={titleOf(code)} title={titleOf(code)} />
);

export function MiniSectors({
  sessionType,
  laps,
  drivers,
}: {
  sessionType: string | null;
  laps: readonly Lap[];
  drivers: readonly Driver[];
}) {
  if (drivers.length === 0) return <p>Pick a driver.</p>;
  // Every lap row gets the session's widest array per sector; shorter ones are padded with no data.
  const width = SECTORS.map((s) => laps.reduce((n, l) => Math.max(n, l[s]?.length ?? 0), 0));
  return (
    <>
      {sessionType === 'Race' && (
        <p className="banner" role="note">
          Mini-sector colours unreliable in races
        </p>
      )}
      <p className="legend">
        {['ms-purple', 'ms-green', 'ms-yellow', 'ms-pit', 'ms-grey', 'ms-none'].map((c) => (
          <span key={c}>
            <span className={`ms ${c}`} /> {TITLE[c] ?? 'unknown code'}
          </span>
        ))}
      </p>
      <div className="scroll">
        <table className="laps minisectors" aria-label="Mini-sectors and speed traps (km/h)">
          <thead>
            <tr>
              {['Lap', 'S1', 'S2', 'S3', 'I1', 'I2', 'ST'].map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          {drivers.map((d) => (
            <tbody key={d.number}>
              <tr>
                <th scope="rowgroup" colSpan={7} className="drv" style={teamStyle(d)} title={d.name ?? undefined}>
                  {d.acronym}
                </th>
              </tr>
              {laps
                .filter((l) => l.driver_number === d.number)
                .toSorted((a, b) => a.lap_number - b.lap_number)
                .map((l) => (
                  <tr key={l.lap_number}>
                    <th
                      scope="row"
                      title={l.deleted ? (l.deleted_reason ? `Deleted: ${l.deleted_reason}` : 'Deleted') : undefined}
                    >
                      {l.deleted ? <s>{l.lap_number}</s> : l.lap_number}
                      {l.is_pit_in && <span className="badge">IN</span>}
                      {l.is_pit_out && <span className="badge">OUT</span>}
                    </th>
                    {SECTORS.map((s, i) => (
                      <td key={s} className="segs">
                        {Array.from({ length: width[i] ?? 0 }, (_, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length row of positions
                          <Seg key={j} code={l[s]?.[j] ?? null} />
                        ))}
                      </td>
                    ))}
                    {SPEEDS.map((s) => (
                      <td key={s}>{l[s] ?? '—'}</td>
                    ))}
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
