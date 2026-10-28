import type { Laps, SessionDetail, Stints } from '@f1/contracts';
import type { CSSProperties } from 'react';
import { useStints } from '../lib/api.ts';
import { compoundOf, orderDrivers, teamStyle } from '../lib/session.ts';
import { Pending } from '../ui/ErrorView.tsx';

// Horizontal compound bars per driver (D11), fitted to 100 % width: nothing scrolls sideways.

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

export function StintBars({ detail, laps, stints }: { detail: SessionDetail; laps: Laps; stints: Stints }) {
  const drivers = orderDrivers(detail, laps);
  if (drivers.length === 0 || stints.length === 0) return <p>No stints yet.</p>;
  // The session's highest lap number; a stint that runs past it still fits.
  const total = Math.max(...laps.map((l) => l.lap_number), ...stints.map((s) => s.lap_end ?? 0));
  return (
    <ol className="stints">
      {drivers.map((d) => (
        <li key={d.number}>
          <span className="drv" style={teamStyle(d)} title={d.name ?? undefined}>
            {d.acronym}
          </span>
          <span className="bar">
            {stints.map((s) => {
              if (s.driver_number !== d.number || s.lap_start === null || s.lap_end === null) return null;
              const compound = compoundOf(s.compound);
              const range = `${s.lap_start}–${s.lap_end}`;
              const age = s.tyre_age_at_start === null ? '' : `, tyre age ${s.tyre_age_at_start} at start`;
              const style = {
                '--x': pct((s.lap_start - 1) / total),
                '--w': pct((s.lap_end - s.lap_start + 1) / total),
              } as CSSProperties;
              return (
                <span
                  key={s.stint_number}
                  className={`seg cmp-${compound ?? 'unknown'}`}
                  style={style}
                  title={`${s.compound ?? 'Unknown compound'}, laps ${range}${age}`}
                >
                  <b>{compound?.[0]?.toUpperCase() ?? '?'}</b> <span className="range">{range}</span>
                </span>
              );
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StintsTab({ session, detail, laps }: { session: number; detail: SessionDetail; laps: Laps }) {
  const stints = useStints(session);
  if (!stints.data) return <Pending error={stints.error} />;
  return <StintBars detail={detail} laps={laps} stints={stints.data} />;
}
