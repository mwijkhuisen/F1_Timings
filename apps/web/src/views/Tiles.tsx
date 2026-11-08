import type { Lap, Laps, SessionDetail } from '@f1/contracts';
import { sessionBests } from '../lib/bests.ts';
import { hasPole, phaseName, type Quali } from '../lib/quali.ts';
import { fmtDelta, fmtLap, fmtSector } from '../lib/time.ts';
import { Note } from '../ui/Note.tsx';

// The tiles above the lap table (P4b): the session's bests by A§9's rules, so a tile and the boxed
// cell always name the same lap. An absent value is `—` with a fixed reason behind a tap.

type Drivers = SessionDetail['drivers'];

const acronym = (drivers: Drivers, n: number) => drivers.find((d) => d.driver_number === n)?.acronym ?? String(n);
/** "ANT · L55". */
const holder = (drivers: Drivers, l: Lap) => `${acronym(drivers, l.driver_number)} · L${l.lap_number}`;

function Tile({
  id,
  label,
  value,
  who,
  reason,
}: {
  id: string;
  label: string;
  value: string | null;
  who: string | null;
  reason: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="v">
        {value ?? (
          <Note id={id} text={reason}>
            —
          </Note>
        )}
      </dd>
      {value !== null && who !== null && <dd className="who">{who}</dd>}
    </div>
  );
}

const SECTORS = [
  ['s1', 's1_ms'],
  ['s2', 's2_ms'],
  ['s3', 's3_ms'],
] as const;

export function SessionTiles({ detail, laps }: { detail: SessionDetail; laps: Laps }) {
  const b = sessionBests(laps);
  const who = (l: Lap | null) => l && holder(detail.drivers, l);
  return (
    <dl className="tiles" aria-label="Session bests">
      <Tile
        id="tile-lap"
        label="Fastest lap"
        value={b.lap?.lap_ms != null ? fmtLap(b.lap.lap_ms) : null}
        who={who(b.lap)}
        reason="No valid lap with a time"
      />
      {SECTORS.map(([key, field], i) => {
        const l = b[key];
        const ms = l?.[field] ?? null;
        return (
          <Tile
            key={key}
            id={`tile-${key}`}
            label={`Best S${i + 1}`}
            value={ms === null ? null : fmtSector(ms)}
            who={who(l)}
            reason={`No valid S${i + 1} time`}
          />
        );
      })}
      <Tile
        id="tile-sum"
        label="Sum of best sectors"
        value={b.sum === null ? null : fmtLap(b.sum)}
        who={b.sum !== null && b.lap?.lap_ms != null ? `${fmtDelta(b.sum - b.lap.lap_ms)} to the fastest lap` : null}
        reason="Needs a valid time in S1, S2 and S3"
      />
      <Tile
        id="tile-top"
        label="Top speed"
        value={b.top ? `${b.top.st_kph} km/h` : null}
        who={b.top && `${holder(detail.drivers, b.top)} · speed trap`}
        reason="No speed-trap reading on a valid lap"
      />
    </dl>
  );
}

/** Owner D2: pole, then each phase's cut-off but the last; shown before the session tiles. */
export function QualiTiles({ detail, quali }: { detail: SessionDetail; quali: Quali }) {
  const { phases } = quali;
  if (phases.length === 0) return null;
  const name = (p: number) => phaseName(detail.session.name, p);
  const pole = phases.at(-1)?.fastest ?? null;
  return (
    <dl className="tiles" aria-label="Qualifying">
      <Tile
        id="tile-pole"
        label={hasPole(quali) ? 'Pole' : `Fastest in ${name(phases.length)}`}
        value={pole?.lap_ms != null ? fmtLap(pole.lap_ms) : null}
        who={pole && `${acronym(detail.drivers, pole.driver_number)} · ${name(phases.length)}`}
        reason={`No valid lap in ${name(phases.length)}`}
      />
      {phases.slice(0, -1).map((phase, i) => (
        <Tile
          key={name(i + 1)}
          id={`tile-cut-${i + 1}`}
          label={`${name(i + 1)} cut-off${phase.through > 0 ? ` (P${phase.through})` : ''}`}
          value={phase.cutoff?.lap_ms != null ? fmtLap(phase.cutoff.lap_ms) : null}
          who={phase.cutoff && acronym(detail.drivers, phase.cutoff.driver_number)}
          reason={`Known once ${name(i + 2)} has laps`}
        />
      ))}
    </dl>
  );
}
