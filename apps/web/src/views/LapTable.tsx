import type { Lap, Laps, SessionDetail } from '@f1/contracts';
import { type ReactNode, useState } from 'react';
import { deltaStep, ownBests } from '../lib/bests.ts';
import { compoundOf, type Driver, orderDrivers, teamStyle } from '../lib/session.ts';
import { fmtClock, fmtDelta, fmtLap, fmtSector } from '../lib/time.ts';
import { KIND_LABEL, KIND_NAME, type Kind, kindsAt, type Period, type Track } from '../lib/track.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// The lap table (D1, D10; P4b): a drivers × laps matrix with one metric per cell. Only the bests carry
// colour: purple boxed and tinted, green bold, "other" plain. In- and out-laps are dimmed, a new run gets a
// rule, SC, VSC and red-flag laps get a header band, and the driver's own best is a frozen column (rows) or
// a sticky row (columns). "Δ to own best" swaps each value for its gap to that best, in steps (owner D3).

export type Metric = 'lap' | 's1' | 's2' | 's3';
export type Show = 'times' | 'delta';

const LABEL: Record<Metric, string> = { lap: 'Lap', s1: 'S1', s2: 'S2', s3: 'S3' };
const FIELD = { lap: 'lap_ms', s1: 's1_ms', s2: 's2_ms', s3: 's3_ms' } as const;
// The colour's meaning as a title. Colour is never the only cue (D9): styles.css also boxes
// purple and bolds green, the legend says so, and a screen reader hears the words. "Other"
// (the server's yellow) is plain text (A§13, O1).
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

/** `stint`: a run start after the driver's first lap, drawn as a rule. */
type Entry = { lap: Lap; dot: string | null; stint: boolean };

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
    out.set(lap.driver_number, mine.set(lap.lap_number, { lap, dot, stint: start && prev !== undefined }));
    prev = lap;
  }
  return out;
}

const classes = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ') || undefined;
const fmt = (metric: Metric, ms: number) => (metric === 'lap' ? fmtLap(ms) : fmtSector(ms));
/** "Safety car, virtual safety car": every kind on the lap, most severe first. */
const bandTitle = (kinds: Kind[]) =>
  kinds.map((k, i) => (i === 0 ? KIND_NAME[k] : KIND_NAME[k].toLowerCase())).join(', ');

function Cell({
  entry,
  metric,
  sessionType,
  show,
  own,
  kind,
}: {
  entry: Entry | undefined;
  metric: Metric;
  sessionType: string | null;
  show: Show;
  /** The driver's own best for the metric, for Δ. */
  own: Lap | undefined;
  /** The band on this lap, for Δ. */
  kind: Kind | undefined;
}) {
  if (!entry) return <td />;
  const { lap, dot, stint } = entry;
  const value = lap[FIELD[metric]];
  const colour = lap.colour[metric];
  const text = value === null ? '—' : fmt(metric, value);
  const reason = lap.deleted
    ? lap.deleted_reason
      ? `Deleted: ${lap.deleted_reason}`
      : 'Deleted'
    : value === null
      ? missingReason(lap, metric, sessionType)
      : null;
  const io = lap.is_pit_in || lap.is_pit_out;
  // The server makes every value of a deleted, in- or out-lap yellow (A§9): it is not ranked, so no title.
  const ranked = !lap.deleted && !io;
  const best = colour === 'purple' || colour === 'green' ? colour : null;
  const noted = (shown: ReactNode) =>
    reason === null ? (
      shown
    ) : (
      <Note id={`n-${lap.driver_number}-${lap.lap_number}-${metric}`} text={reason}>
        {shown}
      </Note>
    );

  // Δ: the first word that applies, else "best" or the gap with its step behind it.
  let body: ReactNode;
  let heat = 0;
  let boxed = show === 'times';
  if (show === 'times') body = noted(lap.deleted ? <s>{text}</s> : text);
  else if (value === null) body = noted('—');
  else if (lap.deleted) body = noted(<span className="muted">deleted</span>);
  else if (lap.is_pit_in || lap.is_pit_out || kind)
    body = <span className="muted">{lap.is_pit_in ? 'in' : lap.is_pit_out ? 'out' : kind && KIND_LABEL[kind]}</span>;
  else {
    const diff = value - (own?.[FIELD[metric]] ?? value);
    boxed = diff === 0;
    heat = own ? deltaStep(diff, own[FIELD[metric]] ?? value) : 0;
    body = diff === 0 ? 'best' : fmtDelta(diff, 2);
  }

  return (
    <td
      className={classes(
        boxed && best && `t-${best}`,
        lap.deleted && 'deleted',
        io && 'io',
        stint && 'stint',
        heat > 0 && `heat-${heat}`,
      )}
      title={colour && ranked ? COLOUR_TITLE[colour] : undefined}
    >
      {dot && (
        <>
          <span className={`cmp cmp-${dot}`} title={lap.compound ?? undefined} aria-hidden="true">
            {dot[0]?.toUpperCase()}
          </span>
          <span className="vh">{dot} tyres, </span>
        </>
      )}
      {body}
      {best && ranked && <span className="vh">, {COLOUR_TITLE[best]}</span>}
      {show === 'times' && lap.is_pit_in && <span className="badge">IN</span>}
      {/* An out-lap that starts a run already shows the new set's dot. */}
      {show === 'times' && lap.is_pit_out && !dot && <span className="badge">OUT</span>}
    </td>
  );
}

/** The driver's own best: the value in its server colour, then the lap; `—` with a reason without one. */
function BestCell({ own, metric, driver }: { own: Lap | undefined; metric: Metric; driver: number }) {
  const value = own?.[FIELD[metric]] ?? null;
  if (!own || value === null)
    return (
      <td className="best">
        <Note id={`nb-${driver}-${metric}`} text={`No valid ${metric === 'lap' ? 'lap' : LABEL[metric]} time`}>
          —
        </Note>
      </td>
    );
  const colour = own.colour[metric];
  const best = colour === 'purple' || colour === 'green' ? colour : null;
  return (
    <td className="best" title={`Lap ${own.lap_number}`}>
      <span className={best ? `t-${best}` : undefined}>{fmt(metric, value)}</span>
      {best && <span className="vh">, {COLOUR_TITLE[best]}</span>}
      <small>L{own.lap_number}</small>
    </td>
  );
}

/** A lap number's header, with the band of the most severe period on it. */
function LapHead({ n, periods, scope }: { n: number; periods: readonly Period[]; scope: 'row' | 'col' }) {
  const kinds = kindsAt(periods, n);
  const kind = kinds[0];
  return (
    <th scope={scope} className={kind && `band band-${kind}`} title={kind && bandTitle(kinds)}>
      {n}
      {kind && <small> {KIND_LABEL[kind]}</small>}
    </th>
  );
}

const DriverHead = ({ driver, scope }: { driver: Driver; scope: 'row' | 'col' }) => (
  <th scope={scope} className="drv" style={teamStyle(driver)} title={driver.name ?? undefined}>
    {driver.acronym}
  </th>
);

const tableName = (metric: Metric, show: Show) => `${LABEL[metric]} ${show === 'delta' ? 'Δ to own best' : 'times'}`;

/** The matrix itself: drivers as rows, or as columns. */
export function LapGrid({
  detail,
  laps,
  metric,
  columns,
  show = 'times',
  periods = [],
}: {
  detail: SessionDetail;
  laps: Laps;
  metric: Metric;
  columns: boolean;
  show?: Show;
  periods?: readonly Period[];
}) {
  const drivers = orderDrivers(detail, laps);
  const byDriver = entries(laps);
  const own = ownBests(laps, FIELD[metric]);
  const last = laps.reduce((n, l) => Math.max(n, l.lap_number), 0);
  const lapNumbers = Array.from({ length: last }, (_, i) => i + 1);
  const cell = (d: Driver, n: number) => (
    <Cell
      key={`${d.number}-${n}`}
      entry={byDriver.get(d.number)?.get(n)}
      metric={metric}
      sessionType={detail.session.type}
      show={show}
      own={own.get(d.number)}
      kind={kindsAt(periods, n)[0]}
    />
  );
  const best = (d: Driver) => <BestCell key={d.number} own={own.get(d.number)} metric={metric} driver={d.number} />;
  const name = tableName(metric, show);
  return (
    <Scroll label={name}>
      <table className={columns ? 'laps lap-grid cols' : 'laps lap-grid'} aria-label={name}>
        {columns ? (
          <>
            <thead>
              <tr>
                <th scope="col">Lap</th>
                {drivers.map((d) => (
                  <DriverHead key={d.number} driver={d} scope="col" />
                ))}
              </tr>
              <tr>
                <th scope="row" className="best">
                  Best
                </th>
                {drivers.map(best)}
              </tr>
            </thead>
            <tbody>
              {lapNumbers.map((n) => (
                <tr key={n}>
                  <LapHead n={n} periods={periods} scope="row" />
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
                <th scope="col" className="best">
                  Best
                </th>
                {lapNumbers.map((n) => (
                  <LapHead key={n} n={n} periods={periods} scope="col" />
                ))}
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.number}>
                  <DriverHead driver={d} scope="row" />
                  {best(d)}
                  {lapNumbers.map((n) => cell(d, n))}
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
    </Scroll>
  );
}

const STEPS = ['< 0.5 %', '< 1 %', '< 2 %', '≥ 2 % slower than own best'];

/** What the styles mean, so colour is never the only cue (A§13). */
export function Legend({ show, periods }: { show: Show; periods: readonly Period[] }) {
  const has = (...kinds: Kind[]) => periods.some((p) => kinds.includes(p.kind));
  return (
    <ul className="legend" aria-label="Legend">
      {show === 'times' ? (
        <>
          <li>
            <span className="t-purple">overall best</span>
          </li>
          <li>
            <span className="t-green">personal best</span>
          </li>
          <li>other</li>
          <li>
            <span className="io">in-lap</span>
            <span className="badge">IN</span>
          </li>
          <li>
            <span className="cmp cmp-hard" aria-hidden="true">
              H
            </span>
            new stint
          </li>
          <li>
            <s>deleted</s>
          </li>
          {has('sc', 'vsc') && (
            <li>
              <span className="band band-sc">SC / VSC lap</span>
            </li>
          )}
          {has('red') && (
            <li>
              <span className="band band-red">red-flag lap</span>
            </li>
          )}
        </>
      ) : (
        STEPS.map((step, i) => (
          <li key={step}>
            <span className={classes('sw', i > 0 && `heat-${i}`)} aria-hidden="true" />
            {step}
          </li>
        ))
      )}
    </ul>
  );
}

/** The metric switch, Times | Δ and the orientation toggle are component state, not URL state (D1). */
export function LapTable({ detail, laps, track }: { detail: SessionDetail; laps: Laps; track?: Track | null }) {
  const [metric, setMetric] = useState<Metric>('lap');
  const [show, setShow] = useState<Show>('times');
  const [columns, setColumns] = useState(false);
  if (laps.length === 0) return <p>No laps yet.</p>;
  const periods = track?.periods ?? [];
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
        <fieldset className="segmented" aria-label="Values">
          <button type="button" aria-pressed={show === 'times'} onClick={() => setShow('times')}>
            Times
          </button>
          <button type="button" aria-pressed={show === 'delta'} onClick={() => setShow('delta')}>
            Δ to own best
          </button>
        </fieldset>
        <button type="button" aria-pressed={columns} onClick={() => setColumns(!columns)}>
          Drivers as columns
        </button>
      </div>
      <Legend show={show} periods={periods} />
      <LapGrid detail={detail} laps={laps} metric={metric} columns={columns} show={show} periods={periods} />
      {track && track.unplaced.length > 0 && (
        <div className="muted">
          <p>No lap number in the data, not banded:</p>
          <ul>
            {track.unplaced.map((r, i) => (
              // Race-control text is rendered as text only.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id, and the list never reorders.
              <li key={i}>
                {r.date ? fmtClock(Date.parse(r.date)) : '—'} {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
