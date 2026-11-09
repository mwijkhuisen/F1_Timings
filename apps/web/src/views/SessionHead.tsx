import type { Recordings, Season, SessionDetail, Weather } from '@f1/contracts';
import { useMemo } from 'react';
import { useRecordings, useSeason, useWeather } from '../lib/api.ts';
import { Link, sessionPath, type View } from '../lib/routes.ts';
import { roundNumbers, shortName } from '../lib/season.ts';
import { fmtInstant } from '../lib/time.ts';
import { headLine, summarise } from '../lib/weather.ts';
import { Cancelled } from '../ui/Cancelled.tsx';

// A session's head (A§13): "2026 · Round 19 · Mexico City", the meeting with the session boxed beside it, the start
// and circuit, the weekend's other sessions as pills (the view kept), and a Replay link when there is a recording.
// P5a: a weather line under the meta line on every tab, "Air 24–27 °C · Track 38–45 °C · Dry", once there are rows.

export function SessionHead({
  detail: d,
  season,
  recordings,
  weather = null,
  view,
}: {
  detail: SessionDetail;
  season: Season | null;
  recordings: Recordings | null;
  weather?: Weather | null;
  view: View;
}) {
  const key = d.session.meeting_key;
  const meeting = season?.find((m) => m.meeting_key === key);
  const round = season && roundNumbers(season).get(key);
  // Newest first, so the first one is the newest.
  const recording = recordings?.find((r) => r.session_key === d.session.session_key);
  const wx = useMemo(() => (weather && weather.length > 0 ? headLine(summarise(weather)) : null), [weather]);
  return (
    <div className="head">
      <p className="eyebrow">
        {[d.meeting.year, round && `Round ${round}`, d.meeting.location].filter(Boolean).join(' · ')}
      </p>
      <h1 tabIndex={-1}>
        {d.meeting.name} <span className="kind">{d.session.name}</span>
      </h1>
      <p className="muted">
        {fmtInstant(d.session.date_start)}
        {d.meeting.circuit_short_name && ` · ${d.meeting.circuit_short_name}`}
        {recording && (
          <>
            {' · '}
            <Link to={`/replay/${recording.id}`}>Replay</Link>
          </>
        )}
      </p>
      {wx && <p className="muted wxline">{wx}</p>}
      {meeting && (
        <nav className="wk" aria-label="This weekend's sessions">
          {meeting.sessions.map((s) =>
            s.is_cancelled ? (
              <Cancelled key={s.session_key}>{shortName(s.name)}</Cancelled>
            ) : (
              <Link
                key={s.session_key}
                to={sessionPath(
                  d.meeting.year,
                  { key, name: d.meeting.name },
                  { key: s.session_key, name: s.name },
                  view,
                )}
                aria-current={s.session_key === d.session.session_key ? 'page' : undefined}
              >
                {shortName(s.name)}
              </Link>
            ),
          )}
        </nav>
      )}
    </div>
  );
}

/**
 * The head with the season, the recordings and the weather, each shown once it loads (cached across pages; the
 * weather is the Weather tab's query).
 */
export function SessionHeadLoader({ detail, view }: { detail: SessionDetail; view: View }) {
  const season = useSeason(detail.meeting.year);
  const recordings = useRecordings();
  const weather = useWeather(detail.session.session_key);
  return (
    <SessionHead
      detail={detail}
      season={season.data ?? null}
      recordings={recordings.data ?? null}
      weather={weather.data ?? null}
      view={view}
    />
  );
}
