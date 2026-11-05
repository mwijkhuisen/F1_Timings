import type { Live as LiveData, Recordings } from '@f1/contracts';
import { useLive, useRecordings, useSession, useStatus } from '../lib/api.ts';
import { Link } from '../lib/routes.ts';
import { fmtInstant } from '../lib/time.ts';
import { NotFound, Pending } from '../ui/ErrorView.tsx';
import { Player, type PlayerRecording } from './Player.tsx';
import { RecorderWarnings } from './Status.tsx';

// `/live` and `/replay/:recording` (A§13): the player on a recording, with the session from the API for the lap table.

function Watch({
  title,
  recording,
  sessionKey,
  start,
}: {
  title: string;
  recording: PlayerRecording;
  sessionKey: number;
  start: number | 'live';
}) {
  const session = useSession(sessionKey);
  return (
    <>
      <h1>{title}</h1>
      <Player key={recording.id} recording={recording} sessionKey={sessionKey} start={start} detail={session.data} />
    </>
  );
}

const titleOf = (r: { meeting_name: string | null; session_name: string | null }) =>
  `${r.meeting_name ?? '—'} · ${r.session_name ?? '—'}`;

/** The session /live offers when nothing is open: the next one, with its latest recording to replay. */
export function Next({ live }: { live: LiveData }) {
  const { session, recording } = live;
  if (!session) return <p>No session is scheduled.</p>;
  return (
    <p>
      Next: {titleOf(session)} starts <time dateTime={session.date_start}>{fmtInstant(session.date_start)}</time>
      {recording && (
        <>
          {' · '}
          <Link to={`/replay/${recording.id}`}>Replay</Link>
        </>
      )}
    </p>
  );
}

export function RecordingsList({ recordings }: { recordings: Recordings }) {
  if (recordings.length === 0) return <p className="muted">No recordings yet.</p>;
  return (
    <ul className="sessions">
      {recordings.map((r) => (
        <li key={r.id}>
          <Link to={`/replay/${r.id}`}>{titleOf(r)}</Link>
          <time dateTime={r.started_at}>{fmtInstant(r.started_at)}</time>
          <span className="badge">{r.ended_at === null ? 'recording' : r.complete ? 'complete' : 'incomplete'}</span>
        </li>
      ))}
    </ul>
  );
}

export function Live() {
  const live = useLive();
  const recordings = useRecordings();
  const status = useStatus(60_000);
  if (!live.data) return <Pending error={live.error} />;
  const { session, recording } = live.data;
  return (
    <>
      {status.data && <RecorderWarnings recorder={status.data.recorder} />}
      {session && recording && recording.ended_at === null ? (
        <Watch title={titleOf(session)} recording={recording} sessionKey={session.session_key} start="live" />
      ) : (
        <>
          <h1>Live</h1>
          <Next live={live.data} />
        </>
      )}
      <h2>Recordings</h2>
      {recordings.data ? <RecordingsList recordings={recordings.data} /> : <Pending error={recordings.error} />}
    </>
  );
}

export function Replay({ recording: id }: { recording: number }) {
  const recordings = useRecordings();
  if (!recordings.data) return <Pending error={recordings.error} />;
  const r = recordings.data.find((x) => x.id === id);
  if (!r) return <NotFound />;
  // The session's scheduled start, clamped into what was recorded.
  const end = r.ended_at === null ? Date.now() : Date.parse(r.ended_at);
  const start = Math.min(end, Math.max(Date.parse(r.started_at), Date.parse(r.date_start)));
  return <Watch title={titleOf(r)} recording={r} sessionKey={r.session_key} start={start} />;
}
