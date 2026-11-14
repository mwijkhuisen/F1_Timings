import { type Obj, type Views, view } from '@f1/contracts';
import type { ReactNode } from 'react';
import type { Trend } from '../lib/crossings.ts';
import { compoundOf, type Driver, teamColour, teamStyle } from '../lib/session.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';
import { MsLegend, segClass } from './MiniSectors.tsx';

// The timing tower (A§13): one row per TimingData line, from the stream's state. Feed text is rendered as text only.

type Line = NonNullable<NonNullable<Views['TimingData']['Lines']>[string]>;
type Stint = NonNullable<
  NonNullable<NonNullable<NonNullable<Views['TimingAppData']['Lines']>[string]>['Stints']>[string]
>;

/** A gap or interval: the feed's text, the race leader's "Leader", or why there is none (— with the reason, A§2). */
export type Gap = { value: string } | { leader: true } | { reason: string };

export type TowerRow = {
  driver: Driver;
  position: string | undefined;
  gap: Gap;
  interval: Gap;
  last: string | undefined;
  best: string | undefined;
  /** The driver's latest stint. */
  tyre: Stint | undefined;
  /** In a race, grid position minus position; 'none' without a usable grid position; undefined outside races. */
  places: number | 'none' | undefined;
  /** In a race, the interval to the car ahead is under a second (not the first row, not retired or stopped). */
  close: boolean;
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
  // The race leader has no gap and no car ahead (its feed values are its lap count, "LAP 12").
  if (s.type === 'Race' && line.Position === '1') return [{ leader: true }, { reason: 'Leader: no car ahead' }];
  const feed = feedGaps(line, s);
  const pick = (what: Kind): Gap => {
    if (feed === undefined) return { reason: noGaps(s) };
    const value = feed[what];
    return value ? { value } : { reason: reason(what, line, s, feed.best) };
  };
  return [pick('gap'), pick('interval')];
}

const NUMBER = /^\d{1,3}$/;
const CLOSE = /^\+0\.\d+$/;
const PLACE = /^\d{1,2}$/;

/** Places gained since the start (GridPos − Position), 'none' when the grid position is no number from 1 to 99. */
function placesOf(grid: string | undefined, position: string | undefined): number | 'none' | undefined {
  if (grid === undefined || !PLACE.test(grid) || Number(grid) < 1) return 'none';
  return position !== undefined && PLACE.test(position) ? Number(grid) - Number(position) : undefined;
}

/** The grid positions the feed gives (TimingAppData's GridPos, a number from 1 to 99), by driver number. */
export function gridOf(state: Obj): Map<number, number> {
  const out = new Map<number, number>();
  for (const [n, l] of Object.entries(view(state, 'TimingAppData')?.Lines ?? {})) {
    const g = l?.GridPos;
    if (NUMBER.test(n) && g !== undefined && PLACE.test(g) && Number(g) >= 1) out.set(Number(n), Number(g));
  }
  return out;
}

/** A driver from the DriverList entry of number `n`: Tla, full name and team colour, the number when unknown. */
export function driverOf(list: Views['DriverList'], n: string): Driver {
  const d = list[n];
  return {
    number: Number(n),
    acronym: d?.Tla ?? n,
    name: d?.FullName ?? null,
    team: teamColour(d?.TeamColour ?? null),
  };
}

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
    .map(({ n, line }, i) => {
      const [gap, interval] = gaps(line, session);
      return {
        driver: driverOf(list, String(n)),
        places: session.type === 'Race' ? placesOf(apps[n]?.GridPos, line.Position) : undefined,
        position: line.Position,
        gap,
        interval,
        last: line.LastLapTime?.Value,
        best: line.BestLapTime?.Value,
        tyre: Object.entries(apps[n]?.Stints ?? {})
          .filter(([i]) => NUMBER.test(i))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .at(-1)?.[1],
        close:
          session.type === 'Race' &&
          i > 0 &&
          !line.Retired &&
          !line.Stopped &&
          'value' in interval &&
          CLOSE.test(interval.value),
        line,
      };
    });
}

type Flag = { className: string; words: string };

/** A flagged value's class and its words for a screen reader: purple for the overall best, green for a personal best (as in the lap table). */
const flag = (
  v: { OverallFastest?: boolean | undefined; PersonalFastest?: boolean | undefined } | undefined,
): Flag | undefined =>
  v?.OverallFastest
    ? { className: 't-purple', words: ', overall best' }
    : v?.PersonalFastest
      ? { className: 't-green', words: ', personal best' }
      : undefined;

const Words = ({ f }: { f: Flag | undefined }) => f && <span className="vh">{f.words}</span>;

const SECTORS = ['0', '1', '2'];

function Sector({ s }: { s: NonNullable<Line['Sectors']>[string] }) {
  const segs = Object.entries(s?.Segments ?? {})
    .filter(([i]) => NUMBER.test(i))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const f = flag(s);
  return (
    <td className="sector">
      <span className={f?.className}>
        {s?.Value}
        <Words f={f} />
      </span>
      {segs.map(([i, seg]) => (
        <span key={i} className={`ms ${segClass(seg?.Status ?? null)}`} aria-hidden="true" />
      ))}
    </td>
  );
}

/** The feed's gap text, the leader's muted "Leader", or — with the reason behind a tap (ui/Note.tsx); `id` is unique on the page. */
const GapCell = ({
  gap,
  id,
  className,
  children,
}: {
  gap: Gap;
  id: string;
  className?: string | undefined;
  children?: ReactNode;
}) => (
  <td className={className}>
    {'value' in gap ? (
      gap.value
    ) : 'leader' in gap ? (
      <span className="muted">Leader</span>
    ) : (
      <Note id={id} text={gap.reason}>
        —
      </Note>
    )}
    {children}
  </td>
);

/** A retired or stopped car's word (#102): the row's --muted is lost under forced colours, the word is not. */
function OutBadge({ line }: { line: Line }) {
  const out = line.Retired ? ['RET', 'retired'] : line.Stopped ? ['STOP', 'stopped'] : null;
  return (
    out && (
      <>
        <span className="badge" aria-hidden="true">
          {out[0]}
        </span>
        <span className="vh">{`, ${out[1]}`}</span>
      </>
    )
  );
}

const plural = (n: number) => `${n} place${n === 1 ? '' : 's'}`;

/** A number of places: ▲ gained in --fg, ▼ lost and – no change muted; the glyphs are hidden, the words say it. */
export function Places({ places }: { places: number }) {
  const [glyph, words] =
    places > 0
      ? [`▲${places}`, `gained ${plural(places)}`]
      : places < 0
        ? [`▼${-places}`, `lost ${plural(-places)}`]
        : ['–', 'no change'];
  return (
    <span className={places > 0 ? undefined : 'muted'}>
      <span aria-hidden="true">{glyph}</span>
      <span className="vh">{words}</span>
    </span>
  );
}

/** Places since the start, in its own cell. */
function PlacesCell({ places, number }: { places: TowerRow['places']; number: number }) {
  if (places === 'none')
    return (
      <td className="pc">
        <Note id={`tower-pc-${number}`} text="No grid position in the feed">
          —
        </Note>
      </td>
    );
  return <td className="pc">{places !== undefined && <Places places={places} />}</td>;
}

/** The change of the interval to the car ahead at the line (A§13): ▼ closing, ▲ pulling away; — with the lap missing. */
function TrendCell({ trend, id }: { trend: Trend | undefined; id: string }) {
  if (!trend) return <td className="tr" />;
  if ('missing' in trend)
    return (
      <td className="tr">
        <Note id={id} text={`No crossing for both cars on lap ${trend.missing}`}>
          —
        </Note>
      </td>
    );
  const secs = (Math.abs(trend.delta) / 1000).toFixed(1);
  const [glyph, words] =
    secs === '0.0'
      ? ['0.0', 'no change']
      : trend.delta < 0
        ? [`▼${secs}`, `closing ${secs} s on the car ahead`]
        : [`▲${secs}`, `car ahead pulling away ${secs} s`];
  return (
    <td className="tr">
      <span className={trend.delta < 0 && secs !== '0.0' ? undefined : 'muted'}>
        <span aria-hidden="true">{glyph}</span>
        <span className="vh">{words}</span>
      </span>
    </td>
  );
}

const COMPOUND_NAME: Record<string, string> = {
  soft: 'Soft',
  medium: 'Medium',
  hard: 'Hard',
  intermediate: 'Intermediate',
  wet: 'Wet',
};

/** The latest stint: the compound dot (a dashed outline on a used set), its words, and its age in laps. */
function TyreCell({ tyre, number }: { tyre: Stint | undefined; number: string }) {
  if (!tyre)
    return (
      <td>
        <Note id={`tower-tyre-${number}`} text="No stint in the feed">
          —
        </Note>
      </td>
    );
  const compound = compoundOf(tyre.Compound ?? null) ?? 'unknown';
  // The feed sends New as a string: "true" a new set, "false" a used one; anything else says neither.
  const set = tyre.New === 'true' ? 'new set' : tyre.New === 'false' ? 'used set' : undefined;
  const name = COMPOUND_NAME[compound] ?? tyre.Compound;
  return (
    <td>
      <span
        className={`cmp cmp-${compound}${set === 'used set' ? ' used' : ''}`}
        title={[name, set].filter(Boolean).join(', ') || undefined}
        aria-hidden="true"
      >
        {compound[0]?.toUpperCase()}
      </span>
      <span className="vh">
        {compound} tyres, {set && `${set}, `}
      </span>
      {tyre.TotalLaps}
    </td>
  );
}

export function Tower({
  state,
  sessionKey,
  focus = null,
  onFocus,
  trend,
}: {
  state: Obj;
  sessionKey?: number | undefined;
  /** The focused driver's number: its row is raised and its button pressed. */
  focus?: string | null | undefined;
  /** Without it the driver cells are plain text. */
  onFocus?: ((n: string) => void) | undefined;
  /** The interval's change at the line over 1 and 3 laps per driver number (race only; the columns show with it). */
  trend?: ReadonlyMap<number, { one: Trend; three: Trend }> | undefined;
}) {
  // After a session switch the feed shows the previous session until the new one's SessionInfo arrives.
  if (sessionKey !== undefined && view(state, 'SessionInfo')?.Key !== sessionKey)
    return <p className="muted">Waiting for the session: the feed still shows the previous one.</p>;
  const rows = towerRows(state);
  if (rows.length === 0) return <p className="muted">No timing yet.</p>;
  // Places since the start: in races, once any line has a grid position.
  const places = rows.some((r) => typeof r.places === 'number');
  const trends = trend !== undefined && view(state, 'SessionInfo')?.Type === 'Race';
  const head = (h: string) => (
    <th key={h} scope="col">
      {h}
    </th>
  );
  return (
    <>
      <MsLegend>
        {places && (
          <span>
            <span aria-hidden="true">▲</span> places since the start
          </span>
        )}
        {trends && (
          <span>
            At the line: <span aria-hidden="true">▼</span> closing on the car ahead, <span aria-hidden="true">▲</span>{' '}
            car ahead pulling away, over 1 and 3 laps
          </span>
        )}
        <span>
          <span className="cmp used" aria-hidden="true" /> used set
        </span>
      </MsLegend>
      <Scroll label="Timing tower">
        <table className="list tower" aria-label="Timing tower">
          <thead>
            <tr>
              {['Pos', 'Driver'].map(head)}
              {places && (
                <th scope="col" title="Places since the start">
                  <span aria-hidden="true">±</span>
                  <span className="vh">Places since the start</span>
                </th>
              )}
              {['Gap', 'Int'].map(head)}
              {trends &&
                ['1 lap', '3 laps'].map((h) => (
                  <th key={h} scope="col">
                    <span className="vh">Interval change at the line over </span>
                    {h}
                  </th>
                ))}
              {['Last', 'Best', 'S1', 'S2', 'S3', 'Tyre', 'Pits'].map(head)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const { line } = r;
              const n = String(r.driver.number);
              const last = flag(line.LastLapTime);
              const focused = focus === n;
              const out = line.Retired || line.Stopped;
              // A retired or stopped car has no trend: its cells stay blank.
              const own = out ? undefined : trend?.get(r.driver.number);
              const cls = [out ? 'out' : '', focused ? 'focus' : ''].filter(Boolean).join(' ');
              return (
                <tr key={n} className={cls || undefined}>
                  <td>{r.position}</td>
                  <th scope="row" className="drv" style={teamStyle(r.driver)} title={r.driver.name ?? undefined}>
                    {onFocus ? (
                      <button type="button" aria-pressed={focused} onClick={() => onFocus(n)}>
                        {r.driver.acronym}
                      </button>
                    ) : (
                      r.driver.acronym
                    )}
                  </th>
                  {places && <PlacesCell places={r.places} number={r.driver.number} />}
                  <GapCell gap={r.gap} id={`tower-gap-${n}`}>
                    <OutBadge line={line} />
                  </GapCell>
                  {r.close && 'value' in r.interval ? (
                    <td className="int close">
                      {r.interval.value}
                      <span className="vh">, within a second</span>
                    </td>
                  ) : (
                    <GapCell gap={r.interval} id={`tower-int-${n}`} />
                  )}
                  {trends && (
                    <>
                      <TrendCell trend={own?.one} id={`tower-t1-${n}`} />
                      <TrendCell trend={own?.three} id={`tower-t3-${n}`} />
                    </>
                  )}
                  <td className={last?.className}>
                    {r.last}
                    <Words f={last} />
                  </td>
                  <td>{r.best}</td>
                  {SECTORS.map((i) => (
                    <Sector key={i} s={line.Sectors?.[i]} />
                  ))}
                  <TyreCell tyre={r.tyre} number={n} />
                  <td>
                    {line.NumberOfPitStops}
                    {line.InPit ? (
                      <span className="badge">IN PIT</span>
                    ) : (
                      line.PitOut && <span className="badge">OUT</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}
