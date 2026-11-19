import { useMemo, useRef, useState } from 'react';
import { type Driver, teamStyle } from '../lib/session.ts';
import { saveTable } from '../lib/tables.ts';

/**
 * The picks of Compare and Mini-sectors (E1, C4) from `chosen`, in pick order, the first the reference; null `chosen`
 * (before the first pick) is `fallback` (the saved picks the session has, #237 D1) or else the top 2 of `order`. `pick`
 * stores a new choice, which is also saved. The player (#112) holds `chosen` itself, so the picks survive a tab switch.
 */
export function picksOf(
  order: readonly Driver[],
  chosen: number[] | null,
  pick: (numbers: number[]) => void,
  fallback: number[] | null = null,
) {
  const from = chosen ?? fallback;
  const selected = from === null ? order.slice(0, 2) : from.flatMap((n) => order.filter((x) => x.number === n));
  const numbers = selected.map((x) => x.number);
  const set = (picks: number[]) => {
    pick(picks);
    saveTable('picks', picks);
  };
  return {
    chosen,
    selected,
    numbers,
    toggle: (n: number) => set(numbers.includes(n) ? numbers.filter((x) => x !== n) : [...numbers, n]),
    setReference: (n: number) => set([n, ...numbers.filter((x) => x !== n)]),
  };
}

/** The session page's picks: until the first pick `chosen` is `initial` (its `?d=`), then `saved` (#237 D1), then the top 2. */
export function usePicks(order: readonly Driver[], initial: number[] | null, saved: number[] | null = null) {
  const [picked, setPicked] = useState<number[] | null>(null);
  const chosen = picked ?? initial;
  return useMemo(() => picksOf(order, chosen, setPicked, saved), [chosen, order, saved]);
}

/**
 * The driver picker of Compare and Mini-sectors (D2, C3): the picked drivers as chips in pick order, each with a
 * Remove button, then "Add driver", a native disclosure holding one toggle per driver in lap-table order.
 * On Compare (`showReference`) the first chip says "reference".
 */
export function DriverPicker({
  drivers,
  selected,
  onToggle,
  showReference = false,
}: {
  drivers: Driver[];
  selected: readonly number[];
  onToggle: (driver: number) => void;
  showReference?: boolean;
}) {
  const add = useRef<HTMLDetailsElement>(null);
  const picked = selected.flatMap((n) => drivers.filter((d) => d.number === n));
  return (
    <fieldset className="picked" aria-label="Drivers">
      {picked.map((d, i) => (
        <span key={d.number} className="chip drv" style={teamStyle(d)} title={d.name ?? undefined}>
          {d.acronym}
          {showReference && i === 0 && <span className="ref">reference</span>}
          <button type="button" aria-label={`Remove ${d.acronym}`} onClick={() => onToggle(d.number)}>
            ×
          </button>
        </span>
      ))}
      <details className="add" ref={add}>
        <summary>Add driver</summary>
        <fieldset className="picker">
          <legend>All drivers</legend>
          {drivers.map((d) => (
            <button
              key={d.number}
              type="button"
              className="drv"
              style={teamStyle(d)}
              title={d.name ?? undefined}
              aria-pressed={selected.includes(d.number)}
              onClick={() => {
                onToggle(d.number);
                // A pick closes the disclosure (#238).
                if (add.current) add.current.open = false;
              }}
            >
              {d.acronym}
            </button>
          ))}
        </fieldset>
      </details>
    </fieldset>
  );
}
