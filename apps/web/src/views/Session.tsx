import type { SessionDetail } from '@f1/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useLaps, useSession } from '../lib/api.ts';
import { formatD, Link, parseD, replace, sessionPath, VIEW_LABEL, type View } from '../lib/routes.ts';
import { orderDrivers } from '../lib/session.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { Compare } from './Compare.tsx';
import { DriverPicker } from './DriverPicker.tsx';
import { LapsTab } from './LapsTab.tsx';
import { MiniSectors } from './MiniSectors.tsx';
import { SessionHeadLoader } from './SessionHead.tsx';
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
    // The query (`?d=`) stays.
    if (canonical && canonical !== location.pathname) replace(canonical + location.search);
  }, [canonical]);

  // The driver selection of Compare and Mini-sectors (E1, C4): tab state in pick order, the first the reference.
  // It starts from `?d=`, read once; without a valid one it is the top 2 of the lap-table order and stays out of the
  // URL until the first pick. App's key resets it per session.
  const [fromUrl] = useState(() => new URLSearchParams(location.search).get('d'));
  const [picked, setPicked] = useState<number[] | null>(null);
  const order = useMemo(() => (d && laps.data ? orderDrivers(d, laps.data) : []), [d, laps.data]);
  const chosen = useMemo(() => picked ?? parseD(fromUrl, order), [picked, fromUrl, order]);
  const selected = useMemo(
    () => (chosen === null ? order.slice(0, 2) : chosen.flatMap((n) => order.filter((x) => x.number === n))),
    [chosen, order],
  );
  const numbers = selected.map((x) => x.number);
  const toggle = (n: number) => setPicked(numbers.includes(n) ? numbers.filter((x) => x !== n) : [...numbers, n]);
  const setReference = (n: number) => setPicked([n, ...numbers.filter((x) => x !== n)]);
  const search = chosen !== null && numbers.length > 0 ? `?d=${formatD(numbers)}` : '';
  const picks = view === 'compare' || view === 'minisectors';
  // Written back on Compare and Mini-sectors only, without a history entry; the other tabs keep their own URL.
  useEffect(() => {
    if (picks && chosen !== null) history.replaceState(history.state, '', location.pathname + search);
  }, [picks, chosen, search]);

  if (!d) return <Pending error={detail.error} />;
  return (
    <>
      <SessionHeadLoader detail={d} view={view} />
      <nav className="tabs">
        {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
          <Link
            key={v}
            to={pathOf(d, v) + (v === 'compare' || v === 'minisectors' ? search : '')}
            aria-current={v === view ? 'page' : undefined}
          >
            {VIEW_LABEL[v]}
          </Link>
        ))}
      </nav>
      {picks && laps.data && (
        <DriverPicker drivers={order} selected={numbers} onToggle={toggle} showReference={view === 'compare'} />
      )}
      {!laps.data ? (
        <Pending error={laps.error} />
      ) : view === 'laps' ? (
        <LapsTab session={session} detail={d} laps={laps.data} />
      ) : view === 'compare' ? (
        <Compare session={session} detail={d} drivers={selected} laps={laps.data} onReference={setReference} />
      ) : view === 'minisectors' ? (
        <MiniSectors sessionType={d.session.type} laps={laps.data} drivers={selected} />
      ) : (
        <StintsTab session={session} detail={d} laps={laps.data} />
      )}
    </>
  );
}
