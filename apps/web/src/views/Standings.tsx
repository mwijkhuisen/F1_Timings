import type { Standings as StandingsData } from '@f1/contracts';
import { useSeason, useStandings } from '../lib/api.ts';
import { Link, sessionPath } from '../lib/routes.ts';
import { latestCounted, type Slot } from '../lib/season.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { StandingsSection } from './Result.tsx';

// `/:year/standings` (#201, A§13): the standings after the season's latest race or sprint with data, shown at once
// (E4), as on that session's Result tab. It asks /seasons/:year and that one session's /standings, nothing else.

/** The page, pure: `slot` is `latestCounted`'s pick, `standings` its answer (null without a pick). */
export function StandingsView({
  year,
  slot,
  standings,
}: {
  year: number;
  slot: Slot | null;
  standings: StandingsData | null;
}) {
  const h1 = <h1 tabIndex={-1}>{`Standings ${year}`}</h1>;
  if (!slot || !standings || (standings.drivers.length === 0 && standings.teams.length === 0))
    return (
      <>
        {h1}
        <p>{`No standings for ${year} yet.`}</p>
      </>
    );
  const { meeting: m, session: s } = slot;
  const result = sessionPath(
    year,
    { key: m.meeting_key, name: m.name },
    { key: s.session_key, name: s.name, type: s.type },
    'result',
  );
  return (
    <>
      {h1}
      <p className="muted">
        After the <Link to={result}>{`${m.name ?? '—'} · ${s.name ?? '—'}`}</Link>
      </p>
      <div className="standings-grid">
        <StandingsSection standings={standings} />
      </div>
    </>
  );
}

function Loader({ year, slot }: { year: number; slot: Slot }) {
  const q = useStandings(slot.session.session_key);
  if (!q.data) return <Pending error={q.error} retry={() => void q.refetch()} />;
  return <StandingsView year={year} slot={slot} standings={q.data} />;
}

export function Standings({ year }: { year: number }) {
  const season = useSeason(year);
  if (!season.data) return <Pending error={season.error} retry={() => void season.refetch()} />;
  const slot = latestCounted(season.data);
  return slot ? (
    <Loader key={slot.session.session_key} year={year} slot={slot} />
  ) : (
    <StandingsView year={year} slot={null} standings={null} />
  );
}
