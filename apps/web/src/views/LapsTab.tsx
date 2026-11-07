import type { Laps, SessionDetail } from '@f1/contracts';
import { useMemo, useState } from 'react';
import { useRaceControl } from '../lib/api.ts';
import { qualiPhases } from '../lib/quali.ts';
import { trackPeriods } from '../lib/track.ts';
import { LapTable } from './LapTable.tsx';
import { QualiTable } from './QualiTable.tsx';
import { QualiTiles, SessionTiles } from './Tiles.tsx';

// The Laps tab (P4b): the tiles, then the lap table, or for qualifying By phase | Every lap (component
// state, By phase first). Race control is fetched for races and sprints only, for the SC, VSC and red-flag
// bands; the table shows at once and gains its bands when it arrives.

export function LapsTab({ session, detail, laps }: { session: number; detail: SessionDetail; laps: Laps }) {
  const race = detail.session.type === 'Race';
  const qualifying = detail.session.type === 'Qualifying';
  // No laps, no table to band.
  const rc = useRaceControl(session, race && laps.length > 0);
  const track = useMemo(() => (rc.data ? trackPeriods(rc.data) : null), [rc.data]);
  const quali = useMemo(
    () => (qualifying ? qualiPhases(laps, detail.results) : null),
    [qualifying, laps, detail.results],
  );
  const [byPhase, setByPhase] = useState(true);
  if (laps.length === 0) return <p>No laps yet.</p>;
  return (
    <>
      {quali && <QualiTiles detail={detail} quali={quali} />}
      <SessionTiles detail={detail} laps={laps} />
      {quali && (
        <div className="controls">
          <fieldset className="segmented" aria-label="View">
            <button type="button" aria-pressed={byPhase} onClick={() => setByPhase(true)}>
              By phase
            </button>
            <button type="button" aria-pressed={!byPhase} onClick={() => setByPhase(false)}>
              Every lap
            </button>
          </fieldset>
        </div>
      )}
      {rc.error && <p className="muted">Race control did not load: no SC, VSC or red-flag bands.</p>}
      {quali && byPhase ? (
        <QualiTable detail={detail} quali={quali} />
      ) : (
        <LapTable detail={detail} laps={laps} track={track} />
      )}
    </>
  );
}
