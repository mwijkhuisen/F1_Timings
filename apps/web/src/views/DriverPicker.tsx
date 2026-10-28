import { type Driver, teamStyle } from '../lib/session.ts';

/** The driver multi-select of Compare and Mini-sectors (D2): one toggle chip per driver, in lap-table order. */
export function DriverPicker({
  drivers,
  selected,
  onToggle,
}: {
  drivers: Driver[];
  selected: readonly number[];
  onToggle: (driver: number) => void;
}) {
  return (
    <fieldset className="picker">
      <legend>Drivers</legend>
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
  );
}
