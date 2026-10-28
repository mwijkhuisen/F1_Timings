import { useEffect } from 'react';
import { useSeasons } from './lib/api.ts';
import { Link, navigate, type Route, replace, useRoute } from './lib/routes.ts';
import { NotFound } from './ui/ErrorView.tsx';
import { Latest, Picker } from './views/Picker.tsx';
import { Session } from './views/Session.tsx';
import { Status } from './views/Status.tsx';

const yearOf = (route: Route | null): number | null =>
  route?.id === 'year' || route?.id === 'session' ? route.year : null;

function Header({ year }: { year: number | null }) {
  const seasons = useSeasons();
  return (
    <header>
      <select
        aria-label="Season"
        value={year ?? ''}
        onChange={(e) => e.target.value !== '' && navigate(`/${e.target.value}`)}
      >
        {year === null && <option value="">Season</option>}
        {seasons.data?.map((s) => (
          <option key={s.year} value={s.year}>
            {s.year}
          </option>
        ))}
      </select>
      <Link to="/status">Status</Link>
    </header>
  );
}

function Page({ route }: { route: Route | null }) {
  // `/:year/:meeting/:session` has no view of its own: go to the lap table.
  const redirect = route?.id === 'session' && route.view === null ? route : null;
  useEffect(() => {
    if (redirect) replace(`/${redirect.year}/${redirect.meeting}/${redirect.session}/laps`);
  }, [redirect]);

  switch (route?.id) {
    case 'latest':
      return <Latest />;
    case 'year':
      return <Picker year={route.year} />;
    case 'session':
      return route.view === null ? null : <Session session={route.session} view={route.view} />;
    case 'status':
      return <Status />;
    default:
      return <NotFound />;
  }
}

export function App() {
  const route = useRoute();
  return (
    <>
      <Header year={yearOf(route)} />
      <main>
        <Page route={route} />
      </main>
    </>
  );
}
