import { type ReactNode, useEffect, useReducer, useState } from 'react';
import {
  type Clock,
  type Fastest,
  fmtLeft,
  type Kind,
  LIGHT,
  type Light,
  leftAt,
  type Pair,
  type RaceControl,
  type Strip as StripData,
} from '../lib/pitwall.ts';
import { Scroll } from '../ui/Scroll.tsx';

// The pit wall (A§13, P4d): the session light, the status strip and the side panel, from values derived once per store
// flush (lib/pitwall.ts). Only the LEFT cell ticks. Feed text renders as text only.

/** Re-renders the calling component every second while `on`. */
export function useTick(on: boolean) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [on]);
}

/** Red, yellow and green lamps in fixed places and the state in words: the place and the word carry it, not the hue. */
export function SessionLight({ light }: { light: Light }) {
  const { lamp, word } = LIGHT[light];
  return (
    <span className={lamp ? `light lamp-${lamp}` : 'light'}>
      <span className="lamps" aria-hidden="true">
        <i className="r" />
        <i className="y" />
        <i className="g" />
      </span>
      <span className="lw">{word}</span>
    </span>
  );
}

/** The time left at T, ticking on its own: it reads the derived clock, never the state. */
function Left({ clock, now, playing }: { clock: Clock; now: () => number; playing: boolean }) {
  useTick(playing);
  return <dd className="v">{fmtLeft(leftAt(clock, now()))}</dd>;
}

/** The status strip: the light, then each cell the feed has data for. */
export function Strip({ strip, now, playing }: { strip: StripData; now: () => number; playing: boolean }) {
  const { lap, clock, weather, latest } = strip;
  return (
    <dl className="strip" aria-label="Session state">
      <div>
        <dt>Session</dt>
        <dd>
          <SessionLight light={strip.light} />
        </dd>
      </div>
      {lap && (
        <div>
          <dt>Lap</dt>
          <dd className="v">
            {lap.current}
            {lap.total !== undefined && ` / ${lap.total}`}
          </dd>
        </div>
      )}
      {clock && (
        <div>
          <dt>Left</dt>
          <Left clock={clock} now={now} playing={playing} />
        </div>
      )}
      {weather && (
        <div>
          <dt>Weather</dt>
          <dd className="v">{weather}</dd>
        </div>
      )}
      {latest && (
        <div className="msg">
          <dt>Race control{latest.lap !== undefined && ` · L${latest.lap}`}</dt>
          <dd className="v" title={latest.text}>
            {latest.text}
          </dd>
        </div>
      )}
    </dl>
  );
}

export const FILTERS: [Kind | 'all', string][] = [
  ['all', 'All'],
  ['flags', 'Flags'],
  ['sc', 'SC/VSC'],
  ['incidents', 'Incidents'],
  ['limits', 'Track limits'],
];

/**
 * The race-control card: the kind chips with their counts, `filters` (the log's own, #111), then the messages as text.
 * `yet`: the live panel's empty texts say "yet" (A§13).
 */
export function RaceControlCard({
  rc,
  yet = false,
  className = 'card',
  filters,
}: {
  rc: RaceControl;
  yet?: boolean;
  className?: string;
  filters?: ReactNode;
}) {
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const items = filter === 'all' ? rc.items : rc.items.filter((i) => i.kind === filter);
  const y = yet ? ' yet' : '';
  return (
    <section className={className}>
      <h2>Race control</h2>
      <fieldset className="chips" aria-label="Filter">
        {FILTERS.map(([kind, label]) => (
          <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
            {label} {rc.counts[kind]}
          </button>
        ))}
      </fieldset>
      {filters}
      {items.length === 0 ? (
        <p className="muted">{rc.items.length === 0 ? `No messages${y}.` : `No messages of this kind${y}.`}</p>
      ) : (
        <Scroll label="Race control messages">
          <ol className="feed">
            {items.map((i) => (
              <li key={i.key}>
                {i.time !== undefined && <span className="time">{i.time}</span>}
                <span className="lap">{i.lap !== undefined && `L${i.lap}`}</span>
                <span>
                  {i.tag && <span className="cat">{i.tag}</span>}
                  {i.text}
                </span>
              </li>
            ))}
          </ol>
        </Scroll>
      )}
    </section>
  );
}

/** The side panel: race control with its filter, the cars within a second (races only) and the fastest lap so far. */
export function Panel({
  rc,
  pairs,
  fastest,
  race,
}: {
  rc: RaceControl;
  pairs: Pair[];
  fastest: Fastest | undefined;
  race: boolean;
}) {
  return (
    <aside className="side" aria-label="Session details">
      <RaceControlCard rc={rc} yet />
      {race && (
        <section className="card">
          <h2>Within a second</h2>
          {pairs.length === 0 ? (
            <p className="muted">No car within a second of the one ahead.</p>
          ) : (
            <ul className="rows">
              {pairs.map((p) => (
                <li key={p.behind.number}>
                  <span>
                    <span className="muted">P{p.place}</span> <b>{p.ahead.acronym}</b>{' '}
                    <span className="muted">from</span> <b>{p.behind.acronym}</b>
                  </span>
                  <span>{p.interval}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="card">
        <h2>Fastest lap so far</h2>
        {fastest ? (
          <p className="rows">
            <span>
              <span className="t-purple">
                {fastest.value}
                <span className="vh">, overall best</span>
              </span>{' '}
              <b>{fastest.driver.acronym}</b>
            </span>
            {fastest.lap !== undefined && <span className="muted">L{fastest.lap}</span>}
          </p>
        ) : (
          <p className="muted">No lap time yet.</p>
        )}
      </section>
    </aside>
  );
}
