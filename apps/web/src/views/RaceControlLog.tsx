import type { Laps, RaceControl as Rows, SessionDetail } from '@f1/contracts';
import { useMemo, useState } from 'react';
import { countKinds, mentions, rcLog } from '../lib/pitwall.ts';
import { phaseName } from '../lib/quali.ts';
import { orderDrivers, sourceWords } from '../lib/session.ts';
import { RaceControlCard } from './PitWall.tsx';

// The race-control log of a session (#111, A§13): every message, oldest first, filtered by kind (the card's
// chips), by phase in qualifying and by driver. Every message is a text child: no markup, no title.

export function RaceControlLog({ detail, laps, rows }: { detail: SessionDetail; laps: Laps; rows: Rows }) {
  const qualifying = detail.session.type === 'Qualifying';
  const all = useMemo(() => rcLog(rows, qualifying), [rows, qualifying]);
  const drivers = useMemo(() => orderDrivers(detail, laps), [detail, laps]);
  const phases = qualifying ? Math.max(0, ...laps.map((l) => l.quali_phase ?? 0)) : 0;
  const [phase, setPhase] = useState<number | null>(null);
  const [number, setNumber] = useState<number | null>(null);
  if (all.length === 0)
    return <p className="muted">{`No race-control messages in ${sourceWords(detail.session.source)}.`}</p>;
  const driver = drivers.find((d) => d.number === number);
  const items = all.filter(
    (i) => (phase === null || i.phase === phase) && (driver === undefined || mentions(i, driver)),
  );
  return (
    <RaceControlCard
      rc={{ items, counts: countKinds(items) }}
      className="card rclog"
      filters={
        <div className="controls">
          {phases > 0 && (
            <fieldset className="segmented" aria-label="Phase">
              {[null, ...Array.from({ length: phases }, (_, i) => i + 1)].map((p) => (
                <button key={p ?? 'all'} type="button" aria-pressed={phase === p} onClick={() => setPhase(p)}>
                  {p === null ? 'All' : phaseName(detail.session.name, p)}
                </button>
              ))}
            </fieldset>
          )}
          <select
            aria-label="Driver"
            value={number ?? ''}
            onChange={(e) => setNumber(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">All drivers</option>
            {drivers.map((d) => (
              <option key={d.number} value={d.number}>
                {d.acronym}
              </option>
            ))}
          </select>
        </div>
      }
    />
  );
}
