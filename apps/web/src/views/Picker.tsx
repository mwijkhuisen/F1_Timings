import type { Season } from '@f1/contracts';
import { useEffect } from 'react';
import { useSeason, useSeasons } from '../lib/api.ts';
import { Link, replace, sessionPath } from '../lib/routes.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';

// The season picker (D13): `/:year` lists the meetings and their sessions; `/` goes to the latest session.

/** The laps URL of the season's last started session that is not cancelled, or the season page without one. */
export function latestPath(year: number, season: Season, now: number): string {
  let latest: { meeting: Season[number]; start: number; key: number; name: string | null } | null = null;
  for (const meeting of season)
    for (const s of meeting.sessions) {
      const start = Date.parse(s.date_start);
      if (!s.is_cancelled && start <= now && (latest === null || start > latest.start))
        latest = { meeting, start, key: s.session_key, name: s.name };
    }
  return latest === null
    ? `/${year}`
    : sessionPath(year, { key: latest.meeting.meeting_key, name: latest.meeting.name }, latest, 'laps');
}

export function Meetings({ year, season }: { year: number; season: Season }) {
  if (season.length === 0) return <p>No meetings yet.</p>;
  return (
    <>
      <h1>{year}</h1>
      {season.map((m) => (
        <section key={m.meeting_key}>
          <h2>{m.is_cancelled ? <s>{m.name}</s> : m.name}</h2>
          {m.location && <p className="muted">{m.location}</p>}
          <ul className="sessions">
            {m.sessions.map((s) => (
              <li key={s.session_key}>
                {s.is_cancelled ? (
                  <s title="Cancelled">{s.name}</s>
                ) : (
                  <Link
                    to={sessionPath(
                      year,
                      { key: m.meeting_key, name: m.name },
                      { key: s.session_key, name: s.name },
                      'laps',
                    )}
                  >
                    {s.name}
                  </Link>
                )}
                <time dateTime={s.date_start}>{fmtInstant(s.date_start)}</time>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export function Picker({ year }: { year: number }) {
  const season = useSeason(year);
  if (!season.data) return <Pending error={season.error} />;
  return <Meetings year={year} season={season.data} />;
}

function LatestIn({ year }: { year: number }) {
  const season = useSeason(year);
  const path = season.data && latestPath(year, season.data, Date.now());
  useEffect(() => {
    if (path) replace(path);
  }, [path]);
  return path ? null : <Pending error={season.error} />;
}

/** `/`: the newest season's latest session (the API lists seasons newest first). */
export function Latest() {
  const seasons = useSeasons();
  if (!seasons.data) return <Pending error={seasons.error} />;
  const newest = seasons.data[0];
  return newest ? <LatestIn year={newest.year} /> : <p>No seasons yet.</p>;
}
