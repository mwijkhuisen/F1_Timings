import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { view } from '@f1/contracts';
import { createLaps } from '../live/laps.ts';
import { createFeed } from '../live/merge.ts';
import { archiveT0, type FeedEvent, parseJsonStream, type T0From } from '../live/read.ts';
import type { Result } from '../openf1/schemas.ts';

// The F1 archive (A§6.2): downloads from livetiming.formula1.com/static and the reading of a session's
// `<Topic>.jsonStream` files, shared by the archive job and scripts/fetch-archive.ts, compare-laps.ts and feed-keys.ts.
// The F1 TV token goes only to that host, in an Authorization header. It is never logged, and no error carries a body
// or an exception message: a fixed code plus the HTTP status.

export const ORIGIN = 'https://livetiming.formula1.com';
const TIMEOUT_MS = 60_000;
/** One download, buffered twice (the parts and their concat); the largest file seen is about 7 MB. */
export const MAX_BYTES = 64 * 1024 * 1024;
/**
 * A session's topic files in all, before the job reads and parses them: this, not MAX_BYTES, bounds its memory.
 * WSL [box] peak RSS: 157 MB at 0.41 MB of input and 271 MB at 6.61 MB, about 18 MB of RSS per MB above a ~150 MB
 * base, against the job's 512m limit. 16 MiB is 2.5 times the largest session seen, and the linear fit puts it near
 * 450 MB, inside the limit.
 */
export const MAX_SESSION_BYTES = 16 * 1024 * 1024;

/** `empty` is the job's: a 200 without a byte. */
export type Failure =
  | { code: 'http'; status: number }
  | { code: 'network' | 'timeout' | 'too_large' | 'host' | 'empty' };

/** Letters and digits of any script (São Paulo), `_` and `-`: never `.`, `/`, `%`, a space or a control character. */
const PATH = /^\d{4}\/[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+\/$/u;

export const isArchivePath = (path: string): boolean => PATH.test(path);

/** Printable ASCII only: Index.json text is remote data and may hold control characters. */
export const safe = (value: unknown) => String(value).replace(/[^\x20-\x7e]/g, '?');

/**
 * `<root>/archive/<session_key>`, or undefined when the key is no plain number or the resolved
 * path would leave `<root>/archive`.
 */
export function outDir(root: string, sessionKey: string): string | undefined {
  if (!/^\d{1,9}$/.test(sessionKey)) return undefined;
  const base = resolve(root, 'archive');
  const dir = resolve(base, sessionKey);
  return dir.startsWith(base + sep) ? dir : undefined;
}

export type IndexSession = {
  Key: unknown;
  Type: unknown;
  Name: unknown;
  Path: string;
  meeting: Record<string, unknown>;
};

/**
 * Every session of an Index.json (Meetings[].Sessions[]) that has a Path, with its meeting object. The BOM is
 * stripped here.
 */
export function indexSessions(text: string): IndexSession[] | undefined {
  let index: unknown;
  try {
    index = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  const meetings = (index as { Meetings?: unknown } | null)?.Meetings;
  if (!Array.isArray(meetings)) return undefined;
  return meetings.flatMap((m: Record<string, unknown> | null) =>
    m !== null && Array.isArray(m.Sessions)
      ? (m.Sessions as IndexSession[])
          .filter((s) => typeof s === 'object' && s !== null && typeof s.Path === 'string')
          .map((s) => ({ ...s, meeting: m }))
      : [],
  );
}

/** One GET to the F1 host with the token. No redirects, a 60 s deadline, a 64 MiB cap. Never throws. */
export async function download(
  target: string,
  token: string,
): Promise<Result<{ status: number; bytes: Buffer }, Failure>> {
  if (new URL(target).origin !== ORIGIN) return { ok: false, error: { code: 'host' } };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error', // the token never follows a redirect to another host
      signal,
    });
    const { status } = response;
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return { ok: false, error: { code: 'http', status } };
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, value: { status, bytes: Buffer.concat(parts) } };
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return { ok: false, error: { code: 'too_large' } };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, error: { code: signal.aborted ? 'timeout' : 'network' } };
  }
}

/** Topic → text of every `<Topic>.jsonStream` in a directory. Throws as readdirSync and readFileSync do. */
export const readStreams = (dir: string): Map<string, string> =>
  new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.jsonStream'))
      .map((f) => [f.slice(0, -'.jsonStream'.length), readFileSync(join(dir, f), 'utf8')]),
  );

export type ArchiveEvents = {
  events: FeedEvent[];
  skipped: number;
  t0: number;
  from: T0From;
  /** The first Heartbeat's t0, for the log's delta; undefined without a Heartbeat. */
  heartbeat: number | undefined;
};

/**
 * One session's streams (topic → text) → its events, on the archive t0 (archiveT0), in time order. Stable: events
 * at the same t keep topic-name order, except SessionInfo, which goes first (the session gate in laps.ts reads it
 * before the other topics). Undefined without a t0.
 */
export function archiveEvents(files: ReadonlyMap<string, string>): ArchiveEvents | undefined {
  let skipped = 0;
  const parsed = new Map(
    [...files.keys()].sort().map((topic) => {
      const p = parseJsonStream(files.get(topic) ?? '', topic, 0);
      skipped += p.skipped;
      return [topic, p.events] as const;
    }),
  );
  const heartbeat = parsed.get('Heartbeat') ?? [];
  const found = archiveT0(heartbeat, parsed.get('SessionData'), parsed.get('ExtrapolatedClock'));
  if (found === undefined) return undefined;
  const hb = archiveT0(heartbeat)?.t0;
  const events = [...parsed.values()].flat();
  for (const ev of events) ev.t += found.t0;
  return { events: events.sort(byTime), skipped, ...found, heartbeat: hb };
}

const first = (ev: FeedEvent) => Number(ev.topic === 'SessionInfo');
/** archiveEvents' order: by t, then SessionInfo first, then topic name (stable within a topic). */
export const byTime = (a: FeedEvent, b: FeedEvent): number =>
  a.t - b.t || first(b) - first(a) || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0);

/** Our rows. Two passes: the first finds the session key and type (SessionInfo), the second builds the rows. */
export function reconstruct(events: readonly FeedEvent[], source: 'f1-live' | 'f1-archive') {
  const first = createFeed();
  for (const ev of events) first.apply(ev);
  const info = view(first.state, 'SessionInfo');
  if (info?.Key === undefined) return { state: first.state, info };
  const [feed, laps] = [createFeed(), createLaps(info.Key, source)];
  for (const ev of events) {
    const delta = feed.apply(ev);
    if (delta !== undefined) laps.push(ev, delta);
  }
  return { state: first.state, info, rows: laps.rows() };
}
