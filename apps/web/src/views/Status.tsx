import type { Status as StatusData } from '@f1/contracts';
import { useStatus } from '../lib/api.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';

// The status page (D12): session counts per state, every session whose last fetch failed, and the live recorder.

const WARNINGS = {
  token_expiring: 'The F1 TV token expires within 24 h and a session is due.',
  login_failed: 'The F1 TV login failed. Recording continues without a token; paste a token if it keeps failing.',
  disk_low: 'Less than 5 GB free for recordings.',
};

const at = (iso: string | null) => (iso === null ? '—' : fmtInstant(iso));

function Recorder({ recorder: r }: { recorder: StatusData['recorder'] }) {
  if (r === null) return <p>The recorder has not reported yet.</p>;
  const values: [string, string][] = [
    ['state', r.state],
    ['session', r.state === 'recording' ? `${r.meeting_name ?? '—'} ${r.session_name ?? ''}`.trim() : '—'],
    ['token expires', at(r.token_expires_at)],
    ['last error', r.last_error ?? 'None'],
    ['last report', at(r.updated_at)],
  ];
  return (
    <>
      {r.warning && <p role="alert">{WARNINGS[r.warning]}</p>}
      {r.stale && <p role="alert">The recorder has not reported for over 5 minutes.</p>}
      <dl className="counts">
        {values.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function StatusPanel({ status }: { status: StatusData }) {
  const counts: [string, number][] = [...Object.entries(status.states), ['cancelled', status.cancelled]];
  return (
    <>
      <h1>Status</h1>
      <h2>Ingest</h2>
      <dl className="counts">
        {counts.map(([state, n]) => (
          <div key={state}>
            <dt>{state}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
      <h3>Last fetch failed</h3>
      {status.failed.length === 0 ? (
        <p>None.</p>
      ) : (
        <div className="scroll">
          <table className="list">
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
              {status.failed.map((f) => (
                <tr key={f.session_key}>
                  <td>{f.year}</td>
                  <td>{f.meeting_name}</td>
                  <td>{f.session_name}</td>
                  <td>{f.fail_count}</td>
                  <td>{f.last_error}</td>
                  <td>{f.next_fetch_at === null ? '—' : fmtInstant(f.next_fetch_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Recorder</h2>
      <Recorder recorder={status.recorder} />
    </>
  );
}

export function Status() {
  const status = useStatus();
  if (!status.data) return <Pending error={status.error} />;
  return <StatusPanel status={status.data} />;
}
