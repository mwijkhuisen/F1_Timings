import type { Lap, Laps, SessionDetail } from '@f1/contracts';
import { useState } from 'react';
import { compoundOf, type Driver, orderDrivers, teamStyle } from '../lib/session.ts';
import { fmtLap, fmtSector } from '../lib/time.ts';
import { Note } from '../ui/Note.tsx';

// The lap table (D1, D10): a drivers × laps matrix with one metric per cell.

export type Metric = 'lap' | 's1' | 's2' | 's3';

const LABEL: Record<Metric, string> = { lap: 'Lap', s1: 'S1', s2: 'S2', s3: 'S3' };
const FIELD = { lap: 'lap_ms', s1: 's1_ms', s2: 's2_ms', s3: 's3_ms' } as const;
// The colour's meaning as a title. Colour is never the only cue (D9): styles.css also boxes
// purple and bolds green, and the legend says so.
const COLOUR_TITLE = { purple: 'overall best', green: 'personal best', yellow: 'slower than personal best' } as const;

/**
 * Why a lap has no value for a metric. Only the cases the P1d probe over every
 * session since 2025 shows to be real (rates are nulls per lap of that kind):
 * - out-lap S1: 67 % outside races (7,965 of 11,839), 4 % in races; lap 1 out
 *   of the garage also lacks its lap time (86 %, 2,691 of 3,111);
 * - in-lap: outside races S3 14 % (1,663 of 11,574) and S2 5 %, against 2 %
 *   and 0.5 % on other laps;
 * - race lap 1 from the grid: 3–4 % per metric (31–41 of 1,075), ten times
 *   the other race laps.
 */
export function missingReason(
  lap: Pick<Lap, 'lap_number' | 'is_pit_out' | 'is_pit_in'>,
  metric: Metric,
  sessionType: string | null,
): string {
  if (lap.is_pit_out && (metric === 's1' || (metric === 'lap' && lap.lap_number === 1)))
    return 'Out-lap: no time in the OpenF1 data';
  if (lap.is_pit_in) return 'In-lap: no time in the OpenF1 data';
  // Races and sprints are both of type Race.
  if (sessionType === 'Race' && lap.lap_number === 1 && !lap.is_pit_out)
    return 'Lap 1 from the grid: no time in the OpenF1 data';
  return 'No time in the OpenF1 data';
}

type Entry = { lap: Lap; dot: string | null };

/** Laps per driver per lap number. The compound dot marks a run start: a new compound, or new tyres out of the pits. */
function entries(laps: Laps): Map<number, Map<number, Entry>> {
  const out = new Map<number, Map<number, Entry>>();
  const sorted = laps.toSorted((a, b) => a.driver_number - b.driver_number || a.lap_number - b.lap_number);
  let prev: Lap | undefined;
  for (const lap of sorted) {
    if (prev?.driver_number !== lap.driver_number) prev = undefined;
    const start = lap.compound !== prev?.compound || lap.is_pit_out === true;
    const dot = start ? compoundOf(lap.compound) : null;
    const mine = out.get(lap.driver_number) ?? new Map<number, Entry>();
    out.set(lap.driver_number, mine.set(lap.lap_number, { lap, dot }));
    prev = lap;
  }
  return out;
}

const classes = (...names: (string | false | null)[]) => names.filter(Boolean).join(' ') || undefined;

function Cell({
  entry,
  metric,
  sessionType,
}: {
  entry: Entry | undefined;
  metric: Metric;
  sessionType: string | null;
}) {
  if (!entry) return <td />;
  const { lap, dot } = entry;
  const value = lap[FIELD[metric]];
  const colour = lap.colour[metric];
  const text = value === null ? '—' : metric === 'lap' ? fmtLap(value) : fmtSector(value);
  const reason = lap.deleted
    ? lap.deleted_reason
      ? `Deleted: ${lap.deleted_reason}`
      : 'Deleted'
    : value === null
      ? missingReason(lap, metric, sessionType)
      : null;
  const shown = lap.deleted ? <s>{text}</s> : text;
  // The server makes every value of a deleted, in- or out-lap yellow (A§9): it is not ranked, so no title.
  const ranked = !lap.deleted && !lap.is_pit_in && !lap.is_pit_out;
  return (
    <td
      className={classes(colour && `t-${colour}`, lap.deleted && 'deleted')}
      title={colour && ranked ? COLOUR_TITLE[colour] : undefined}
    >
      {dot && (
        <span className={`cmp cmp-${dot}`} title={lap.compound ?? undefined}>
          {dot[0]?.toUpperCase()}
        </span>
      )}
      {reason === null ? (
        shown
      ) : (
        <Note id={`n-${lap.driver_number}-${lap.lap_number}-${metric}`} text={reason}>
          {shown}
        </Note>
      )}
      {lap.is_pit_in && <span className="badge">IN</span>}
      {lap.is_pit_out && <span className="badge">OUT</span>}
    </td>
  );
}

const DriverHead = ({ driver, scope }: { driver: Driver; scope: 'row' | 'col' }) => (
  <th scope={scope} className="drv" style={teamStyle(driver)} title={driver.name ?? undefined}>
    {driver.acronym}
  </th>
);

/** The matrix itself: drivers as rows, or as columns. */
export function LapGrid({
  detail,
  laps,
  metric,
  columns,
}: {
  detail: SessionDetail;
  laps: Laps;
  metric: Metric;
  columns: boolean;
}) {
  const drivers = orderDrivers(detail, laps);
  const byDriver = entries(laps);
  const last = laps.reduce((n, l) => Math.max(n, l.lap_number), 0);
  const lapNumbers = Array.from({ length: last }, (_, i) => i + 1);
  const cell = (d: Driver, n: number) => (
    <Cell
      key={`${d.number}-${n}`}
      entry={byDriver.get(d.number)?.get(n)}
      metric={metric}
      sessionType={detail.session.type}
    />
  );
  return (
    <div className="scroll">
      <table className={columns ? 'laps cols' : 'laps'} aria-label={`${LABEL[metric]} times`}>
        {columns ? (
          <>
            <thead>
              <tr>
                <th scope="col">Lap</th>
                {drivers.map((d) => (
                  <DriverHead key={d.number} driver={d} scope="col" />
                ))}
              </tr>
            </thead>
            <tbody>
              {lapNumbers.map((n) => (
                <tr key={n}>
                  <th scope="row">{n}</th>
                  {drivers.map((d) => cell(d, n))}
                </tr>
              ))}
            </tbody>
          </>
        ) : (
          <>
            <thead>
              <tr>
                <th scope="col">Driver</th>
                {lapNumbers.map((n) => (
                  <th key={n} scope="col">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.number}>
                  <DriverHead driver={d} scope="row" />
                  {lapNumbers.map((n) => cell(d, n))}
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
    </div>
  );
}

/** The metric switch and the orientation toggle are component state, not URL state (D1). */
export function LapTable({ detail, laps }: { detail: SessionDetail; laps: Laps }) {
  const [metric, setMetric] = useState<Metric>('lap');
  const [columns, setColumns] = useState(false);
  if (laps.length === 0) return <p>No laps yet.</p>;
  return (
    <>
      <div className="controls">
        <fieldset className="segmented" aria-label="Metric">
          {Object.entries(LABEL).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={metric === id} onClick={() => setMetric(id as Metric)}>
              {label}
            </button>
          ))}
        </fieldset>
        <button type="button" aria-pressed={columns} onClick={() => setColumns(!columns)}>
          Drivers as columns
        </button>
      </div>
      <p className="legend">
        <span className="t-purple">overall best</span> <span className="t-green">personal best</span>{' '}
        <span className="t-yellow">other</span>
      </p>
      <LapGrid detail={detail} laps={laps} metric={metric} columns={columns} />
    </>
  );
}
