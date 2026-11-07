import type { Live, Recordings, Season as SeasonData } from '@f1/contracts';
import { useEffect, useState } from 'react';
import { useLive, useRecordings, useSeason, useSeasons } from '../lib/api.ts';
import { Link, replace, sessionPath } from '../lib/routes.ts';
import {
  type Meeting,
  nextSession,
  roundNumbers,
  type SeasonSession,
  type SessionState,
  sessionState,
  startPath,
  thisWeekend,
} from '../lib/season.ts';
import { fmtCountdown, fmtInstant, fmtTrack } from '../lib/time.ts';
import { Cancelled } from '../ui/Cancelled.tsx';
import { Pending } from '../ui/ErrorView.tsx';

// `/:year` (A§13): this weekend first, its sessions in words, then the other meetings. Never a result.
// `/` goes to /live while a recording is open, else to the newest season with a session (owner D1).

const dot = (...parts: (string | number | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/**
 * The session's name: a link to its lap table, struck through and unlinked when cancelled, with the word for a screen
 * reader unless `worded` (the state beside it says so).
 */
function Name({
  year,
  meeting: m,
  session: s,
  worded,
}: {
  year: number;
  meeting: Meeting;
  session: SeasonSession;
  worded?: boolean;
}) {
  if (m.is_cancelled || s.is_cancelled) return worded ? <s>{s.name}</s> : <Cancelled>{s.name}</Cancelled>;
  const to = sessionPath(year, { key: m.meeting_key, name: m.name }, { key: s.session_key, name: s.name }, 'laps');
  return <Link to={to}>{s.name}</Link>;
}

const WORD: Record<SessionState['kind'], string> = {
  cancelled: 'cancelled',
  live: 'live now',
  recorded: 'recorded',
  ready: 'laps ready',
  pending: 'laps pending',
  next: 'next',
  scheduled: 'scheduled',
};

/** The state in words; the dot before it (CSS) is decoration. */
const State = ({ state }: { state: SessionState }) => (
  <span className={`state ${state.kind}`}>
    {WORD[state.kind]}
    {state.kind === 'live' && (
      <>
        {' · '}
        <Link to="/live">Follow</Link>
      </>
    )}
    {state.kind === 'recorded' && (
      <>
        {' · '}
        <Link to={`/replay/${state.recording.id}`}>Replay</Link>
      </>
    )}
  </span>
);

/** Time left until `to` (epoch ms), ticking every minute. */
export function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return <p className="count">{fmtCountdown(to - now)}</p>;
}

export function SeasonView({
  year,
  season,
  live,
  recordings,
  now,
}: {
  year: number;
  season: SeasonData;
  live: Live | null;
  recordings: Recordings;
  now: number;
}) {
  if (season.length === 0)
    return (
      <>
        <h1 tabIndex={-1}>{year}</h1>
        <p>No meetings yet.</p>
      </>
    );
  const rounds = roundNumbers(season);
  const weekend = thisWeekend(season, now, live);
  const next = nextSession(season, now);
  const nextKey = next?.session.session_key ?? null;
  const upNext = weekend && next?.meeting.meeting_key === weekend.meeting_key ? next.session : null;
  return (
    <>
      <h1 tabIndex={-1}>{year}</h1>
      {weekend && (
        <section className="weekend" aria-label="This weekend">
          <div>
            <p className="eyebrow">
              {dot(
                'This weekend',
                rounds.has(weekend.meeting_key) && `Round ${rounds.get(weekend.meeting_key)} of ${rounds.size}`,
                weekend.country_code,
              )}
            </p>
            <h2>{weekend.name}</h2>
            <p className="muted">
              {dot(weekend.circuit_short_name, `Amsterdam time${weekend.gmt_offset ? ', track time beside it' : ''}`)}
            </p>
            <ul className="sess full">
              {weekend.sessions.map((s) => {
                const track = fmtTrack(s.date_start, weekend.gmt_offset);
                return (
                  <li key={s.session_key}>
                    <Name year={year} meeting={weekend} session={s} worded />
                    <span className="when">
                      <time dateTime={s.date_start}>{fmtInstant(s.date_start)}</time>
                      {track && ` · ${track} at the track`}
                    </span>
                    <State state={sessionState(s, recordings, live, now, nextKey)} />
                  </li>
                );
              })}
            </ul>
          </div>
          {upNext && (
            <div className="upnext">
              <p className="eyebrow">Up next</p>
              <Countdown to={Date.parse(upNext.date_start)} />
              <p>
                {upNext.name} · <time dateTime={upNext.date_start}>{fmtInstant(upNext.date_start)}</time>
              </p>
              <Link className="btnlink" to="/live">
                Open Live
              </Link>
            </div>
          )}
        </section>
      )}
      <h2 className="eyebrow sect">{weekend ? `The rest of ${year}` : 'Meetings'}</h2>
      <div className="meetings">
        {season
          .filter((m) => m !== weekend)
          .map((m) => (
            <article className="meeting" key={m.meeting_key}>
              <p className="eyebrow">
                {dot(rounds.has(m.meeting_key) && `Round ${rounds.get(m.meeting_key)}`, m.country_code)}
              </p>
              <h3>{m.is_cancelled ? <Cancelled>{m.name}</Cancelled> : m.name}</h3>
              {m.circuit_short_name && <p className="muted">{m.circuit_short_name}</p>}
              <ul className="sess">
                {m.sessions.map((s) => (
                  <li key={s.session_key}>
                    <Name year={year} meeting={m} session={s} />
                    <time className="when" dateTime={s.date_start}>
                      {fmtInstant(s.date_start)}
                    </time>
                  </li>
                ))}
              </ul>
            </article>
          ))}
      </div>
    </>
  );
}

export function Season({ year }: { year: number }) {
  const season = useSeason(year);
  const live = useLive();
  const recordings = useRecordings();
  if (!season.data) return <Pending error={season.error} />;
  return (
    <SeasonView
      year={year}
      season={season.data}
      live={live.data ?? null}
      recordings={recordings.data ?? []}
      now={Date.now()}
    />
  );
}

/** `/`: waits for /seasons and /live (an error in /live counts as nothing open), then redirects without history. */
export function Start() {
  const seasons = useSeasons();
  const live = useLive();
  const liveData = live.isError ? null : live.data;
  const path = seasons.data && liveData !== undefined ? startPath(liveData, seasons.data) : undefined;
  useEffect(() => {
    if (path) replace(path);
  }, [path]);
  if (path === null) return <p>No seasons yet.</p>;
  return <Pending error={seasons.error} />;
}
