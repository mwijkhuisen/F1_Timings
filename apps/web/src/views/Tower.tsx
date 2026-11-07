import { type Obj, type Views, view } from '@f1/contracts';
import { compoundOf, type Driver, teamColour, teamStyle } from '../lib/session.ts';
import { Note } from '../ui/Note.tsx';
import { MsLegend, segClass } from './MiniSectors.tsx';

// The timing tower (A§13): one row per TimingData line, from the stream's state. Feed text is rendered as text only.

type Line = NonNullable<NonNullable<Views['TimingData']['Lines']>[string]>;
type Stint = NonNullable<
  NonNullable<NonNullable<NonNullable<Views['TimingAppData']['Lines']>[string]>['Stints']>[string]
>;

/** A gap or interval: the feed's text, or why there is none (shown as — with the reason, A§2). */
export type Gap = { value: string } | { reason: string };

export type TowerRow = {
  driver: Driver;
  position: string | undefined;
  gap: Gap;
  interval: Gap;
  last: string | undefined;
  best: string | undefined;
  /** The driver's latest stint. */
  tyre: Stint | undefined;
  /** The whole typed line, for the columns built on it. */
  line: Line;
};

/** What the gaps depend on: SessionInfo's Type, and in qualifying TimingData's SessionPart and the part's prefix. */
type Session = { type: string | undefined; part: number | undefined; prefix: 'Q' | 'SQ' };
type Kind = 'gap' | 'interval';
/** A line's two values, and the time they are measured on (none in a race). */
type Feed = { gap: string | undefined; interval: string | undefined; best: string | undefined };

/**
 * Gap and Int by session type (A§11.3, A§13): a race's GapToLeader and IntervalToPositionAhead, practice's
 * TimeDiffToFastest and TimeDiffToPositionAhead, and in qualifying the current part's Stats (index SessionPart − 1,
 * the interval spelt TimeDifftoPositionAhead). `best` is the best lap, in qualifying the part's (BestLapTimes, same
 * index). Undefined for any other type, or in qualifying before the first part.
 */
function feedGaps(line: Line, s: Session): Feed | undefined {
  if (s.type === 'Race')
    return { gap: line.GapToLeader, interval: line.IntervalToPositionAhead?.Value, best: undefined };
  if (s.type === 'Practice')
    return { gap: line.TimeDiffToFastest, interval: line.TimeDiffToPositionAhead, best: line.BestLapTime?.Value };
  if (s.type !== 'Qualifying' || s.part === undefined || s.part < 1) return undefined;
  const at = String(s.part - 1);
  const stats = line.Stats?.[at];
  return {
    gap: stats?.TimeDiffToFastest,
    interval: stats?.TimeDifftoPositionAhead,
    best: line.BestLapTimes?.[at]?.Value,
  };
}

/**
 * Why a line has no gap or interval, from the cases the F1 archive check showed (A§11.3): outside races the fastest
 * driver and a driver without a time have an empty value, in qualifying a knocked-out driver in the later parts too.
 */
function reason(what: Kind, line: Line, s: Session, best: string | undefined): string {
  if (line.Retired) return 'Retired';
  if (s.type === 'Race') return `No ${what} in the feed`;
  const part = `${s.prefix}${s.part}`;
  if (s.type === 'Qualifying' && line.KnockedOut) return `Knocked out: no time in ${part}`;
  if (!best) return s.type === 'Practice' ? 'No lap time yet' : `No time in ${part} yet`;
  if (line.Position === '1')
    return `Fastest${s.type === 'Practice' ? ' lap' : ` in ${part}`}: ${what === 'gap' ? 'no gap' : 'no car ahead'}`;
  return `No ${what} in the feed`;
}

/** Why no line has a gap: an unknown session type, or qualifying before its first part (SessionPart 0). */
function noGaps(s: Session): string {
  if (s.type !== 'Qualifying') return s.type === undefined ? 'No session type in the feed' : 'Unknown session type';
  return s.part === undefined ? 'No qualifying part in the feed' : `${s.prefix}1 has not started`;
}

function gaps(line: Line, s: Session): [Gap, Gap] {
  const feed = feedGaps(line, s);
  const pick = (what: Kind): Gap => {
    if (feed === undefined) return { reason: noGaps(s) };
    const value = feed[what];
    return value ? { value } : { reason: reason(what, line, s, feed.best) };
  };
  return [pick('gap'), pick('interval')];
}

const NUMBER = /^\d{1,3}$/;

/** TimingData lines ordered by `Line` (then number), with the DriverList's Tla and team colour. */
export function towerRows(state: Obj): TowerRow[] {
  const list = view(state, 'DriverList') ?? {};
  const timing = view(state, 'TimingData');
  const lines = timing?.Lines ?? {};
  const apps = view(state, 'TimingAppData')?.Lines ?? {};
  const info = view(state, 'SessionInfo');
  // Sprint Qualifying (Sprint Shootout in 2023) is of type Qualifying too; its parts are SQ1–SQ3.
  const session: Session = {
    type: info?.Type,
    part: timing?.SessionPart,
    prefix: info?.Name?.startsWith('Sprint') ? 'SQ' : 'Q',
  };
  return Object.entries(lines)
    .flatMap(([n, line]) => (line && NUMBER.test(n) ? [{ n: Number(n), line }] : []))
    .sort((a, b) => (a.line.Line ?? 999) - (b.line.Line ?? 999) || a.n - b.n)
    .map(({ n, line }) => {
      const d = list[n];
      const [gap, interval] = gaps(line, session);
      return {
        driver: {
          number: n,
          acronym: d?.Tla ?? String(n),
          name: d?.FullName ?? null,
          team: teamColour(d?.TeamColour ?? null),
        },
        position: line.Position,
        gap,
        interval,
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

/** The feed's gap text, or — with the reason behind a tap (ui/Note.tsx); `id` is unique on the page. */
const GapCell = ({ gap, id }: { gap: Gap; id: string }) => (
  <td>
    {'value' in gap ? (
      gap.value
    ) : (
      <Note id={id} text={gap.reason}>
        —
      </Note>
    )}
  </td>
);

export function Tower({ state, sessionKey }: { state: Obj; sessionKey?: number | undefined }) {
  // After a session switch the feed shows the previous session until the new one's SessionInfo arrives.
  if (sessionKey !== undefined && view(state, 'SessionInfo')?.Key !== sessionKey)
    return <p className="muted">Waiting for the session: the feed still shows the previous one.</p>;
  const rows = towerRows(state);
  if (rows.length === 0) return <p className="muted">No timing yet.</p>;
  return (
    <>
      <MsLegend />
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
                  <GapCell gap={r.gap} id={`tower-gap-${r.driver.number}`} />
                  <GapCell gap={r.interval} id={`tower-int-${r.driver.number}`} />
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
    </>
  );
}
