import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { compoundOf, tyresWords, UNKNOWN_COMPOUND } from '../lib/compound.ts';
import type { CatchUpEvent } from '../lib/replay.ts';
import { type Driver, teamStyle } from '../lib/session.ts';
import { fmtClock, fmtLap } from '../lib/time.ts';
import { KIND_LABEL, KIND_NAME } from '../lib/track.ts';

// The catch-up dialog (#234, A§13): what the last forward seek jumped over, oldest first, each row with a replay from
// its T. A native modal <dialog> (D1), opened on mount: its buttons close it through <form method="dialog">, a row's ›
// with its T as the return value, which the close event hands to onReplay; ×, Continue and Esc close with none
// (onClose). Every kind's chip starts pressed (D2). Race-control text as sent, the rest in sentence case.

type Kind = CatchUpEvent['kind'];

const CHIPS: [Kind, string][] = [
  ['fastest', 'Fastest laps'],
  ['incident', 'Investigations'],
  ['stop', 'Pit stops'],
  ['deleted', 'Deleted laps'],
  ['flag', 'Flags'],
];

/** The tag's word and class: colour is data, so only an investigation, SC and VSC (amber) and a red flag (live). */
function tag(e: CatchUpEvent): [string, string] {
  if (e.kind === 'flag') return e.flag === 'red' ? ['Red flag', 'tag live'] : [KIND_LABEL[e.flag], 'tag warn'];
  if (e.kind === 'incident') return ['Investigation', 'tag warn'];
  return [e.kind === 'fastest' ? 'Fastest lap' : e.kind === 'stop' ? 'Pit stop' : 'Lap deleted', 'tag'];
}

const lapOf = (lap: number | null) => (lap === null ? '' : ` · L${lap}`);
const name = (d: Driver) => (
  <b className="drv" style={teamStyle(d)}>
    {d.acronym}
  </b>
);

function facts(e: CatchUpEvent, year: number | null): ReactNode {
  switch (e.kind) {
    case 'flag':
      return `${KIND_NAME[e.flag]}${lapOf(e.lap)}`;
    case 'incident':
      return `${e.text}${lapOf(e.lap)}`;
    case 'deleted':
      return (
        <>
          {name(e.driver)}
          {lapOf(e.lap)}
        </>
      );
    case 'stop': {
      const c = e.compound === null ? null : (compoundOf(e.compound, year) ?? UNKNOWN_COMPOUND);
      return (
        <>
          {name(e.driver)}
          {`${lapOf(e.lap)} `}
          {c && (
            <>
              <span className={`cmp cmp-${c.key}`} aria-hidden="true">
                {c.letter}
              </span>
              <span className="vh">{tyresWords(c)}</span>
            </>
          )}
        </>
      );
    }
    case 'fastest':
      return (
        <>
          {name(e.driver)}
          {` · ${e.part === null ? '' : `${e.part} `}L${e.lap} `}
          <span className="t-purple">{fmtLap(e.ms)}</span>
          <span className="vh">, overall best</span>
        </>
      );
  }
}

export function CatchUp({
  events,
  laps,
  minutes,
  year,
  onReplay,
  onClose,
}: {
  events: readonly CatchUpEvent[];
  /** The leader's laps at the old and the new T; null outside a race. */
  laps: readonly [number, number] | null;
  minutes: number;
  year: number | null;
  onReplay(t: number): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [off, setOff] = useState<ReadonlySet<Kind>>(() => new Set());
  // Never closed in a cleanup: under StrictMode that would fire the close event and onClose.
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const count = (k: Kind) => events.filter((e) => e.kind === k).length;
  const toggle = (k: Kind) =>
    setOff((o) => {
      const n = new Set(o);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  return (
    <dialog
      ref={ref}
      className="catchup"
      aria-labelledby={id}
      onClose={(e) => {
        const v = e.currentTarget.returnValue;
        if (v) onReplay(Number(v));
        else onClose();
      }}
    >
      <form method="dialog">
        <div className="hd">
          <div>
            <p className="eyebrow">
              {['Catch-up', laps && `L${laps[0]}–L${laps[1]}`, `${minutes} min`].filter(Boolean).join(' · ')}
            </p>
            <h2 id={id}>While you were away</h2>
            <p className="muted">
              {events.length === 1 ? '1 event' : `${events.length} events`} before this point. Nothing after it is
              shown.
            </p>
          </div>
          <button type="submit" value="" aria-label="Close">
            ×
          </button>
        </div>
        {events.length > 0 && (
          <fieldset className="chips" aria-label="Filter">
            {CHIPS.map(([k, label]) => {
              const n = count(k);
              return (
                n > 0 && (
                  <button key={k} type="button" aria-pressed={!off.has(k)} onClick={() => toggle(k)}>
                    {label} <b>{n}</b>
                  </button>
                )
              );
            })}
          </fieldset>
        )}
        {events.length === 0 ? (
          <p className="muted">Nothing happened before this point.</p>
        ) : events.every((e) => off.has(e.kind)) ? (
          <p className="muted">No events of these kinds.</p>
        ) : (
          <ol>
            {events.map((e, i) => {
              if (off.has(e.kind)) return null;
              const [word, cls] = tag(e);
              const at = fmtClock(e.t);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is frozen at the seek; events have no id.
                <li key={i} className="ev">
                  <span className="time">{at}</span>
                  <span className={cls}>{word}</span>
                  <span className="what">{facts(e, year)}</span>
                  <button type="submit" value={String(e.t)} aria-label={`Replay from ${at}`}>
                    ›
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="ft">
          <ul className="legend">
            <li>
              <span className="t-purple" aria-hidden="true">
                0:00.000
              </span>{' '}
              overall best at the time
            </li>
          </ul>
          <button type="submit" value="" className="primary">
            {laps ? `Continue at L${laps[1]}` : 'Continue'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
