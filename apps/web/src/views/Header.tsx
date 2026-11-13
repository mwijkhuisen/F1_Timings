import type { Live, Recordings, Season, Seasons } from '@f1/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { seasonQuery, useLive, useRecordings, useSeasons, useStatus } from '../lib/api.ts';
import { Link, type Route, sessionPath } from '../lib/routes.ts';
import { meetingTarget, neighbours, type Slot } from '../lib/season.ts';
import { currentTheme, setTheme, subscribeTheme, type Theme } from '../lib/theme.ts';
import { Cancelled } from '../ui/Cancelled.tsx';
import { Menu } from '../ui/Menu.tsx';
import { recorderWarning } from './Status.tsx';

// The header (A§13): the session switcher (‹ year / meeting / session ›), Live · Replays · Status and the moon
// (the dark theme on or off). It reads /seasons, the route's season, /live (every 30 s) and /status (every 60 s), and
// on the player routes /recordings, for the player's session in the switcher (#100); never a session itself.

const yearOf = (route: Route | null): number | null =>
  route?.id === 'year' || route?.id === 'session' ? route.year : null;

/** The player's session (#100): the replay's recording, or the one `/live` names; null on any other route. */
export function playerSession(
  route: Route | null,
  live: Live | undefined,
  recordings: Recordings | undefined,
): { year: number; session: number } | null {
  const id = route?.id === 'replay' ? route.recording : route?.id === 'live' ? live?.recording?.id : undefined;
  const row = id === undefined ? undefined : recordings?.find((r) => r.id === id);
  return row ? { year: row.year, session: row.session_key } : null;
}

const short = (name: string | null) => name?.replace(/ Grand Prix$/i, '') ?? '—';

const Sep = () => (
  <span className="sep" aria-hidden="true">
    /
  </span>
);

export function HeaderView({
  route,
  seasons,
  season,
  theme,
  onTheme,
  player = null,
  live = false,
  warning = null,
}: {
  route: Route | null;
  seasons: Seasons | undefined;
  season: Season | undefined;
  theme: Theme;
  onTheme: (t: Theme) => void;
  /** The player's session on `/live` and `/replay/:id` (`playerSession`). */
  player?: { year: number; session: number } | null;
  /** `/live` names an open recording: the Live link is the red pill (D1). */
  live?: boolean;
  /** The recorder's warning sentence (`recorderWarning`): the Status link gets the amber pill (D1). */
  warning?: string | null;
}) {
  const year = yearOf(route) ?? player?.year ?? null;
  const at = route?.id === 'session' ? route : player && { session: player.session, view: null };
  const view = at?.view ?? 'laps';
  const meeting = at && season?.find((m) => m.sessions.some((s) => s.session_key === at.session));
  const current = meeting?.sessions.find((s) => s.session_key === at?.session);
  const near = at && season ? neighbours(season, at.session) : { prev: null, next: null };
  const path = ({ meeting: m, session: s }: Slot) =>
    sessionPath(
      year ?? 0,
      { key: m.meeting_key, name: m.name },
      { key: s.session_key, name: s.name, type: s.type },
      view,
    );
  const step = (slot: Slot | null, label: string, glyph: string) =>
    slot && (
      <Link className="step" to={path(slot)} aria-label={label} title={`${slot.meeting.name} · ${slot.session.name}`}>
        {glyph}
      </Link>
    );
  const page = (id: Route['id']) => (route?.id === id ? 'page' : undefined);
  return (
    <header>
      <nav aria-label="Session switcher" className="crumbs">
        {step(near.prev, 'Previous session', '‹')}
        <Menu id="menu-season" label={year ?? 'Season'} name={year === null ? undefined : `Season ${year}`}>
          {seasons?.map((s) => (
            <li key={s.year}>
              <Link to={`/${s.year}`} aria-current={s.year === year ? 'page' : undefined}>
                {s.year}
              </Link>
            </li>
          ))}
        </Menu>
        {meeting && current && season && (
          <>
            <Sep />
            <Menu id="menu-meeting" label={short(meeting.name)} name={`Meeting ${short(meeting.name)}`}>
              {season.map((m) => {
                const target = meetingTarget(m, current.name);
                return (
                  <li key={m.meeting_key}>
                    {target ? (
                      <Link
                        to={path({ meeting: m, session: target })}
                        aria-current={m === meeting ? 'page' : undefined}
                      >
                        {short(m.name)}
                      </Link>
                    ) : (
                      <Cancelled>{short(m.name)}</Cancelled>
                    )}
                  </li>
                );
              })}
            </Menu>
            <Sep />
            <Menu id="menu-session" label={current.name ?? '—'} name={`Session ${current.name ?? '—'}`}>
              {meeting.sessions.map((s) => (
                <li key={s.session_key}>
                  {s.is_cancelled ? (
                    <Cancelled>{s.name}</Cancelled>
                  ) : (
                    <Link to={path({ meeting, session: s })} aria-current={s === current ? 'page' : undefined}>
                      {s.name}
                    </Link>
                  )}
                </li>
              ))}
            </Menu>
          </>
        )}
        {step(near.next, 'Next session', '›')}
      </nav>
      <nav className="links" aria-label="Pages">
        <Link to="/live" aria-current={page('live')}>
          {live ? (
            <span className="pill live">
              <span className="dot" aria-hidden="true" />
              Live<span className="vh">, recording now</span>
            </span>
          ) : (
            'Live'
          )}
        </Link>
        <Link to="/replay" aria-current={page('replays')}>
          Replays
        </Link>
        <Link to="/status" aria-current={page('status')} title={warning ?? undefined}>
          Status
          {warning && (
            <>
              {' '}
              <span className="pill warn">warning</span>
            </>
          )}
        </Link>
      </nav>
      <button
        type="button"
        className="theme"
        aria-pressed={theme === 'dark'}
        aria-label="Dark theme"
        title="Dark theme"
        onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      </button>
    </header>
  );
}

export function Header({ route }: { route: Route | null }) {
  const seasons = useSeasons();
  // Their errors are ignored: no pill, no switcher.
  const live = useLive();
  const status = useStatus(60_000);
  const recordings = useRecordings(false, route?.id === 'replay' || route?.id === 'live');
  const player = playerSession(route, live.data, recordings.data);
  // A recording that started after /recordings was read (a new session's recorder): ask again, once per id.
  const id = live.data?.recording?.id;
  const want =
    route?.id === 'live' && id !== undefined && recordings.data && !recordings.data.some((r) => r.id === id)
      ? id
      : undefined;
  const { refetch } = recordings;
  useEffect(() => {
    if (want !== undefined) void refetch();
  }, [want, refetch]);
  const year = yearOf(route) ?? player?.year ?? null;
  const season = useQuery({ ...seasonQuery(year ?? 0), enabled: year !== null });
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  return (
    <HeaderView
      route={route}
      seasons={seasons.data}
      season={year === null ? undefined : season.data}
      theme={theme}
      onTheme={setTheme}
      player={player}
      live={live.data?.recording?.ended_at === null}
      warning={recorderWarning(status.data?.recorder ?? null)}
    />
  );
}
