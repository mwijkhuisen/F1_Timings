import { useMemo, useState } from 'react';
import { type Driver, teamStyle } from '../lib/session.ts';

/**
 * The picks of Compare and Mini-sectors (E1, C4): in pick order, the first the reference. Until the first pick
 * `chosen` is `initial` (the session page's `?d=`), and without that the picks are the top 2 of `order`. One object
 * while `chosen` and `order` stay, so a memo can depend on it (the player, #112).
 */
export function usePicks(order: readonly Driver[], initial: number[] | null) {
  const [picked, setPicked] = useState<number[] | null>(null);
  const chosen = picked ?? initial;
  return useMemo(() => {
    const selected = chosen === null ? order.slice(0, 2) : chosen.flatMap((n) => order.filter((x) => x.number === n));
    const numbers = selected.map((x) => x.number);
    return {
      chosen,
      selected,
      numbers,
      toggle: (n: number) => setPicked(numbers.includes(n) ? numbers.filter((x) => x !== n) : [...numbers, n]),
      setReference: (n: number) => setPicked([n, ...numbers.filter((x) => x !== n)]),
    };
  }, [chosen, order]);
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
      <details className="add">
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
              onClick={() => onToggle(d.number)}
            >
              {d.acronym}
            </button>
          ))}
        </fieldset>
      </details>
    </fieldset>
  );
}
