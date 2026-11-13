import type { Live as LiveData, Recordings, SessionDetail } from '@f1/contracts';
import { useState } from 'react';
import { useLive, useRecordings, useSession, useStatus } from '../lib/api.ts';
import { Link, sessionPath } from '../lib/routes.ts';
import { fmtInstant } from '../lib/time.ts';
import { NotFound, Pending } from '../ui/ErrorView.tsx';
import { Player, type PlayerRecording } from './Player.tsx';
import { RecorderWarnings } from './Status.tsx';

// `/live`, `/replay` and `/replay/:recording` (A§13): the player on a recording, with the session from the API for the
// lap table, under a head with the meeting, the session and, once the session has loaded, a link to its pages (#100).

type Names = { meeting_name: string | null; session_name: string | null };

/** The player's head (#100, D2): the h1 as the session head's, and one link to the session's results. */
export function PlayerHead({ names, detail: d }: { names: Names; detail: SessionDetail | undefined }) {
  return (
    <div className="head">
      <h1 tabIndex={-1}>
        {names.meeting_name ?? '—'} <span className="kind">{names.session_name ?? '—'}</span>
      </h1>
      {d && (
        <p className="muted">
          <Link
            to={sessionPath(
              d.meeting.year,
              { key: d.session.meeting_key, name: d.meeting.name },
              { key: d.session.session_key, name: d.session.name, type: d.session.type },
              'laps',
            )}
          >
            Results: laps, compare, stints
          </Link>
        </p>
      )}
    </div>
  );
}

function Watch({
  names,
  recording,
  sessionKey,
  start,
  keepT = false,
}: {
  names: Names;
  recording: PlayerRecording;
  sessionKey: number;
  start: number | 'live';
  /** Replay only: T and the tab live in the URL (`?t=`, `?tab=`). */
  keepT?: boolean;
}) {
  const session = useSession(sessionKey);
  return (
    <>
      <PlayerHead names={names} detail={session.data} />
      <Player
        key={recording.id}
        recording={recording}
        sessionKey={sessionKey}
        start={start}
        detail={session.data}
        detailError={session.error}
        keepT={keepT}
      />
    </>
  );
}

const titleOf = (r: Names) => `${r.meeting_name ?? '—'} · ${r.session_name ?? '—'}`;

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
  const status = useStatus(60_000);
  // The recording the player follows: it stays (with its new `ended_at`) while `/live` names it, so a delayed viewer
  // sees the end, and the player's stream is not closed by the refetch that marks it ended.
  const [watched, setWatched] = useState<number>();
  const open = live.data?.recording?.ended_at === null ? live.data.recording.id : undefined;
  if (open !== undefined && open !== watched) setWatched(open); // derived state, set during render
  if (!live.data) return <Pending error={live.error} />;
  const { session, recording } = live.data;
  return (
    <>
      {status.data && <RecorderWarnings recorder={status.data.recorder} />}
      {session && recording && (recording.ended_at === null || recording.id === watched) ? (
        <Watch names={session} recording={recording} sessionKey={session.session_key} start="live" />
      ) : (
        <>
          <h1 tabIndex={-1}>Live</h1>
          <Next live={live.data} />
        </>
      )}
      <p>
        <Link to="/replay">All replays</Link>
      </p>
    </>
  );
}

/** `/replay`: every recording, newest first. */
export function Replays() {
  const recordings = useRecordings();
  return (
    <>
      <h1 tabIndex={-1}>Replays</h1>
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
  return <Watch names={r} recording={r} sessionKey={r.session_key} start={start} keepT />;
}
