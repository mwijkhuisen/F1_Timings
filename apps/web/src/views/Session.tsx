import type { SessionDetail } from '@f1/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useLaps, useLive, useRefetchOnFetch, useSession } from '../lib/api.ts';
import { formatD, Link, parseD, replace, sessionPath, VIEW_LABEL, type View } from '../lib/routes.ts';
import { orderDrivers } from '../lib/session.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { NoData } from '../ui/NoData.tsx';
import { Compare } from './Compare.tsx';
import { DriverPicker } from './DriverPicker.tsx';
import { LapsTab } from './LapsTab.tsx';
import { MiniSectors } from './MiniSectors.tsx';
import { Order } from './Order.tsx';
import { SessionHeadLoader } from './SessionHead.tsx';
import { StintsTab } from './Stints.tsx';
import { WeatherTab } from './Weather.tsx';

const pathOf = (d: SessionDetail, view: View) =>
  sessionPath(
    d.meeting.year,
    { key: d.session.meeting_key, name: d.meeting.name },
    { key: d.session.session_key, name: d.session.name },
    view,
  );

// The Grid row's positions (#115): results[].grid, integers from 1 only (Jolpica's 0 is a pit-lane start, no place).
const gridOf = (d: SessionDetail) =>
  new Map(d.results.flatMap((r) => (r.grid !== null && r.grid >= 1 ? [[r.driver_number, r.grid] as const] : [])));

// One session: its header, the tabs Laps | Order (races and sprints) | Compare | Mini-sectors | Stints | Weather, and the view (D1, D11).
export function Session({ session, view }: { session: number; view: View }) {
  const detail = useSession(session);
  const d = detail.data;
  const laps = useLaps(session);
  // Only the session polls; each new fetch of it refetches the laps, stints and weather (#99).
  useRefetchOnFetch(session, d?.session.fetch_count);
  // The clock of the reasons: the session query's last answer, so each poll renders them anew.
  const now = detail.dataUpdatedAt;
  // A live session is `scheduled` or `due` (A§8), so `/live` is asked only then; a cached answer counts only then too.
  const canBeLive =
    d !== undefined &&
    !d.session.is_cancelled &&
    (d.session.ingest_state === 'scheduled' || d.session.ingest_state === 'due');
  const liveQuery = useLive(canBeLive);
  const live = (canBeLive && liveQuery.data) || null;
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
    if (picks && chosen !== null) history.replaceState(history.state, '', location.pathname + search + location.hash);
  }, [picks, chosen, search]);

  if (!d) return <Pending error={detail.error} />;
  const race = d.session.type === 'Race';
  return (
    <>
      <SessionHeadLoader detail={d} view={view} live={live} />
      <nav className="tabs">
        {(Object.keys(VIEW_LABEL) as View[])
          .filter((v) => v !== 'order' || race)
          .map((v) => (
            <Link
              key={v}
              to={pathOf(d, v) + (v === 'compare' || v === 'minisectors' ? search : '')}
              aria-current={v === view ? 'page' : undefined}
            >
              {VIEW_LABEL[v]}
            </Link>
          ))}
      </nav>
      {/* No laps, no picker: the reason below instead of an empty pick (#99). */}
      {picks && laps.data && laps.data.length > 0 && (
        <DriverPicker drivers={order} selected={numbers} onToggle={toggle} showReference={view === 'compare'} />
      )}
      {view === 'weather' ? (
        // The weather needs no laps; a race's laps add the leader's lap once they arrive.
        <WeatherTab session={session} detail={d} laps={laps.data ?? null} live={live} now={now} />
      ) : !laps.data ? (
        <Pending error={laps.error} />
      ) : laps.data.length === 0 ? (
        <NoData session={d.session} live={live} what={view === 'stints' ? 'stints' : 'laps'} now={now} />
      ) : view === 'laps' ? (
        <LapsTab session={session} detail={d} laps={laps.data} />
      ) : view === 'order' ? (
        race ? (
          <Order drivers={order} laps={laps.data} grid={gridOf(d)} noGrid="Grid not in the OpenF1 data" />
        ) : (
          <p className="muted">The running order is for races and sprints.</p>
        )
      ) : view === 'compare' ? (
        <Compare session={session} detail={d} drivers={selected} laps={laps.data} onReference={setReference} />
      ) : view === 'minisectors' ? (
        <MiniSectors sessionType={d.session.type} source={d.session.source} laps={laps.data} drivers={selected} />
      ) : (
        <StintsTab session={session} detail={d} laps={laps.data} live={live} now={now} />
      )}
    </>
  );
}
