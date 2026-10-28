import type { SessionDetail } from '@f1/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useLaps, useSession } from '../lib/api.ts';
import { Link, replace, sessionPath, type View } from '../lib/routes.ts';
import { orderDrivers } from '../lib/session.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { Compare } from './Compare.tsx';
import { DriverPicker } from './DriverPicker.tsx';
import { LapTable } from './LapTable.tsx';
import { MiniSectors } from './MiniSectors.tsx';
import { StintsTab } from './Stints.tsx';

const pathOf = (d: SessionDetail, view: View) =>
  sessionPath(
    d.meeting.year,
    { key: d.session.meeting_key, name: d.meeting.name },
    { key: d.session.session_key, name: d.session.name },
    view,
  );

// One session: its header, the tabs Laps | Compare | Mini-sectors | Stints, and the view (D1, D11).
export function Session({ session, view }: { session: number; view: View }) {
  const detail = useSession(session);
  const laps = useLaps(session);
  const d = detail.data;
  // A wrong or missing name, year or meeting key becomes the canonical URL (D3).
  const canonical = d && pathOf(d, view);
  useEffect(() => {
    if (canonical && canonical !== location.pathname) replace(canonical);
  }, [canonical]);

  // The driver selection of Compare and Mini-sectors (E1): tab state in pick order, not in the URL.
  // Until the first pick it is the top 2 of the lap-table order; App's key resets it per session.
  const [picked, setPicked] = useState<number[] | null>(null);
  const order = useMemo(() => (d && laps.data ? orderDrivers(d, laps.data) : []), [d, laps.data]);
  const selected = useMemo(
    () => (picked === null ? order.slice(0, 2) : picked.flatMap((n) => order.filter((x) => x.number === n))),
    [picked, order],
  );
  const numbers = selected.map((x) => x.number);
  const toggle = (n: number) => setPicked(numbers.includes(n) ? numbers.filter((x) => x !== n) : [...numbers, n]);

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
        {tab('compare', 'Compare')}
        {tab('minisectors', 'Mini-sectors')}
        {tab('stints', 'Stints')}
      </nav>
      {(view === 'compare' || view === 'minisectors') && laps.data && (
        <DriverPicker drivers={order} selected={numbers} onToggle={toggle} />
      )}
      {!laps.data ? (
        <Pending error={laps.error} />
      ) : view === 'laps' ? (
        <LapTable detail={d} laps={laps.data} />
      ) : view === 'compare' ? (
        <Compare drivers={selected} laps={laps.data} />
      ) : view === 'minisectors' ? (
        <MiniSectors sessionType={d.session.type} laps={laps.data} drivers={selected} />
      ) : (
        <StintsTab session={session} detail={d} laps={laps.data} />
      )}
    </>
  );
}
