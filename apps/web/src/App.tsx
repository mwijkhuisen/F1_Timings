import { useEffect } from 'react';
import { useRecordings, useSession } from './lib/api.ts';
import { type Route, replace, titleOf, useHeadingFocus, useRoute, useTitle } from './lib/routes.ts';
import { NewVersion, NotFound } from './ui/ErrorView.tsx';
import { Header } from './views/Header.tsx';
import { Live, Replay, Replays } from './views/Live.tsx';
import { Season, Start } from './views/Season.tsx';
import { Session } from './views/Session.tsx';
import { Status } from './views/Status.tsx';

function Page({ route }: { route: Route | null }) {
  // `/:year/:meeting/:session` has no view of its own: go to the lap table.
  const redirect = route?.id === 'session' && route.view === null ? route : null;
  useEffect(() => {
    if (redirect) replace(`/${redirect.year}/${redirect.meeting}/${redirect.session}/laps`);
  }, [redirect]);

  switch (route?.id) {
    case 'latest':
      return <Start />;
    case 'year':
      return <Season year={route.year} />;
    case 'session':
      return route.view === null ? null : <Session key={route.session} session={route.session} view={route.view} />;
    case 'status':
      return <Status />;
    case 'live':
      return <Live />;
    case 'replays':
      return <Replays />;
    case 'replay':
      return <Replay key={route.recording} recording={route.recording} />;
    default:
      return <NotFound />;
  }
}

// The title per route: the session and replay names come from the queries their pages make anyway (no extra request).
function SessionTitle({ route }: { route: Extract<Route, { id: 'session' }> }) {
  const d = useSession(route.session).data;
  useTitle(titleOf(route, d && { meeting: d.meeting.name, session: d.session.name }));
  return null;
}

function ReplayTitle({ route }: { route: Extract<Route, { id: 'replay' }> }) {
  const r = useRecordings().data?.find((x) => x.id === route.recording);
  useTitle(titleOf(route, r && { meeting: r.meeting_name, session: r.session_name }));
  return null;
}

function PageTitle({ route }: { route: Route | null }) {
  useTitle(titleOf(route));
  return null;
}

const Title = ({ route }: { route: Route | null }) =>
  route?.id === 'session' ? (
    <SessionTitle route={route} />
  ) : route?.id === 'replay' ? (
    <ReplayTitle route={route} />
  ) : (
    <PageTitle route={route} />
  );

export function App() {
  const route = useRoute();
  useHeadingFocus(route);
  return (
    <>
      <Title route={route} />
      <Header route={route} />
      <main>
        <NewVersion />
        <Page route={route} />
      </main>
    </>
  );
}
