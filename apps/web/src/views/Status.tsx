import type { Status as StatusData } from '@f1/contracts';
import { useStatus } from '../lib/api.ts';
import { Link } from '../lib/routes.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { Scroll } from '../ui/Scroll.tsx';

// The status page (D12, #105), polled every minute: session counts per state, the ingest daemon (last sync, live
// window, last report), every session whose last fetch failed, the rain grids the same way, the races whose race
// control has a wording the bands do not know, and the live recorder. A session name links to its laps, a rain grid to
// its weather.

const WARNINGS = {
  token_expiring: 'The F1 TV token expires within 24 h and a session is due.',
  login_failed: 'The F1 TV login failed. Recording continues without a token; paste a token if it keeps failing.',
  disk_low: 'Less than 5 GB free for recordings.',
};

const at = (iso: string | null) => (iso === null ? '—' : fmtInstant(iso));

/** The recorder's warning and its stale notice (also shown on /live). */
export function RecorderWarnings({ recorder: r }: { recorder: StatusData['recorder'] }) {
  return (
    <>
      {r?.warning && <p role="alert">{WARNINGS[r.warning]}</p>}
      {r?.stale && <p role="alert">The recorder has not reported for over 5 minutes.</p>}
    </>
  );
}

function Recorder({ recorder: r }: { recorder: StatusData['recorder'] }) {
  if (r === null) return <p>The recorder has not reported yet.</p>;
  const values: [string, string][] = [
    ['state', r.state],
    ['session', r.session_key !== null ? `${r.meeting_name ?? '—'} ${r.session_name ?? ''}`.trim() : '—'],
    ['token expires', at(r.token_expires_at)],
    ['last error', r.last_error ?? 'None'],
    ['last report', at(r.updated_at)],
  ];
  return (
    <>
      <RecorderWarnings recorder={r} />
      <Counts values={values} />
    </>
  );
}

type Failed = StatusData['failed'];

/** Sessions or rain grids whose last attempt failed; the session name links to `view` of that session. */
function FailedTable({ rows, view, label }: { rows: Failed; view: 'laps' | 'weather'; label: string }) {
  if (rows.length === 0) return <p>None.</p>;
  return (
    <Scroll label={label}>
      <table className="list" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col">Meeting</th>
            <th scope="col">Session</th>
            <th scope="col">Fails</th>
            <th scope="col">Last error</th>
            <th scope="col">Next fetch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.session_key}>
              <td>{f.year}</td>
              <td>{f.meeting_name}</td>
              <td>
                <Link to={`/${f.year}/0/${f.session_key}/${view}`}>{f.session_name}</Link>
              </td>
              <td>{f.fail_count}</td>
              <td>{f.last_error}</td>
              <td>{f.next_fetch_at === null ? '—' : fmtInstant(f.next_fetch_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function Counts({ values }: { values: [string, string | number][] }) {
  return (
    <dl className="counts">
      {values.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Daemon({ ingest: i }: { ingest: StatusData['ingest'] }) {
  if (i === null) return <p>The ingest daemon has not reported yet.</p>;
  return (
    <>
      {i.stale && <p role="alert">The ingest daemon has not reported for over 5 minutes.</p>}
      <Counts
        values={[
          ['last sync', at(i.last_sync_at)],
          ['live window', i.live_wait ? 'yes' : 'no'],
          ['last report', at(i.last_tick_at)],
        ]}
      />
    </>
  );
}

export function StatusPanel({ status }: { status: StatusData }) {
  return (
    <>
      <h1 tabIndex={-1}>Status</h1>
      <h2>Ingest</h2>
      <Daemon ingest={status.ingest} />
      <Counts values={[...Object.entries(status.states), ['cancelled', status.cancelled]]} />
      <h3>Last fetch failed</h3>
      <FailedTable rows={status.failed} view="laps" label="Last fetch failed" />
      <h2>Rain</h2>
      <Counts values={Object.entries(status.rain.states)} />
      <h3>Last fetch failed</h3>
      <FailedTable rows={status.rain.failed} view="weather" label="Rain grids, last fetch failed" />
      <h2>Race control in an unknown form</h2>
      {status.rc_unmatched.length === 0 ? (
        <p>None.</p>
      ) : (
        <Scroll label="Race control in an unknown form">
          <table className="list" aria-label="Race control in an unknown form">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Meeting</th>
                <th scope="col">Session</th>
                <th scope="col">Rows</th>
              </tr>
            </thead>
            <tbody>
              {status.rc_unmatched.map((r) => (
                <tr key={r.session_key}>
                  <td>{r.year}</td>
                  <td>{r.meeting_name}</td>
                  <td>
                    <Link to={`/${r.year}/0/${r.session_key}/laps`}>{r.session_name}</Link>
                  </td>
                  <td>{r.rows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      <h2>Recorder</h2>
      <Recorder recorder={status.recorder} />
    </>
  );
}

export function Status() {
  const status = useStatus(60_000);
  if (!status.data) return <Pending error={status.error} />;
  return <StatusPanel status={status.data} />;
}
