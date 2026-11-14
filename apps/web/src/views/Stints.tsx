import type { Laps, Live, SessionDetail, Stints } from '@f1/contracts';
import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import { useRaceControl, useStints } from '../lib/api.ts';
import { type Compound, compoundOf, compoundsOf, UNKNOWN_COMPOUND } from '../lib/compound.ts';
import { type Driver, orderDrivers, teamStyle } from '../lib/session.ts';
import { KIND_LABEL, type Period, trackPeriods } from '../lib/track.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { NoData } from '../ui/NoData.tsx';

// Stints on a real lap scale (P4f, A§13): a lane per driver, a stint at (lap_start − 1) / total and
// (laps) / total wide, so a hole in the data shows as a gap and no row is stretched to fit. Each row is a
// button that opens a popover with the stints in words (a tap works on a phone, D10).

/** A stint that has both lap bounds, as a position on the scale (fractions of the total). */
export type Seg = {
  stint: number;
  x: number;
  w: number;
  from: number;
  to: number;
  laps: number;
  /** The compound's key (`cmp-<key>`, lib/compound.ts), or null for a compound the season does not know. */
  compound: string | null;
  /** Its letters: S, M, H, I, W or T, in 2018 also HS, US, SS or SH; ? when unknown. */
  letter: string;
  /** "Ultrasoft", or "Unknown compound". */
  name: string;
  /** `tyre_age_at_start > 0`; an unknown age is not used. */
  used: boolean;
  age: number | null;
};
/** A stint without a lap bound: listed, not drawn. */
export type Unplaced = { stint: number; compound: string | null; letter: string; name: string; age: number | null };
export type StintRow = { driver: Driver; track: number; segs: Seg[]; unplaced: Unplaced[]; stops: number };
export type StintLayout = { total: number; ticks: number[]; rows: StintRow[] };

const fields = (c: Compound | null) => {
  const { key, letter, name } = c ?? UNKNOWN_COMPOUND;
  return { compound: c && key, letter, name };
};

/** `year` is the session's `meeting.year`, which picks the season's compounds (lib/compound.ts). */
export function stintLayout(drivers: readonly Driver[], laps: Laps, stints: Stints, year: number | null): StintLayout {
  // The session's highest lap number; a stint that runs past it still fits.
  const total = Math.max(...laps.map((l) => l.lap_number), ...stints.map((s) => s.lap_end ?? 0));
  // Every 10 laps, but none within 3 laps of the total, whose label would crowd it (51: …, 40, 51).
  const ticks = [];
  for (let k = 10; k < total - 3; k += 10) ticks.push(k);
  ticks.push(total);
  const last = new Map<number, number>();
  for (const l of laps) last.set(l.driver_number, Math.max(last.get(l.driver_number) ?? 0, l.lap_number));
  const rows = drivers.map((driver): StintRow => {
    const own = stints.filter((s) => s.driver_number === driver.number);
    const segs: Seg[] = [];
    const unplaced: Unplaced[] = [];
    for (const s of own) {
      const base = { stint: s.stint_number, ...fields(compoundOf(s.compound, year)), age: s.tyre_age_at_start };
      if (s.lap_start === null || s.lap_end === null) unplaced.push(base);
      else {
        const laps = s.lap_end - s.lap_start + 1;
        segs.push({
          ...base,
          x: (s.lap_start - 1) / total,
          w: laps / total,
          from: s.lap_start,
          to: s.lap_end,
          laps,
          used: (s.tyre_age_at_start ?? 0) > 0,
        });
      }
    }
    return {
      driver,
      track: (last.get(driver.number) ?? 0) / total,
      segs,
      unplaced,
      stops: Math.max(0, own.length - 1),
    };
  });
  return { total, ticks, rows };
}

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const vars = (o: Record<string, string>) => o as CSSProperties;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const range = (s: Seg) => `${s.from}–${s.to}`;

const inOrder = (row: StintRow) => [...row.segs, ...row.unplaced].sort((a, b) => a.stint - b.stint);

/** "Medium, laps 1–24 (24 laps), new set", or "Hard, laps unknown". */
function describe(s: Seg | Unplaced): string {
  if (!('from' in s)) return `${s.name}, laps unknown`;
  const set =
    s.age === null
      ? ''
      : s.used
        ? `, used set, ${plural(s.age, 'lap')} old at the start (may be wrong for a used set)`
        : ', new set';
  return `${s.name}, laps ${range(s)} (${plural(s.laps, 'lap')})${set}`;
}

const spoken = (s: Seg | Unplaced) =>
  `${s.name.toLowerCase()} ${'from' in s ? `laps ${s.from} to ${s.to}` : 'laps unknown'}`;

/** Two letters need a wider bar before they show (styles.css). */
const letterClass = (letter: string) => (letter.length > 1 ? 'two' : undefined);

const lapsText = (p: Period) => (p.from === p.to ? `lap ${p.from}` : `laps ${p.from}–${p.to}`);

export function StintBars({
  detail,
  laps,
  stints,
  periods = [],
}: {
  detail: SessionDetail;
  laps: Laps;
  stints: Stints;
  /** SC and VSC periods (C6); red flags are not drawn here. */
  periods?: readonly Period[];
}) {
  const year = detail.meeting.year;
  const drivers = orderDrivers(detail, laps);
  const { total, ticks, rows } = stintLayout(drivers, laps, stints, year);
  const used = new Set(rows.flatMap((r) => inOrder(r).map((s) => s.compound)));
  // The season's compounds in use, softest first, then an unknown one.
  const compounds = [...compoundsOf(year).filter((c) => used.has(c.key)), ...(used.has(null) ? [null] : [])];
  return (
    <>
      <ul className="legend" aria-label="Legend">
        {compounds.map((c) => (
          <li key={c?.key ?? 'unknown'}>
            <span className={`cmp cmp-${c?.key ?? 'unknown'}`} aria-hidden="true">
              {(c ?? UNKNOWN_COMPOUND).letter}
            </span>
            {c?.name.toLowerCase() ?? 'unknown'}
          </li>
        ))}
        {periods.map((p) => (
          <li key={`${p.kind}-${p.from}`}>
            <span className="dash" aria-hidden="true" />
            {KIND_LABEL[p.kind]}, {lapsText(p)}
          </li>
        ))}
        <li>number: laps in the stint</li>
      </ul>
      <div className="stintbox">
        <div className="laxis" aria-hidden="true">
          <span />
          <div className="ticks">
            {ticks.map((k) => (
              <span key={k} className={k === total ? 'tick tick-end' : 'tick'} style={vars({ '--x': pct(k / total) })}>
                {k}
              </span>
            ))}
          </div>
          <span />
        </div>
        <div className="lanes">
          <div className="rules" aria-hidden="true">
            {ticks.map((k) => (
              <i key={k} className="rule" style={vars({ '--x': pct(k / total) })} />
            ))}
            {periods.map((p) => (
              <i
                key={`${p.kind}-${p.from}`}
                className="vscline"
                style={vars({ '--x': pct((p.from - 1) / total), '--w': pct((p.to - p.from + 1) / total) })}
              />
            ))}
          </div>
          <ol className="stints">
            {rows.map(({ driver: d, track, segs, unplaced, stops }) => {
              const own = inOrder({ driver: d, track, segs, unplaced, stops });
              const id = `stints-${d.number}`;
              return (
                <li key={d.number}>
                  <button
                    type="button"
                    className="row"
                    popoverTarget={id}
                    aria-label={`${d.acronym}, ${plural(stops, 'stop')}: ${own.map(spoken).join(', ') || 'no stints'}`}
                  >
                    <span className="drv" style={teamStyle(d)}>
                      {d.acronym}
                    </span>
                    <span className="lane">
                      <span className="trackline" style={vars({ '--w': pct(track) })} />
                      {segs.map((s) => (
                        <span
                          key={s.stint}
                          className={`seg cmp-${s.compound ?? 'unknown'}`}
                          style={vars({ '--x': pct(s.x), '--w': pct(s.w) })}
                        >
                          <b className={letterClass(s.letter)}>{s.letter}</b>
                          <small>
                            {s.laps}
                            {s.used && <span className="used"> · used</span>}
                          </small>
                        </span>
                      ))}
                    </span>
                    <span className="stop">{plural(stops, 'stop')}</span>
                  </button>
                  <div popover="auto" id={id} className="pop">
                    {own.length === 0 ? (
                      <p>No stints.</p>
                    ) : (
                      <ul>
                        {own.map((s) => (
                          <li key={s.stint}>{describe(s)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </>
  );
}

export function StintsTab({
  session,
  detail,
  laps,
  live,
  now,
}: {
  session: number;
  detail: SessionDetail;
  laps: Laps;
  live: Live | null;
  /** The clock of the reason, epoch ms. */
  now: number;
}) {
  const stints = useStints(session);
  const rc = useRaceControl(session, detail.session.type === 'Race' && laps.length > 0);
  const periods = useMemo(
    () => (rc.data ? trackPeriods(rc.data).periods.filter((p) => p.kind !== 'red') : []),
    [rc.data],
  );
  if (!stints.data) return <Pending error={stints.error} />;
  if (stints.data.length === 0) return <NoData session={detail.session} live={live} what="stints" now={now} />;
  return (
    <>
      {rc.error && <p className="muted">Race control did not load: no SC or VSC lines.</p>}
      <StintBars detail={detail} laps={laps} stints={stints.data} periods={periods} />
    </>
  );
}
