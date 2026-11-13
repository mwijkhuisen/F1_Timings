import { CIRCUITS, type SessionDetail } from '@f1/contracts';
import { memo, type ReactNode, useCallback, useId, useMemo, useState } from 'react';
import { type OsmLayers, useCircuitMap, useRain } from '../lib/api.ts';
import {
  cellRect,
  firstFrameAt,
  lastFrameAtOrBefore,
  type RainFrame,
  type RainGrid,
  rainStep,
  rainSummary,
} from '../lib/rain.ts';
import { fmtHm } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';

// The rain map (P5c, A§13): Open-Meteo's 7 × 7 model field around the circuit, one 15-minute frame at a time, over the
// circuit outline (bacinger/f1-circuits) and the OpenStreetMap water, coast and roads, all in km from the circuit's
// centre (y = −north). Classes only: every colour is a token in styles.css, so the CSP (no style=) and both themes
// hold. The credits are ADR-0008 §4's, word for word.

const NO_OUTLINE = 'No circuit outline for this venue.';
const NOT_FETCHED = 'Rain map not fetched yet.';
/** A live grid's frames still arrive until date_end + 30 min; after that it waits for the final fetch (A§8). */
const ARRIVING_MS = 30 * 60_000;
const RINGS = [1, 2, 3, 4, 5];
const LEGEND = [
  [1, 'Light 0.1–2.5 mm/h'],
  [2, 'Moderate 2.5–7.6 mm/h'],
  [3, 'Heavy ≥ 7.6 mm/h'],
] as const;
const EMPTY: RainFrame[] = [];
/** A ring label's place: on the south-east diagonal, nudged off the ring. */
const diag = (r: number, nudge: number) => Number((r * Math.SQRT1_2 + nudge).toFixed(2));

const ext = (href: string, text: string) => (
  <a href={href} rel="noreferrer">
    {text}
  </a>
);

/** The credits under the map: Open-Meteo and the outline always, OSM only when drawn, the Met Office for Silverstone. */
function Credits({ grid, osm }: { grid: RainGrid; osm: boolean }) {
  return (
    <p className="foot rainsrc">
      Rain: Weather data by {ext('https://open-meteo.com/', 'Open-Meteo.com')} (
      {ext('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}). Modelled, not radar; {grid.size} ×{' '}
      {grid.size} points binned into three steps. Circuit outline:{' '}
      {ext('https://github.com/bacinger/f1-circuits', 'bacinger/f1-circuits')} (
      {ext('/third-party-licences.txt', 'MIT')}
      ), simplified.
      {osm && (
        <>
          {' © '}
          {ext('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} contributors,{' '}
          {ext('https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL')}.
        </>
      )}
      {grid.map_id === 'gb-1948' && (
        <>
          {' '}
          Includes UK Met Office model data ({ext('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0')}).
        </>
      )}
    </p>
  );
}

type MapProps = {
  grid: RainGrid;
  /** At least one frame, in date order; the player passes only those up to T. */
  frames: readonly RainFrame[];
  outline: string | null;
  osm: OsmLayers | null;
  /** Open-Meteo has no native 15-minute model here (CIRCUITS' native15 false). */
  coarse?: boolean;
  index: number;
  onIndex(i: number): void;
};

/** The map, its legend, the time slider and the summary, from props only; memo, so the player's tick skips it. */
export const RainMap = memo(function RainMap({ grid, frames, outline, osm, coarse = false, index, onIndex }: MapProps) {
  const id = useId();
  const i = Math.min(Math.max(0, index), frames.length - 1);
  const frame = frames[i] as RainFrame;
  const summary = rainSummary(frame.mm, grid.size, grid.step_m);
  const time = fmtHm(Date.parse(frame.date));
  const drawn = osm !== null && (osm.water !== '' || osm.coast !== '' || osm.roads !== '');
  return (
    <>
      {outline === null && <p>{NO_OUTLINE}</p>}
      {coarse && <p className="muted">Coarse model here: the field may look uniform.</p>}
      <div className="rainbody">
        <svg className="rainfield" viewBox="-6 -6 12 12" role="img" aria-label={summary}>
          {osm?.water && <path className="map-water" d={osm.water} />}
          {frame.mm.map((v, k) => {
            const step = rainStep(v);
            if (step === 0) return null;
            const { x, y, w } = cellRect(k, grid.size, grid.step_m);
            // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its grid index
            return <rect key={k} className={`rain-${step}`} x={x} y={y} width={w} height={w} />;
          })}
          {osm?.coast && <path className="map-coast" d={osm.coast} />}
          {osm?.roads && <path className="map-road" d={osm.roads} />}
          <g className="map-rings">
            {RINGS.map((r) => (
              <circle key={r} cx={0} cy={0} r={r} />
            ))}
          </g>
          <g className="map-labels">
            {RINGS.map((r) => (
              <text key={r} x={diag(r, 0.08)} y={diag(r, 0.36)}>
                {r} km
              </text>
            ))}
          </g>
          {outline !== null && (
            <>
              <path className="map-halo" d={outline} />
              <path className="map-outline" d={outline} />
            </>
          )}
          <g className="map-north">
            <path d="M 5.3 -5.75 L 5.62 -5 L 4.98 -5 Z" />
            <text x={5.3} y={-4.5}>
              N
            </text>
          </g>
          <g className="map-scale">
            <path d="M -5.6 5.3 L -5.6 5.5 L -3.6 5.5 L -3.6 5.3" />
            <text x={-4.6} y={5.2}>
              2 km
            </text>
          </g>
        </svg>
        <ul className="rainlegend" aria-label="Rain, mm/h">
          {LEGEND.map(([step, text]) => (
            <li key={step}>
              <svg viewBox="0 0 1 1" aria-hidden="true">
                <rect className={`rain-${step}`} width={1} height={1} />
              </svg>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <div className="raintime">
        <input
          id={id}
          type="range"
          aria-label="Rain map time"
          aria-valuetext={`${time} Amsterdam time`}
          aria-describedby={`${id}-sum`}
          min={0}
          max={frames.length - 1}
          step={1}
          value={i}
          onChange={(e) => onIndex(Number(e.target.value))}
        />
        <output htmlFor={id}>{time}</output>
      </div>
      <p id={`${id}-sum`} className="rainsum" aria-live="polite">
        {summary}
      </p>
      <Credits grid={grid} osm={drawn} />
    </>
  );
});

const Card = ({ children }: { children: ReactNode }) => (
  <section className="card rainmap">
    <div className="panel-title">
      <h2>Rain around the circuit</h2>
      <p>mm/h, Amsterdam time</p>
    </div>
    {children}
  </section>
);

type Options = { live?: boolean; cap?: number | undefined };

/**
 * The rain map's states (A§13): nothing for a cancelled session, a line for a venue without a circuit, the map once
 * the grid and the map files are in. `cap` (the player's T): only frames dated at or before it, and the slider follows
 * T while it sits on the newest of them; moved back, it stays until moved to the newest again (or T seeks back past it).
 */
export function RainMapCard({ detail, ...options }: { detail: SessionDetail } & Options) {
  if (detail.session.is_cancelled) return null;
  const name = detail.meeting.circuit_short_name ?? '';
  const circuit = Object.hasOwn(CIRCUITS, name) ? CIRCUITS[name] : undefined;
  return (
    <Card>
      {circuit ? (
        <RainLoader key={detail.session.session_key} session={detail.session} coarse={!circuit.native15} {...options} />
      ) : (
        <p>{NO_OUTLINE}</p>
      )}
    </Card>
  );
}

function RainLoader({
  session,
  coarse,
  live = false,
  cap,
}: { session: SessionDetail['session']; coarse: boolean } & Options) {
  const rain = useRain(session.session_key, live);
  const grid = rain.data?.grid ?? null;
  const map = useCircuitMap(grid?.map_id ?? null);
  const frames = rain.data?.frames ?? EMPTY;
  const capped = cap !== undefined;
  // Everything below changes only when T crosses a frame, not on each tick.
  const last = capped ? lastFrameAtOrBefore(frames, cap) : frames.length - 1;
  const visible = useMemo(() => frames.slice(0, last + 1), [frames, last]);
  const [pick, setPick] = useState<number | null>(null);
  if (capped && pick !== null && pick >= last) setPick(null);
  const onIndex = useCallback((i: number) => setPick(capped && i >= last ? null : i), [capped, last]);

  if (!rain.data) return <Pending error={rain.error} />;
  // A failed grid is never retried (A§8): say so rather than "not fetched yet" (#99).
  if (grid?.state === 'failed' && frames.length === 0) return <p>Rain map fetch failed: no rain data.</p>;
  if (grid === null || frames.length === 0) return <p>{NOT_FETCHED}</p>;
  if (last < 0) return <p>No rain frame up to this time yet.</p>;
  if (!map.data) return <Pending error={map.error} />;
  const lastFrame = frames.at(-1)?.date;
  // The clock is the query's last answer, which a live grid refreshes every 60 s, so the note moves on with it.
  const arriving = rain.dataUpdatedAt <= Date.parse(session.date_end) + ARRIVING_MS;
  const note =
    grid.state === 'failed' && lastFrame
      ? `Rain data incomplete: the fetch failed after ${fmtHm(Date.parse(lastFrame))}.`
      : grid.state === 'live' && !capped
        ? arriving
          ? 'Frames still arriving (every 15 min).'
          : 'Rain data provisional: the final frames come 24 h after the end.'
        : null;
  const index = capped
    ? pick !== null && pick < last
      ? pick
      : last
    : (pick ?? firstFrameAt(frames, session.date_start));
  return (
    <>
      {note && <p>{note}</p>}
      <RainMap
        grid={grid}
        frames={visible}
        outline={map.data.outline}
        osm={map.data.osm}
        coarse={coarse}
        index={index}
        onIndex={onIndex}
      />
    </>
  );
}
