import { view, weatherRow } from '@f1/contracts';
import type { Insertable } from 'kysely';
import type { DB } from '../db/db.ts';
import { createFeed } from '../live/merge.ts';
import { type T0From, utc } from '../live/read.ts';
import type { Result } from '../openf1/schemas.ts';
import { markLaps, type RuleCounts, type RuleMessage } from '../timing/rules.ts';
import { archiveEvents, type IndexSession, indexSessions, isArchivePath, reconstruct } from './files.ts';

// The F1 archive (A§6.2) → A§7 rows with source 'f1-archive'. Pure: the Index gives the meeting and session rows,
// one session's streams the child rows. No pit rows: no view reads them yet.

const source = 'f1-archive';
type Rows<T extends keyof DB> = Insertable<DB[T]>[];
export type ArchiveRows = {
  driver: Rows<'driver'>;
  lap: Rows<'lap'>;
  stint: Rows<'stint'>;
  race_control: Rows<'race_control'>;
  result: Rows<'result'>;
  weather: Rows<'weather'>;
};
export type Planned = {
  key: number;
  path: string;
  type: string | null;
  meeting: Insertable<DB['meeting']>;
  session: Insertable<DB['session']>;
};

const str = (v: unknown) => (typeof v === 'string' && !v.includes('\0') ? v : null);
const int = (v: unknown, max = 32_767) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const nested = (o: unknown, k: string) =>
  typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined;
const driverKey = (n: string) => (/^\d{1,3}$/.test(n) ? Number(n) : null);

/** A GmtOffset (`[+-]H:MM[:SS]`) → OpenF1's `[-]HH:MM:SS` (no `+`: the web's fmtTrack refuses it) and its ms. */
export function gmtOffset(v: unknown): { text: string; ms: number } | undefined {
  const m = typeof v === 'string' ? /^([+-]?)(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v) : null;
  if (!m) return undefined;
  const [, sign, h = '', min = '', s = '00'] = m;
  const ms = (Number(h) * 3600 + Number(min) * 60 + Number(s)) * 1000 * (sign === '-' ? -1 : 1);
  return { text: `${sign === '-' ? '-' : ''}${h.padStart(2, '0')}:${min}:${s}`, ms };
}

// An Index StartDate or EndDate: the local time of the circuit, without a zone.
const local = (v: unknown, offset: number) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)
    ? (utc(v) ?? Number.NaN) - offset
    : Number.NaN;

/**
 * An Index.json of `year` → one plan per session with an archive Path, with its meeting and session rows; the
 * session dates in UTC from its GmtOffset, the meeting's as the min and max of its sessions. A Path that is no
 * archive path of the year counts as `badPath`, a session without a numeric Key or valid dates as `badIndex`, and so
 * does one whose UTC dates leave `year`, end before they start or end after `now` (epoch ms): an archive row must never
 * look like a coming session to the recorder or ingest's live window. Undefined when the text is no Index.
 */
export function indexPlan(
  text: string,
  year: number,
  now: number,
): { sessions: Planned[]; badPath: number[]; badIndex: number } | undefined {
  const all = indexSessions(text);
  if (all === undefined) return undefined;
  const dated = all.map((s) => {
    const offset = gmtOffset((s as { GmtOffset?: unknown }).GmtOffset);
    const { StartDate, EndDate } = s as { StartDate?: unknown; EndDate?: unknown };
    const start = offset ? local(StartDate, offset.ms) : Number.NaN;
    const end = offset ? local(EndDate, offset.ms) : Number.NaN;
    return { s, offset, start, end, key: int(s.Key, 999_999_999), meetingKey: int(s.meeting.Key, 2_147_483_647) };
  });
  const inYear = (ms: number) => new Date(ms).getUTCFullYear() === year;
  const ok = dated.filter(
    (d) =>
      d.key !== null &&
      d.meetingKey !== null &&
      d.offset &&
      inYear(d.start) &&
      inYear(d.end) &&
      d.start <= d.end &&
      d.end < now,
  );
  const span = new Map<IndexSession['meeting'], [number, number]>(); // keyed on the meeting object
  for (const { s, start, end } of ok) {
    const [a, b] = span.get(s.meeting) ?? [start, end];
    span.set(s.meeting, [Math.min(a, start), Math.max(b, end)]);
  }
  const badPath: number[] = [];
  const sessions: Planned[] = [];
  for (const { s, offset, start, end, key, meetingKey } of ok) {
    if (key === null || meetingKey === null || !offset) continue;
    if (!isArchivePath(s.Path) || !s.Path.startsWith(`${year}/`)) {
      badPath.push(key);
      continue;
    }
    const m = s.meeting;
    const [first, last] = span.get(m) ?? [start, end];
    sessions.push({
      key,
      path: s.Path,
      type: str(s.Type),
      meeting: {
        meeting_key: meetingKey,
        source,
        year,
        name: str(m.Name),
        official_name: str(m.OfficialName),
        location: str(m.Location),
        country_code: str(nested(m.Country, 'Code')),
        circuit_short_name: str(nested(m.Circuit, 'ShortName')),
        gmt_offset: offset.text,
        date_start: iso(first),
        date_end: iso(last),
        is_cancelled: false,
      },
      session: {
        session_key: key,
        source,
        meeting_key: meetingKey,
        type: str(s.Type),
        name: str(s.Name),
        date_start: new Date(start).toISOString(),
        date_end: new Date(end).toISOString(),
        is_cancelled: false,
        ingest_state: 'final',
        next_fetch_at: null,
        fetch_count: 1,
        fail_count: 0,
        last_error: null,
      },
    });
  }
  return { sessions, badPath, badIndex: all.length - ok.length };
}

export type Stats = {
  t0: T0From;
  t0_heartbeat_delta_ms: number | null;
  phases: number;
  rules: RuleCounts;
  skipped_lines: number;
};

/**
 * One session's streams (topic → text) → its child rows. `incomplete` without SessionInfo, TimingData or a t0;
 * `key_mismatch` when SessionInfo's Key is not the Index Key.
 */
export function archiveRows(
  files: ReadonlyMap<string, string>,
  key: number,
  type: string | null,
): Result<{ rows: ArchiveRows; stats: Stats }, 'incomplete' | 'key_mismatch'> {
  const archive = files.has('SessionInfo') && files.has('TimingData') ? archiveEvents(files) : undefined;
  if (archive === undefined) return { ok: false, error: 'incomplete' };
  const { state, info, rows } = reconstruct(archive.events, source);
  if (info?.Key !== key || rows === undefined) return { ok: false, error: 'key_mismatch' };

  // The qualifying part in force from each change on (SessionData Series), in time order.
  const phases: { at: number; part: number }[] = [];
  const series = Object.values(view(state, 'SessionData')?.Series ?? {})
    .map((s) => ({ at: utc(s?.Utc), part: s?.QualifyingPart }))
    .filter((s): s is { at: number; part: number } => s.at !== null && int(s.part) !== null)
    .sort((a, b) => a.at - b.at);
  for (const s of series) if (phases.at(-1)?.part !== s.part) phases.push(s);
  const phaseAt = (at: number | null) => (at === null ? null : (phases.findLast((p) => p.at <= at)?.part ?? null));

  const race_control = Object.values(view(state, 'RaceControlMessages')?.Messages ?? {}).flatMap((m) => {
    if (!m) return [];
    const at = utc(m.Utc);
    const racing = str(m.RacingNumber);
    return [
      {
        session_key: key,
        source,
        date: iso(at),
        category: str(m.Category),
        flag: str(m.Flag),
        scope: str(m.Scope),
        sector: int(m.Sector),
        driver_number: racing === null ? null : driverKey(racing),
        lap_number: int(m.Lap),
        qualifying_phase: phaseAt(at),
        message: str(m.Message),
      },
    ];
  });

  const lap = rows.laps.map(({ at, ...l }) => ({ ...l, date_start: l.date_start as string | null }));
  // The phase boundaries as message-less rows, so a lap's phase follows SessionData exactly.
  const boundaries: RuleMessage[] = phases.map((p) => ({ date: iso(p.at), qualifying_phase: p.part, message: null }));
  const rules = markLaps(lap, [...race_control, ...boundaries], type);

  const driver = Object.entries(view(state, 'DriverList') ?? {}).flatMap(([n, d]) => {
    const number = driverKey(n);
    return d && number !== null
      ? [
          {
            session_key: key,
            source,
            driver_number: number,
            acronym: d.Tla ?? null,
            full_name: d.FullName ?? null,
            team_name: d.TeamName ?? null,
            team_colour: d.TeamColour ?? null,
          },
        ]
      : [];
  });

  const result = Object.entries(view(state, 'TimingData')?.Lines ?? {}).flatMap(([n, l]) => {
    const number = driverKey(n);
    return l && number !== null
      ? [
          {
            session_key: key,
            source,
            driver_number: number,
            position: /^\d{1,5}$/.test(l.Position ?? '') ? int(Number(l.Position)) : null,
            laps: int(l.NumberOfLaps),
            dnf: null,
            dns: null,
            dsq: null,
            durations_ms: null,
            gaps_ms: null,
          },
        ]
      : [];
  });

  // One row per WeatherData event, keyed on its instant (as normalise.ts): a second row at one instant would break
  // the primary key (session_key, date).
  const feed = createFeed();
  const weather = new Map<number, Rows<'weather'>[number]>();
  for (const ev of archive.events) {
    if (ev.topic !== 'WeatherData' || feed.apply(ev) === undefined) continue;
    weather.set(ev.t, { session_key: key, source, ...weatherRow(view(feed.state, 'WeatherData'), ev.t) });
  }

  return {
    ok: true,
    value: {
      rows: {
        driver,
        lap,
        stint: rows.stints,
        race_control,
        result,
        weather: [...weather.values()],
      },
      stats: {
        t0: archive.from,
        t0_heartbeat_delta_ms: archive.heartbeat === undefined ? null : archive.t0 - archive.heartbeat,
        phases: phases.length,
        rules,
        skipped_lines: archive.skipped,
      },
    },
  };
}
