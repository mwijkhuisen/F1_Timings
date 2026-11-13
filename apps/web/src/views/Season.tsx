import type { Live, Recordings, Season as SeasonData } from '@f1/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLive, useRecordings, useSeason, useSeasons } from '../lib/api.ts';
import { Link, replace, sessionPath } from '../lib/routes.ts';
import { type Saved, savedSessions } from '../lib/saved.ts';
import {
  type Meeting,
  nextSession,
  roundNumbers,
  type SeasonSession,
  type SessionState,
  sessionState,
  started,
  startPath,
  thisWeekend,
} from '../lib/season.ts';
import { fmtCountdown, fmtInstant, fmtTrack } from '../lib/time.ts';
import { Cancelled } from '../ui/Cancelled.tsx';
import { Pending } from '../ui/ErrorView.tsx';

// `/:year` (A§13): this weekend first, then the other meetings, every session with its state in words. A recorded
// session's name is its replay link, with Laps beside it. Never a result.
// `/` goes to /live while a recording is open, else to the newest season with a session (owner D1).

const dot = (...parts: (string | number | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/**
 * The session's name: a link to its replay with "Laps" beside it once a recording has ended, else a link to its lap
 * table; struck through and unlinked when cancelled (the state beside it says so).
 */
function Name({
  year,
  meeting: m,
  session: s,
  state,
}: {
  year: number;
  meeting: Meeting;
  session: SeasonSession;
  state: SessionState;
}) {
  if (state.kind === 'cancelled') return <s>{s.name}</s>;
  const laps = sessionPath(year, { key: m.meeting_key, name: m.name }, { key: s.session_key, name: s.name }, 'laps');
  if (state.kind !== 'recorded') return <Link to={laps}>{s.name}</Link>;
  return (
    <span className="name">
      <Link to={`/replay/${state.recording.id}`}>{s.name}</Link>
      <span className="laps">
        {' · '}
        <Link to={laps}>Laps</Link>
      </span>
    </span>
  );
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
  </span>
);

/** The state of a session of `m`: every session of a cancelled meeting is cancelled. */
const stateOf = (
  m: Meeting,
  s: SeasonSession,
  recordings: Recordings,
  live: Live | null,
  now: number,
  nextKey: number | null,
): SessionState => (m.is_cancelled ? { kind: 'cancelled' } : sessionState(s, recordings, live, now, nextKey));

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
  const tracked = weekend?.sessions.some((s) => fmtTrack(s.date_start, weekend.gmt_offset) !== null);
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
              {dot(weekend.circuit_short_name, `Amsterdam time${tracked ? ', track time beside it' : ''}`)}
            </p>
            <ul className="sess full">
              {weekend.sessions.map((s) => {
                const track = fmtTrack(s.date_start, weekend.gmt_offset);
                const state = stateOf(weekend, s, recordings, live, now, nextKey);
                return (
                  <li key={s.session_key}>
                    <Name year={year} meeting={weekend} session={s} state={state} />
                    <span className="when">
                      <time dateTime={s.date_start}>{fmtInstant(s.date_start)}</time>
                      {track && ` · ${track} at the track`}
                    </span>
                    <State state={state} />
                  </li>
                );
              })}
            </ul>
          </div>
          {upNext && (
            <div className="upnext">
              <p className="eyebrow">Up next</p>
              <p className="count">{fmtCountdown(Date.parse(upNext.date_start) - now)}</p>
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
                {m.sessions.map((s) => {
                  const state = stateOf(m, s, recordings, live, now, nextKey);
                  return (
                    <li key={s.session_key}>
                      <Name year={year} meeting={m} session={s} state={state} />
                      <time className="when" dateTime={s.date_start}>
                        {fmtInstant(s.date_start)}
                      </time>
                      <State state={state} />
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
      </div>
    </>
  );
}

const WEEKEND_POLL_MS = 5 * 60_000;

/** The weekend has started (in progress or in its grace day): the page then refetches. `/live` is not needed. */
const polling = (data: SeasonData | undefined, now: number): boolean => {
  const weekend = data && thisWeekend(data, now, null);
  return !!weekend && started(weekend, now);
};

/** Owns the clock: `now` moves every minute, so the states and the countdown move together. */
export function Season({ year }: { year: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const season = useSeason(year, (data) => (polling(data, Date.now()) ? WEEKEND_POLL_MS : false));
  const live = useLive();
  const recordings = useRecordings(polling(season.data, now) && WEEKEND_POLL_MS);
  if (!season.data) return <Pending error={season.error} />;
  return (
    <SeasonView
      year={year}
      season={season.data}
      live={live.data ?? null}
      recordings={recordings.data ?? []}
      now={now}
    />
  );
}

/** The final sessions this device keeps (#121, D4), newest first, each opening on its laps: the way in offline. */
export function SavedList({ saved }: { saved: readonly Saved[] }) {
  if (saved.length === 0) return null;
  return (
    <section aria-label="Saved on this device">
      <h2 className="eyebrow sect">Saved on this device</h2>
      <ul className="sess">
        {saved.map((s) => (
          <li key={s.key}>
            <Link to={s.path}>{s.name}</Link>
            <time className="when" dateTime={s.date_start}>
              {fmtInstant(s.date_start)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/`: waits for /seasons and /live (an error in /live counts as nothing open), then redirects without history.
 * When /seasons fails, the saved sessions show under the error.
 */
export function Start() {
  const seasons = useSeasons();
  const live = useLive();
  const saved = useQuery({ queryKey: ['saved'], queryFn: savedSessions, enabled: seasons.isError });
  const liveData = live.isError ? null : live.data;
  const path = seasons.data && liveData !== undefined ? startPath(liveData, seasons.data) : undefined;
  useEffect(() => {
    if (path) replace(path);
  }, [path]);
  if (path === null) return <p>No seasons yet.</p>;
  return (
    <>
      <Pending error={seasons.error} />
      <SavedList saved={saved.data ?? []} />
    </>
  );
}
