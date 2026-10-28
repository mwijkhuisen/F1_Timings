import type { SessionDetail } from '@f1/contracts';
import { useEffect } from 'react';
import { useLaps, useSession } from '../lib/api.ts';
import { Link, replace, sessionPath, type View } from '../lib/routes.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { LapTable } from './LapTable.tsx';
import { StintsTab } from './Stints.tsx';

const pathOf = (d: SessionDetail, view: View) =>
  sessionPath(
    d.meeting.year,
    { key: d.session.meeting_key, name: d.meeting.name },
    { key: d.session.session_key, name: d.session.name },
    view,
  );

// One session: its header, the tabs Laps | Stints, and the view (D1, D11).
export function Session({ session, view }: { session: number; view: View }) {
  const detail = useSession(session);
  const laps = useLaps(session);
  const d = detail.data;
  // A wrong or missing name, year or meeting key becomes the canonical URL (D3).
  const canonical = d && pathOf(d, view);
  useEffect(() => {
    if (canonical && canonical !== location.pathname) replace(canonical);
  }, [canonical]);

  if (!d) return <Pending error={detail.error} />;
  const tab = (v: View, label: string) => (
    <Link to={pathOf(d, v)} aria-current={v === view ? 'page' : undefined}>
      {label}
    </Link>
  );
  return (
    <>
      <h1>
        {d.meeting.name} · {d.session.name}
      </h1>
      <p className="muted">
        {fmtInstant(d.session.date_start)}
        {d.meeting.circuit_short_name && ` · ${d.meeting.circuit_short_name}`}
      </p>
      <nav className="tabs">
        {tab('laps', 'Laps')}
        {tab('stints', 'Stints')}
      </nav>
      {!laps.data ? (
        <Pending error={laps.error} />
      ) : view === 'laps' ? (
        <LapTable detail={d} laps={laps.data} />
      ) : (
        <StintsTab session={session} detail={d} laps={laps.data} />
      )}
    </>
  );
}
