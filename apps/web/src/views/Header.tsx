import type { Season, Seasons } from '@f1/contracts';
import { useQuery } from '@tanstack/react-query';
import { seasonQuery, useSeasons } from '../lib/api.ts';
import { Link, type Route, sessionPath } from '../lib/routes.ts';
import { meetingTarget, neighbours, type Slot } from '../lib/season.ts';
import { Menu } from '../ui/Menu.tsx';

// The header (A§13): the session switcher (‹ year / meeting / session ›) and Live · Replays · Status. It reads
// /seasons and the route's season only, never a session.

const yearOf = (route: Route | null): number | null =>
  route?.id === 'year' || route?.id === 'session' ? route.year : null;

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
}: {
  route: Route | null;
  seasons: Seasons | undefined;
  season: Season | undefined;
}) {
  const year = yearOf(route);
  const at = route?.id === 'session' ? route : null;
  const view = at?.view ?? 'laps';
  const meeting = at && season?.find((m) => m.sessions.some((s) => s.session_key === at.session));
  const current = meeting?.sessions.find((s) => s.session_key === at?.session);
  const near = at && season ? neighbours(season, at.session) : { prev: null, next: null };
  const path = ({ meeting: m, session: s }: Slot) =>
    sessionPath(year ?? 0, { key: m.meeting_key, name: m.name }, { key: s.session_key, name: s.name }, view);
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
                      <s>{short(m.name)}</s>
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
                    <s>{s.name}</s>
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
          Live
        </Link>
        <Link to="/replay" aria-current={page('replays')}>
          Replays
        </Link>
        <Link to="/status" aria-current={page('status')}>
          Status
        </Link>
      </nav>
    </header>
  );
}

export function Header({ route }: { route: Route | null }) {
  const seasons = useSeasons();
  const year = yearOf(route);
  const season = useQuery({ ...seasonQuery(year ?? 0), enabled: year !== null });
  return <HeaderView route={route} seasons={seasons.data} season={year === null ? undefined : season.data} />;
}
