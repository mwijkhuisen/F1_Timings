import type { Laps, RaceControl, SessionDetail, Stints } from '@f1/contracts';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { HttpError, useRaceControl, useStints, useTelemetry } from '../lib/api.ts';
import { colouredBests } from '../lib/bests.ts';
import { cycleText, PIT_WINDOW, pitCycles } from '../lib/crossings.ts';
import { evolution, evolutionSlots, SLOT_MS } from '../lib/evolution.ts';
import { phaseName } from '../lib/quali.ts';
import { type Driver, plural } from '../lib/session.ts';
import { useTable } from '../lib/tables.ts';
import { fmtHm, fmtLap } from '../lib/time.ts';
import { type ClockPeriod, clockPeriods, type Period, trackPeriods } from '../lib/track.ts';
import { errorText } from '../ui/ErrorView.tsx';
import { Scroll } from '../ui/Scroll.tsx';
import { Chart } from './Chart.tsx';
import { DeltaTable, Duel } from './DeltaTable.tsx';
import { evolutionChartOption, evolutionWindow } from './evolution-chart-option.ts';
import { gapChartLabel, gapChartOption } from './gap-chart-option.ts';
import { type ChartTokens, lapChartOption } from './lap-chart-option.ts';
import { lateStart, type TraceLap, traceChartOption, traceLabel, tracePoints } from './trace-chart-option.ts';

/**
 * The pit cycles of every pair of the picked drivers (A§13, #115): one sentence each, from the stints, the line
 * crossings and race control, undefined while they load. `settled` (the player, #112, D1) lists a cycle only once its
 * after line is crossed.
 */
export function PitCycles({
  drivers,
  laps,
  periods,
  stints,
  rc,
  failed,
  settled = false,
}: {
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  stints: Stints | undefined;
  rc: readonly Pick<RaceControl[number], 'date' | 'message'>[] | undefined;
  failed: boolean;
  settled?: boolean;
}) {
  const lines = useMemo(() => {
    if (!stints || !rc) return null;
    const name = (n: number) => drivers.find((d) => d.number === n)?.acronym ?? String(n);
    return drivers.flatMap((a, i) =>
      drivers.slice(i + 1).flatMap((b) =>
        pitCycles(a.number, b.number, laps, stints, periods, rc)
          .filter((c) => !settled || c.after !== null)
          .map((c) => cycleText(c, name)),
      ),
    );
  }, [stints, rc, drivers, laps, periods, settled]);
  return (
    <section className="card">
      <h2>Pit cycles</h2>
      {failed ? (
        <p className="muted">Pit cycles need the stints and race control, which did not load.</p>
      ) : lines === null ? (
        <p className="muted">Loading pit cycles…</p>
      ) : lines.length === 0 ? (
        <p className="muted">No pit cycles within {PIT_WINDOW} laps for the picked drivers.</p>
      ) : (
        <ul className="cycles">
          {lines.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The session page's pit cycles: the stints from `/stints` (races only, so only they fetch it), race control as Compare's. */
function StoredPitCycles({
  session,
  rc,
  ...rest
}: {
  session: number;
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  rc: ReturnType<typeof useRaceControl>;
}) {
  const stints = useStints(session);
  return <PitCycles {...rest} stints={stints.data} rc={rc.data} failed={!!(stints.error || rc.error)} />;
}

/**
 * The comparison (A§13), of the selected drivers in pick order, the first the reference: the lap-time chart beside
 * the gap chart and the duel, then the reference choice and the sector deltas. `periods` band both charts; `children`
 * is the side column's last card; `traces` (the session page's telemetry card, P7c) follows the grid. The session
 * page's `Compare` and the player (#112) feed it.
 */
export function Comparison({
  detail,
  drivers,
  laps,
  periods,
  rcFailed = false,
  onReference,
  children,
  traces,
}: {
  detail: SessionDetail;
  drivers: readonly Driver[];
  laps: Laps;
  periods: readonly Period[];
  rcFailed?: boolean;
  onReference: (driver: number) => void;
  children?: ReactNode;
  traces?: ReactNode;
}) {
  const [yWindow = 'fit', setWindow] = useTable('window');
  // What the charts draw, by content: the player's lap rows are a new array on each `laps` event (about one a second
  // in a race, mostly for other cars), and a redraw resets the tooltip (#112).
  const picked = new Set(drivers.map((d) => d.number));
  const drawn = JSON.stringify([drivers, laps.filter((l) => picked.has(l.driver_number)), periods]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` stands for the drivers, their laps and the periods.
  const lapOption = useCallback(
    (t: ChartTokens) => lapChartOption(drivers, laps, t, { window: yWindow, periods, year: detail.meeting.year }),
    [drawn, yWindow, detail.meeting.year],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above.
  const gapOption = useCallback((t: ChartTokens) => gapChartOption(drivers, laps, t, periods), [drawn]);

  const [ref, ...others] = drivers;
  if (!ref || others.length === 0) return <p>Pick at least 2 drivers.</p>;
  const names = (ds: readonly Driver[]) => ds.map((d) => d.acronym).join(', ');
  return (
    <>
      {rcFailed && <p className="muted">Race control did not load: no SC, VSC or red-flag bands.</p>}
      <div className="cgrid">
        <section className="card">
          <div className="panel-title">
            <h2>Lap times</h2>
            <fieldset className="segmented" aria-label="Window">
              <button type="button" aria-pressed={yWindow === 'fit'} onClick={() => setWindow('fit')}>
                Fit
              </button>
              <button type="button" aria-pressed={yWindow === '107'} onClick={() => setWindow('107')}>
                107 %
              </button>
            </fieldset>
          </div>
          <p className="keys">
            <span aria-hidden="true">●</span> own best · <span aria-hidden="true">○</span> deleted ·{' '}
            <span aria-hidden="true">▲</span> above the window
          </p>
          <Chart label={`Lap times: ${names(drivers)}`} option={lapOption} />
        </section>
        <div className="side">
          <section className="card">
            <div className="panel-title">
              <h2>Gap to {ref.acronym}</h2>
              <p>seconds at each line crossing</p>
            </div>
            <Chart label={gapChartLabel(drivers, laps)} option={gapOption} />
          </section>
          <section className="card">
            <h2>Best laps, sector by sector</h2>
            <Duel drivers={drivers} laps={laps} />
          </section>
          {children}
        </div>
      </div>
      {traces}
      <div className="controls">
        <span className="label" aria-hidden="true">
          Reference
        </span>
        <fieldset className="segmented" aria-label="Reference">
          {drivers.map((d) => (
            <button key={d.number} type="button" aria-pressed={d === ref} onClick={() => onReference(d.number)}>
              {d.acronym}
            </button>
          ))}
        </fieldset>
      </div>
      <h2>Sector deltas</h2>
      <DeltaTable drivers={drivers} laps={laps} />
    </>
  );
}

/**
 * Track evolution (#114, A§13), for qualifying and practice, without picks: every timed lap at its start, the running
 * best as a step line and the phases or red flags as bands. Under 640 px the chart gives way to the fastest lap per
 * 5 minutes (CSS shows one of `.evo-wide` and `.evo-narrow`). `clock`: the practice's red-flag periods.
 */
export function TrackEvolution({
  detail,
  laps,
  clock,
  rcFailed = false,
}: {
  detail: SessionDetail;
  laps: Laps;
  clock: readonly ClockPeriod[];
  rcFailed?: boolean;
}) {
  const { type, name } = detail.session;
  const evo = useMemo(() => evolution(laps, type, name, clock), [laps, type, name, clock]);
  const slots = useMemo(() => evolutionSlots(evo.points), [evo]);
  const win = evolutionWindow(evo);
  const caption = [
    evo.noStart > 0 && `${plural(evo.noStart, 'lap')} without a start time left out`,
    win && win.above > 0 && `${win.above} above 107 % not drawn`,
    win && win.below > 0 && `${win.below} below the window not drawn`,
  ].filter(Boolean);
  const acronym = useCallback(
    (n: number) => detail.drivers.find((d) => d.driver_number === n)?.acronym ?? String(n),
    [detail.drivers],
  );
  // What the chart draws, by content: the player's lap rows are a new array on each `laps` event (#112).
  const drawn = JSON.stringify([evo, detail.drivers.map((d) => [d.driver_number, d.acronym])]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` stands for the evolution and the acronyms.
  const option = useCallback((t: ChartTokens) => evolutionChartOption(evo, t, acronym), [drawn]);
  const phased = slots.some((s) => s.phase !== null);
  return (
    <section className="card evo">
      <h2>Track evolution</h2>
      {evo.points.length === 0 ? (
        <p className="muted">No timed lap with a start time.</p>
      ) : (
        <>
          <p className="keys">
            <span aria-hidden="true">●</span> lap · <span aria-hidden="true">○</span> deleted · line: best so far
          </p>
          <div className="evo-wide">
            <Chart label="Track evolution: lap times over the session" option={option} />
          </div>
          <div className="evo-narrow">
            <Scroll label="Fastest lap per 5 minutes">
              <table className="evo-slots" aria-label="Fastest lap per 5 minutes">
                <thead>
                  <tr>
                    {phased && <th scope="col">Phase</th>}
                    <th scope="col">Slot</th>
                    <th scope="col">Lap</th>
                    <th scope="col">Driver</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => (
                    <tr key={`${s.phase}-${s.slot}`}>
                      {phased && <td>{s.phase === null ? '' : phaseName(name, s.phase)}</td>}
                      <td>
                        {fmtHm(s.slot)}–{fmtHm(s.slot + SLOT_MS)}
                      </td>
                      <td>
                        {fmtLap(s.point.ms)}
                        {s.best && ', new best'}
                      </td>
                      <td>
                        {acronym(s.point.driver)} L{s.point.lap}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </div>
        </>
      )}
      {caption.length > 0 && <p className="muted">{caption.join(' · ')}</p>}
      {rcFailed && <p className="muted">Race control did not load: no red-flag bands.</p>}
    </section>
  );
}

/** A lap of the picks as a select value, `${driver}-${lap}`. */
const lapValue = (driver: number, lap: number) => `${driver}-${lap}`;

/** What a lap's slot shows instead of its trace (A§13), or null when it is drawn. */
function traceState(name: string, q: ReturnType<typeof useTelemetry>): string | null {
  if (q.error) {
    if (q.error instanceof HttpError && q.error.status === 404) return `No telemetry for ${name}.`;
    return `Telemetry for ${name} did not load: ${errorText(q.error)}`;
  }
  if (!q.data) return `Loading telemetry for ${name}…`;
  if (q.data.car.t.length === 0) return `No car data for ${name}.`;
  if (lateStart(q.data))
    return `No position data in the first ${((q.data.pos.t[0] ?? 0) / 1000).toFixed(1)} s of ${name}, so its distance cannot start at the line.`;
  if (tracePoints(q.data).filter((p) => p !== null).length < 2)
    return `No position data for ${name}, so no distance to draw it on.`;
  return null;
}

/**
 * The telemetry card (P7c, A§13): two picked laps' traces along the distance (T3, E2), Lap 1 and Lap 2 picked from
 * every lap of the picked drivers (E1), by default the first two picks' own bests. Each lap is its own request and
 * its own state, so one failing never blocks the other. The picks are component state, never in the URL.
 */
function TelemetryCard({
  session,
  detail,
  drivers,
  laps,
}: {
  session: number;
  detail: SessionDetail;
  drivers: readonly Driver[];
  laps: Laps;
}) {
  // Only the listed lap rows map a value back to a request, so its driver and lap are contract-checked integers.
  const rows = useMemo(() => {
    const picked = new Set(drivers.map((d) => d.number));
    return new Map(
      laps.filter((l) => picked.has(l.driver_number)).map((l) => [lapValue(l.driver_number, l.lap_number), l]),
    );
  }, [drivers, laps]);
  const bests = useMemo(() => colouredBests(laps), [laps]);
  const [chosen, setChosen] = useState<[string | null, string | null]>([null, null]);
  const slots = ([0, 1] as const).map((k) => {
    const own = drivers[k];
    const best = own && bests.get(own.number);
    const fallback = best ? lapValue(best.driver_number, best.lap_number) : null;
    const value = chosen[k] != null && rows.has(chosen[k]) ? chosen[k] : fallback;
    const row = value === null ? undefined : rows.get(value);
    const driver = row && drivers.find((d) => d.number === row.driver_number);
    return { k, own, value, row, driver, name: row && driver ? `${driver.acronym} L${row.lap_number}` : null };
  });
  const [one, two] = slots as [(typeof slots)[0], (typeof slots)[0]];
  const q1 = useTelemetry(session, one.row ? { driver: one.row.driver_number, lap: one.row.lap_number } : null);
  const q2 = useTelemetry(session, two.row ? { driver: two.row.driver_number, lap: two.row.lap_number } : null);
  const qs = [q1, q2] as const;
  const shown = slots.map((s) => {
    const q = qs[s.k];
    if (s.name === null) return { ...s, data: q.data, state: `No best lap for ${s.own?.acronym ?? '—'}: pick a lap.` };
    return { ...s, data: q.data, state: traceState(s.name, q) };
  });
  const drawn = shown.flatMap((s): TraceLap[] =>
    s.state === null && s.data && s.driver && s.name
      ? [{ name: s.name, driver: s.driver, telemetry: s.data, slot: s.k }]
      : [],
  );
  const year = detail.meeting.year;
  // Redrawn only when what it draws changes: the laps by name, driver and slot, and their answers.
  const shape = JSON.stringify(drawn.map((l) => [l.name, l.driver, l.slot]));
  const [d1, d2] = drawn.map((l) => l.telemetry);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape`, `d1` and `d2` stand for the drawn laps.
  const option = useCallback((t: ChartTokens) => traceChartOption(drawn, t, year), [shape, d1, d2, year]);

  return (
    <section className="card traces">
      <h2>Telemetry</h2>
      <div className="controls">
        {slots.map((s) => (
          <label key={s.k}>
            Lap {s.k + 1}
            <select
              aria-label={`Lap ${s.k + 1}`}
              value={s.value ?? ''}
              onChange={(e) => setChosen((c) => (s.k === 0 ? [e.target.value, c[1]] : [c[0], e.target.value]))}
            >
              {s.value === null && <option value="">Pick a lap</option>}
              {drivers.map((d) => (
                <optgroup key={d.number} label={d.acronym}>
                  {laps
                    .filter((l) => l.driver_number === d.number)
                    .map((l) => (
                      <option key={l.lap_number} value={lapValue(d.number, l.lap_number)}>
                        {`L${l.lap_number} ${l.lap_ms === null ? '—' : fmtLap(l.lap_ms)}`}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="keys">
        x: metres from each lap's first position sample · a gap of over 1.5 s breaks the line ·{' '}
        <span aria-hidden="true">──</span> lap 1 · <span aria-hidden="true">‑ ‑</span> lap 2
      </p>
      {drawn.length > 0 && <Chart label={traceLabel(drawn)} option={option} />}
      {shown.map(
        (s) =>
          s.state !== null && (
            <p key={s.k} className="muted">
              {s.state}
            </p>
          ),
      )}
    </section>
  );
}

/**
 * The session page's comparison: race control (races and practice, the same query as the Laps tab) bands both charts
 * once it arrives, and in a race the pit cycles close the side column. Outside races the track evolution follows.
 */
export function Compare({
  session,
  detail,
  drivers,
  laps,
  onReference,
}: {
  session: number;
  detail: SessionDetail;
  drivers: readonly Driver[];
  laps: Laps;
  onReference: (driver: number) => void;
}) {
  const { type, date_end } = detail.session;
  const race = type === 'Race';
  const practice = type === 'Practice';
  const rc = useRaceControl(session, (race || practice) && laps.length > 0);
  // A cached answer from the Laps tab comes back even when disabled: a race uses it for its lap periods, practice for
  // the red-flag clock periods.
  const periods = useMemo(() => (race && rc.data ? trackPeriods(rc.data).periods : []), [race, rc.data]);
  const clock = useMemo(
    () => (practice && rc.data ? clockPeriods(rc.data, Date.parse(date_end)) : []),
    [practice, rc.data, date_end],
  );
  return (
    <>
      <Comparison
        detail={detail}
        drivers={drivers}
        laps={laps}
        periods={periods}
        rcFailed={race && rc.error != null}
        onReference={onReference}
        traces={<TelemetryCard session={session} detail={detail} drivers={drivers} laps={laps} />}
      >
        {race && <StoredPitCycles session={session} drivers={drivers} laps={laps} periods={periods} rc={rc} />}
      </Comparison>
      {!race && <TrackEvolution detail={detail} laps={laps} clock={clock} rcFailed={practice && rc.error != null} />}
    </>
  );
}
