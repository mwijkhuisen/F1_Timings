import type { Status as StatusData } from '@f1/contracts';
import { useStatus } from '../lib/api.ts';
import { fmtInstant } from '../lib/time.ts';
import { Pending } from '../ui/ErrorView.tsx';

// The ingest status (D12): session counts per state, and every session whose last fetch failed.

export function StatusPanel({ status }: { status: StatusData }) {
  const counts: [string, number][] = [...Object.entries(status.states), ['cancelled', status.cancelled]];
  return (
    <>
      <h1>Ingest status</h1>
      <dl className="counts">
        {counts.map(([state, n]) => (
          <div key={state}>
            <dt>{state}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
      <h2>Last fetch failed</h2>
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
    </>
  );
}

export function Status() {
  const status = useStatus();
  if (!status.data) return <Pending error={status.error} />;
  return <StatusPanel status={status.data} />;
}
