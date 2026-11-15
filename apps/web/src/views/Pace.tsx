import type { Laps, SessionDetail, Weather } from '@f1/contracts';
import type { CSSProperties } from 'react';
import { type Compound, compoundOf, compoundsOf, tyresWords, UNKNOWN_COMPOUND } from '../lib/compound.ts';
import { REASON_WORDS, REASONS, type Run, runPlan } from '../lib/runs.ts';
import { orderDrivers, plural, teamStyle } from '../lib/session.ts';
import { fmtHm, fmtLap } from '../lib/time.ts';
import type { ClockPeriod } from '../lib/track.ts';
import { trackAt } from '../lib/weather.ts';
import { Note } from '../ui/Note.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// Pace per run and the practice run plan (#114, A§13). The run plan reuses the stints' lanes: a run at its time of day
// (`--x`, `--w` of the plan), a red-flag band behind it. The pace table lists each run's counted laps and what was
// left out; every `—` says why. React sets only custom properties.

export const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
export const vars = (o: Record<string, string>) => o as CSSProperties;

const compoundName = (c: Compound | null) => (c ?? UNKNOWN_COMPOUND).name;
const when = (r: Run) => (r.start === null || r.end === null ? 'time unknown' : `${fmtHm(r.start)}–${fmtHm(r.end)}`);
const degrees = (t: number | null) => (t === null ? '—' : `${t.toFixed(0)} °C`);

/** "14:05–14:17, Medium, 8 laps (5 counted), 3 laps old at the start (may be wrong for a used set), track 41 °C". */
function describeRun(r: Run, year: number | null, track: number | null, weatherFailed: boolean): string {
  const set =
    r.age === null
      ? ''
      : r.age > 0
        ? `, ${plural(r.age, 'lap')} old at the start (may be wrong for a used set)`
        : ', new set';
  return `${when(r)}, ${compoundName(compoundOf(r.compound, year))}, ${plural(r.laps.length, 'lap')} (${r.counted.length} counted)${set}, track ${degrees(track)}${track === null && weatherFailed ? ', weather did not load' : ''}`;
}

const spoken = (r: Run, year: number | null) =>
  `${compoundName(compoundOf(r.compound, year)).toLowerCase()} ${r.start === null || r.end === null ? 'time unknown' : `${fmtHm(r.start)} to ${fmtHm(r.end)}`}`;

/**
 * The practice run plan: a lane per driver over the session's clock, from the earlier of its start and the first run
 * to the later of its end (`end`) and the last run. A run without a start or an end is listed in the popover, not drawn.
 */
export function RunPlan({
  detail,
  laps,
  runs,
  clock,
  weather,
  weatherFailed = false,
  end,
}: {
  detail: SessionDetail;
  laps: Laps;
  runs: readonly Run[];
  clock: readonly ClockPeriod[];
  weather: Weather;
  /** The weather query failed: a missing temperature says so. */
  weatherFailed?: boolean;
  /** The axis' end in epoch ms where the session's `date_end` is only a schedule (the player: T); default `date_end`. */
  end?: number;
}) {
  const year = detail.meeting.year;
  const known = (t: number | null): t is number => t !== null;
  const from = Math.min(Date.parse(detail.session.date_start), ...runs.map((r) => r.start).filter(known));
  const to = Math.max(end ?? Date.parse(detail.session.date_end), ...runs.map((r) => r.end).filter(known));
  const plan = runPlan(orderDrivers(detail, laps), runs, from, to, clock, weather, year);
  const used = new Set(plan.lanes.flatMap((l) => l.segments.map((s) => s.compound?.key ?? null)));
  const compounds = [...compoundsOf(year).filter((c) => used.has(c.key)), ...(used.has(null) ? [null] : [])];
  return (
    <>
      <h2>Run plan</h2>
      <ul className="legend" aria-label="Run plan legend">
        {compounds.map((c) => (
          <li key={c?.key ?? 'unknown'}>
            <span className={`cmp cmp-${c?.key ?? 'unknown'}`} aria-hidden="true">
              {(c ?? UNKNOWN_COMPOUND).letter}
            </span>
            {c?.name.toLowerCase() ?? 'unknown'}
          </li>
        ))}
        {plan.red.map((b) => (
          <li key={`red-${b.from}`}>
            <span className="dash red" aria-hidden="true" />
            RED: red flag, {fmtHm(b.from)}–{fmtHm(b.to)}
          </li>
        ))}
        <li>number: laps in the run</li>
      </ul>
      <div className="stintbox">
        <div className="laxis" aria-hidden="true">
          <span />
          <div className="ticks">
            {plan.ticks.map((t) => (
              <span key={t.t} className={t.x > 0.97 ? 'tick tick-end' : 'tick'} style={vars({ '--x': pct(t.x) })}>
                {t.label}
              </span>
            ))}
          </div>
          <span />
        </div>
        <div className="lanes">
          <div className="rules" aria-hidden="true">
            {plan.ticks.map((t) => (
              <i key={`tick-${t.t}`} className="rule" style={vars({ '--x': pct(t.x) })} />
            ))}
            {plan.red.map((b) => (
              <i key={`red-${b.from}`} className="redband" style={vars({ '--x': pct(b.x), '--w': pct(b.w) })} />
            ))}
          </div>
          <ol className="stints">
            {plan.lanes.map(({ driver: d, segments, undrawn }) => {
              const id = `runs-${d.number}`;
              const own = [...segments.map((s) => s.run), ...undrawn].sort((a, b) => a.n - b.n);
              const trackOf = new Map(segments.map((s) => [s.run, s.track]));
              return (
                <li key={d.number}>
                  <button
                    type="button"
                    className="row"
                    popoverTarget={id}
                    aria-label={`${d.acronym}, ${plural(own.length, 'run')}: ${own.map((r) => spoken(r, year)).join(', ')}`}
                  >
                    <span className="drv" style={teamStyle(d)}>
                      {d.acronym}
                    </span>
                    <span className="lane">
                      {segments.map((s) => (
                        <span
                          key={s.run.n}
                          className={`seg cmp-${s.compound?.key ?? 'unknown'}`}
                          style={vars({ '--x': pct(s.x), '--w': pct(s.w) })}
                        >
                          <b className={(s.compound ?? UNKNOWN_COMPOUND).letter.length > 1 ? 'two' : undefined}>
                            {(s.compound ?? UNKNOWN_COMPOUND).letter}
                          </b>
                          <small>{s.laps}</small>
                        </span>
                      ))}
                    </span>
                    <span className="stop">{plural(own.length, 'run')}</span>
                  </button>
                  <div popover="auto" id={id} className="pop">
                    {undrawn.length > 0 && <p>{plural(undrawn.length, 'run')} without a time of day, not drawn.</p>}
                    <ul>
                      {own.map((r) => (
                        <li key={r.n}>{describeRun(r, year, trackOf.get(r) ?? null, weatherFailed)}</li>
                      ))}
                    </ul>
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

/**
 * "1 lap 1, 1 out-lap, 2 in-laps, 1 deleted": the left-out laps by reason (REASON_WORDS). Lap 1 takes no count; the
 * pit reason is split by the laps' own flags, a lap that is both counting as an out-lap.
 */
const leftOut = (r: Run) => {
  const out = r.left.pit.filter((l) => l.is_pit_out).length;
  const inn = r.left.pit.length - out;
  return REASONS.flatMap((k) =>
    r.left[k].length === 0
      ? []
      : k === 'lap1'
        ? [REASON_WORDS.lap1]
        : k === 'pit'
          ? [out > 0 ? plural(out, 'out-lap') : '', inn > 0 ? plural(inn, 'in-lap') : ''].filter(Boolean)
          : [`${r.left[k].length} ${REASON_WORDS[k]}`],
  ).join(', ');
};

/** A practice run of this many counted laps or more is a long run (listed first). */
const LONG_RUN = 5;

/**
 * Pace per run (#114): a race's stints, or a practice's runs, long ones first. Median and best need 3 counted laps.
 * `failed`: race control did not load, so no period was left out.
 */
export function PaceTable({
  detail,
  laps,
  runs,
  weather,
  failed,
  weatherFailed = false,
  unnumbered = 0,
}: {
  detail: SessionDetail;
  laps: Laps;
  runs: readonly Run[];
  weather: Weather;
  failed: boolean;
  /** The weather query failed: a missing track temperature says so. */
  weatherFailed?: boolean;
  /** The race stints without a lap bound, which have no run. */
  unnumbered?: number;
}) {
  const year = detail.meeting.year;
  const practice = detail.session.type === 'Practice';
  const drivers = orderDrivers(detail, laps);
  const rank = (n: number) => {
    const i = drivers.findIndex((d) => d.number === n);
    return i < 0 ? drivers.length : i;
  };
  const short = (r: Run) => (practice && r.counted.length < LONG_RUN ? 1 : 0);
  const rows = [...runs].sort((a, b) => short(a) - short(b) || rank(a.driver) - rank(b.driver) || a.n - b.n);
  return (
    <>
      <h2>Pace per run</h2>
      {rows.length === 0 ? (
        <p className="muted">No runs with lap numbers in the data.</p>
      ) : (
        <Scroll label="Pace per run">
          <table className="pace" aria-label="Pace per run">
            <thead>
              <tr>
                <th scope="col">Driver</th>
                <th scope="col">Run</th>
                <th scope="col">Tyre</th>
                <th scope="col">Laps</th>
                <th scope="col">Median</th>
                <th scope="col">Best</th>
                <th scope="col">Left out</th>
                {practice && <th scope="col">Track °C</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = `pace-${r.driver}-${r.n}`;
                const d = drivers.find((x) => x.number === r.driver);
                const c = compoundOf(r.compound, year);
                const out = r.laps.length - r.counted.length;
                const track = r.start === null ? null : trackAt(weather, r.start);
                const few = (what: string) => (
                  <Note id={`${id}-${what}`} text="Too few clean laps">
                    —
                  </Note>
                );
                return (
                  <tr key={id}>
                    <th scope="row" className="drv" style={d && teamStyle(d)}>
                      {d?.acronym ?? r.driver}
                    </th>
                    <td>{practice ? when(r) : r.n}</td>
                    <td>
                      <span className={`cmp cmp-${(c ?? UNKNOWN_COMPOUND).key}`} aria-hidden="true">
                        {(c ?? UNKNOWN_COMPOUND).letter}
                      </span>
                      <span className="vh">{tyresWords(c)}, </span>
                      {r.age !== null &&
                        (r.age > 0 ? (
                          <Note id={`${id}-age`} text="May be wrong for a used set (OpenF1 #473)">
                            {plural(r.age, 'lap')} old
                          </Note>
                        ) : (
                          'new'
                        ))}
                    </td>
                    <td>{r.counted.length}</td>
                    <td>{r.median === null ? few('median') : fmtLap(r.median)}</td>
                    <td>{r.best === null ? few('best') : fmtLap(r.best)}</td>
                    <td>
                      {out === 0 ? (
                        0
                      ) : (
                        <Note id={`${id}-left`} text={leftOut(r)}>
                          {out}
                        </Note>
                      )}
                    </td>
                    {practice && (
                      <td>
                        {track === null ? (
                          <Note
                            id={`${id}-track`}
                            text={
                              weatherFailed ? 'Weather did not load' : 'No track temperature at the start of the run'
                            }
                          >
                            —
                          </Note>
                        ) : (
                          track.toFixed(0)
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroll>
      )}
      {unnumbered > 0 && (
        <p className="muted">
          {unnumbered === 1 ? '1 stint without lap numbers is' : `${unnumbered} stints without lap numbers are`} not
          shown.
        </p>
      )}
      <p className="muted">
        Fuel loads and engine modes are unknown; yellow flags and traffic are not removed; bands mark the leader's lap.
      </p>
      {failed && <p className="muted">Race control did not load: periods are not left out.</p>}
    </>
  );
}
