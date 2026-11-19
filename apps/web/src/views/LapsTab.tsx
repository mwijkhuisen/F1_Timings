import type { Laps, SessionDetail } from '@f1/contracts';
import { type ReactNode, useMemo } from 'react';
import { useOvertakes, useRaceControl } from '../lib/api.ts';
import { rcLog } from '../lib/pitwall.ts';
import { type Quali, qualiPhases } from '../lib/quali.ts';
import { useTable } from '../lib/tables.ts';
import { trackPeriods } from '../lib/track.ts';
import { LapTable } from './LapTable.tsx';
import { QualiTable } from './QualiTable.tsx';
import { RaceControlLog } from './RaceControlLog.tsx';
import { SpeedTable } from './Speeds.tsx';
import { QualiTiles, SessionTiles } from './Tiles.tsx';

// The Laps tab (P4b): the tiles, then the lap table, or for qualifying By phase | Every lap (component
// state, By phase first), then the speed traps and own bests (#114), then the race-control log (#111). Race control is fetched for every session type; only
// races and sprints draw the SC, VSC and red-flag bands from it. The table shows at once and gains its bands when
// it arrives.

/** By phase | Every lap (component state, By phase first): the phase table, or `children` for every lap. Also the player's. */
export function QualiSwitch({ detail, quali, children }: { detail: SessionDetail; quali: Quali; children: ReactNode }) {
  const [byPhase = true, set] = useTable('byPhase');
  return (
    <>
      <div className="controls">
        <fieldset className="segmented" aria-label="View">
          <button type="button" aria-pressed={byPhase} onClick={() => set(true)}>
            By phase
          </button>
          <button type="button" aria-pressed={!byPhase} onClick={() => set(false)}>
            Every lap
          </button>
        </fieldset>
      </div>
      {byPhase ? <QualiTable detail={detail} quali={quali} /> : children}
    </>
  );
}

export function LapsTab({ session, detail, laps }: { session: number; detail: SessionDetail; laps: Laps }) {
  const race = detail.session.type === 'Race';
  const qualifying = detail.session.type === 'Qualifying';
  // The session page shows its reason instead of this tab when there are no laps (#99).
  const rc = useRaceControl(session);
  const overtakes = useOvertakes(session, race);
  const track = useMemo(() => (race && rc.data ? trackPeriods(rc.data) : null), [race, rc.data]);
  const quali = useMemo(
    () => (qualifying ? qualiPhases(laps, detail.results) : null),
    [qualifying, laps, detail.results],
  );
  // The race-control link only when the log renders its card (RaceControlLog: no items, no card).
  const hasRc = useMemo(
    () => rc.data !== undefined && rcLog(rc.data, qualifying, overtakes.data ?? [], laps).length > 0,
    [rc.data, qualifying, overtakes.data, laps],
  );
  return (
    <>
      <p className="jump">
        <a href="#laps">Laps</a> · <a href="#speeds">Speed traps</a>
        {hasRc && (
          <>
            {' · '}
            <a href="#race-control">Race control</a>
          </>
        )}
      </p>
      {quali && <QualiTiles detail={detail} quali={quali} />}
      <SessionTiles detail={detail} laps={laps} />
      {race && rc.error && <p className="muted">Race control did not load: no SC, VSC or red-flag bands.</p>}
      <div id="laps">
        {quali ? (
          <QualiSwitch detail={detail} quali={quali}>
            <LapTable detail={detail} laps={laps} track={track} />
          </QualiSwitch>
        ) : (
          <LapTable detail={detail} laps={laps} track={track} marks />
        )}
      </div>
      <div id="speeds">
        <SpeedTable detail={detail} laps={laps} telemetry />
      </div>
      {rc.data && <RaceControlLog detail={detail} laps={laps} rows={rc.data} overtakes={overtakes.data} />}
      {!race && rc.error && <p className="muted">Race control did not load.</p>}
    </>
  );
}
