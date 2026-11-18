import { CIRCUITS, type Views } from '@f1/contracts';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useCircuitMap } from '../lib/api.ts';
import { teamStyle } from '../lib/session.ts';
import { type PosChannel, RUN_GAP_MS } from '../lib/stream.ts';
import { fmtClock } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { vars } from './Pace.tsx';
import { useTick } from './PitWall.tsx';
import { ext } from './RainMap.tsx';
import { driverOf } from './Tower.tsx';

// The player's Map tab (P7a, A§13): every car at T on the circuit outline (bacinger/f1-circuits), from the stream's
// `pos` events. The positions are already in the outline's frame (the server's fit, A§11.3): metres from the outline's
// centre, x east and y south, drawn in km. React sets only the custom properties --x and --y (a `.car` moves by
// transform, and a transition glides it between two samples of one run), so the CSP holds. Named TrackMap: `Map` would
// shadow the global.

const NO_OUTLINE = 'No circuit outline for this venue.';
const NO_FIT = 'No car positions yet: the map places the cars once the feed has one full lap on track.';
const NO_FIT_ENDED = 'No car positions: no lap of this recording places the cars on the outline.';
const NO_CARS = 'No car positions in the feed yet.';
/** A car's sample behind the newest sample by more than this has dropped out (T3, A§11.3). */
const DROPOUT_MS = RUN_GAP_MS;
/** A sample behind T by more than this: the position feed stopped (a gap over 5 s means a reconnect, A§6.2). */
const FEED_STOPPED_MS = 5000;
const PAD = 0.08;

/** The outline's bounding box plus 8 %, as a viewBox in km; null for a path with no point. */
function viewBoxOf(outline: string): [number, number, number, number] | null {
  const n = (outline.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  if (xs.length === 0 || xs.length !== ys.length) return null;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = PAD * Math.max(x1 - x0, y1 - y0);
  return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
}

type Props = {
  /** The meeting's circuit_short_name; undefined while the session is not loaded (or its query failed). */
  circuit: string | null | undefined;
  /**
   * The store's positions channel: undefined when not asked, null while there is no fitted frame. Read here, so a `pos`
   * event renders the map alone (P7a review).
   */
  positions: PosChannel;
  /** The recording has ended: no frame now means none for good. */
  ended: boolean;
  drivers: Views['DriverList'];
  /** T, in epoch ms. */
  now: () => number;
  playing: boolean;
};

export function TrackMap({ circuit, positions, ended, drivers, now, playing }: Props) {
  const pos = useSyncExternalStore(positions.subscribe, positions.get);
  const name = circuit ?? '';
  const id = Object.hasOwn(CIRCUITS, name) ? (CIRCUITS[name]?.id ?? null) : null;
  const map = useCircuitMap(id);
  useTick(playing); // the 5 s rule runs on T, which moves between events
  // The t each car was last drawn at: a dot glides only from a sample of its own run (A§13), else it jumps.
  const drawn = useRef(new Map<string, number>());
  useEffect(() => {
    drawn.current = new Map(Object.entries(pos?.cars ?? {}).map(([n, c]) => [n, c.t]));
  }, [pos]);
  const outline = map.data?.outline ?? null;
  const box = useMemo(() => (outline === null ? null : viewBoxOf(outline)), [outline]);

  if (circuit === undefined) return <Pending error={null} />; // which venue is not known yet
  if (id === null) return <p>{NO_OUTLINE}</p>;
  if (!map.data) return <Pending error={map.error} retry={() => void map.refetch()} />;
  if (outline === null || box === null) return <p>{NO_OUTLINE}</p>;

  const T = now();
  const cars = Object.entries(pos?.cars ?? {})
    .map(([n, c]) => {
      const stale = pos != null && (c.t < pos.at - DROPOUT_MS || c.t < T - FEED_STOPPED_MS);
      const was = drawn.current.get(n);
      return { n, c, stale, move: !stale && was !== undefined && was >= c.run && was <= c.t };
    })
    .sort((a, b) => Number(a.n) - Number(b.n));
  const lost = cars.filter((k) => k.stale).length;
  const label =
    cars.length > 0
      ? `Car positions at ${fmtClock(T)}: ${cars.length} cars, ${lost} without a recent position`
      : 'Circuit outline';
  const size = Math.max(box[2], box[3]);
  const r = Number((size * 0.014).toFixed(4));
  return (
    <section className="card">
      <div className="panel-title">
        <h2>Car positions</h2>
        <p>at T</p>
      </div>
      <svg className="trackmap" viewBox={box.join(' ')} role="img" aria-label={label}>
        <path className="map-halo" d={outline} />
        <path className="map-outline" d={outline} />
        {cars.map(({ n, c, stale, move }) => {
          const d = driverOf(drivers, n);
          return (
            <g
              key={n}
              className={`car${move ? ' move' : ''}${stale ? ' stale' : ''}`}
              style={{ ...teamStyle(d), ...vars({ '--x': String(c.x / 1000), '--y': String(c.y / 1000) }) }}
            >
              <circle r={r} />
              <text x={r * 1.4} y={r * 0.4} fontSize={Number((size * 0.03).toFixed(4))}>
                {d.acronym}
              </text>
            </g>
          );
        })}
      </svg>
      {pos == null ? <p>{ended ? NO_FIT_ENDED : NO_FIT}</p> : cars.length === 0 && <p>{NO_CARS}</p>}
      <p className="foot rainsrc">
        Circuit outline: {ext('https://github.com/bacinger/f1-circuits', 'bacinger/f1-circuits')} (
        {ext('/third-party-licences.txt', 'MIT')}), simplified.
      </p>
    </section>
  );
}
