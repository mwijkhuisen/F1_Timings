import type { Live, Recordings, Season, Seasons } from '@f1/contracts';

// The season page's and the header's decisions (A§13), pure: `now` is epoch ms from the caller.

export type Meeting = Season[number];
export type SeasonSession = Meeting['sessions'][number];
export type Slot = { meeting: Meeting; session: SeasonSession };
export type Recording = Recordings[number];

/** A session's state in words on the season page, in precedence order (A§13). */
export type SessionState =
  | { kind: 'cancelled' }
  | { kind: 'live' }
  | { kind: 'recorded'; recording: Recording }
  | { kind: 'ready' }
  | { kind: 'pending' }
  | { kind: 'next' }
  | { kind: 'scheduled' };

const isOpen = (live: Live | null): boolean => live?.recording?.ended_at === null;

/** `/`: `/live` while a recording is open, else the newest season with a session, else null (owner D1). */
export function startPath(live: Live | null, seasons: Seasons): string | null {
  if (isOpen(live)) return '/live';
  const year = seasons.find((s) => s.sessions > 0)?.year;
  return year === undefined ? null : `/${year}`;
}

/** Every session that can be opened (neither it nor its meeting cancelled), by start, then key. */
function slots(season: Season): Slot[] {
  return season
    .flatMap((meeting) =>
      meeting.is_cancelled
        ? []
        : meeting.sessions.filter((s) => !s.is_cancelled).map((session) => ({ meeting, session })),
    )
    .sort(
      (a, b) =>
        Date.parse(a.session.date_start) - Date.parse(b.session.date_start) ||
        a.session.session_key - b.session.session_key,
    );
}

/**
 * The meeting in progress, else the next one to start, else null; spans run over the non-cancelled sessions. While
 * `live` names an open recording of a session, its meeting's span reaches `now` (a race that overruns `date_end`).
 */
export function thisWeekend(season: Season, now: number, live: Live | null): Meeting | null {
  const liveKey = isOpen(live) ? live?.session?.session_key : undefined;
  const spans = new Map<Meeting, { start: number; end: number }>();
  for (const { meeting, session } of slots(season)) {
    const span = spans.get(meeting) ?? { start: Date.parse(session.date_start), end: -Infinity };
    span.end = Math.max(span.end, Date.parse(session.date_end), session.session_key === liveKey ? now : -Infinity);
    spans.set(meeting, span);
  }
  let next: { meeting: Meeting; start: number } | null = null;
  for (const [meeting, { start, end }] of spans) {
    if (start <= now && now <= end) return meeting;
    if (start > now && (next === null || start < next.start)) next = { meeting, start };
  }
  return next?.meeting ?? null;
}

/** The first session to start after `now` that is not cancelled, or null. */
export const nextSession = (season: Season, now: number): Slot | null =>
  slots(season).find((s) => Date.parse(s.session.date_start) > now) ?? null;

/** Cancelled > live now > recorded (the newest ended recording) > laps ready > laps pending > next > scheduled. */
export function sessionState(
  session: SeasonSession,
  recordings: Recordings,
  live: Live | null,
  now: number,
  nextKey: number | null,
): SessionState {
  const key = session.session_key;
  if (session.is_cancelled) return { kind: 'cancelled' };
  if (isOpen(live) && live?.session?.session_key === key) return { kind: 'live' };
  const recording = recordings.find((r) => r.session_key === key && r.ended_at !== null);
  if (recording) return { kind: 'recorded', recording };
  if (session.ingest_state === 'fetched' || session.ingest_state === 'final') return { kind: 'ready' };
  if (Date.parse(session.date_start) <= now) return { kind: 'pending' };
  return key === nextKey ? { kind: 'next' } : { kind: 'scheduled' };
}

/**
 * Round numbers: a meeting counts when neither it nor its Race-type session is cancelled, numbered by its first
 * non-cancelled session's start (never by array order); the size is M.
 */
export function roundNumbers(season: Season): Map<number, number> {
  const rounds = new Map<number, number>();
  for (const { meeting: m } of slots(season))
    if (!rounds.has(m.meeting_key) && m.sessions.some((s) => !s.is_cancelled && s.type === 'Race'))
      rounds.set(m.meeting_key, rounds.size + 1);
  return rounds;
}

/** The sessions before and after one, across meetings, skipping cancelled ones; null at either end. */
export function neighbours(season: Season, sessionKey: number): { prev: Slot | null; next: Slot | null } {
  const all = slots(season);
  const i = all.findIndex((s) => s.session.session_key === sessionKey);
  return i < 0 ? { prev: null, next: null } : { prev: all[i - 1] ?? null, next: all[i + 1] ?? null };
}

/** The meeting menu's target: the open session of the same name, else the first open one, else null. */
export function meetingTarget(meeting: Meeting, sessionName: string | null): SeasonSession | null {
  if (meeting.is_cancelled) return null;
  const open = meeting.sessions.filter((s) => !s.is_cancelled);
  return open.find((s) => s.name === sessionName) ?? open[0] ?? null;
}

const SHORT = new Map([
  ['Qualifying', 'Quali'],
  ['Sprint Qualifying', 'SQ'],
  ['Sprint Shootout', 'SQ'],
]);

/** Practice N → FPN, Qualifying → Quali, Sprint Qualifying/Shootout → SQ; anything else as it is ("—" for none). */
export const shortName = (name: string | null): string =>
  name === null ? '—' : (SHORT.get(name) ?? name.replace(/^Practice (\d)$/, 'FP$1'));
