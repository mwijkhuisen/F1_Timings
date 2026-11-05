import { useLive, useRecordings, useSession } from '../lib/api.ts';
import { NotFound, Pending } from '../ui/ErrorView.tsx';
import { Player, type PlayerRecording } from './Player.tsx';

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
      <Player key={recording.id} recording={recording} start={start} detail={session.data} />
    </>
  );
}

const titleOf = (r: { meeting_name: string | null; session_name: string | null }) =>
  `${r.meeting_name ?? '—'} · ${r.session_name ?? '—'}`;

export function Live() {
  const live = useLive();
  if (!live.data) return <Pending error={live.error} />;
  const { session, recording } = live.data;
  if (session && recording && recording.ended_at === null)
    return <Watch title={titleOf(session)} recording={recording} sessionKey={session.session_key} start="live" />;
  return <p>Nothing is live right now.</p>;
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
