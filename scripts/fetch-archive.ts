import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { checkToken, readTokenFile } from '../apps/server/src/live/token.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import type { Result } from '../apps/server/src/openf1/schemas.ts';

// Downloads one session's F1 archive files (`<Topic>.jsonStream` and `<Topic>.json`, A§6.2) into
// fixtures-private/archive/<session_key>/. Run on the owner's machine only: CI never calls F1
// (A§12.1 invariant 4). The F1 TV token comes from a 0600 file (P2b D2) and goes only to
// livetiming.formula1.com, in an Authorization header. It is never logged, put in argv or env, and
// no error carries a body or an exception message: a fixed code plus the HTTP status.

export const ORIGIN = 'https://livetiming.formula1.com';
const BASE = `${ORIGIN}/static/`;
export const PRIVATE = join(import.meta.dirname, '../fixtures-private');
const USAGE = 'usage: fetch-archive.ts <year> <session_key> --token-file <path> [--path <year/meeting/session/>]';
const TIMEOUT_MS = 60_000;
export const MAX_BYTES = 256 * 1024 * 1024;

/** The 11 topics the views need, plus SessionData and Heartbeat (the archive's t0). */
export const TOPICS = [
  'DriverList',
  'TimingData',
  'TimingAppData',
  'TimingStats',
  'SessionInfo',
  'SessionStatus',
  'TrackStatus',
  'LapCount',
  'RaceControlMessages',
  'ExtrapolatedClock',
  'WeatherData',
  'SessionData',
  'Heartbeat',
];

export type Failure = { code: 'http'; status: number } | { code: 'network' | 'timeout' | 'too_large' | 'host' };

const PATH = /^\d{4}\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/$/;

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

export type IndexSession = { Key: unknown; Type: unknown; Name: unknown; Path: string };

/** Every session of an Index.json (Meetings[].Sessions[]) that has a Path. The BOM is stripped here. */
export function indexSessions(text: string): IndexSession[] | undefined {
  let index: unknown;
  try {
    index = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  const meetings = (index as { Meetings?: unknown } | null)?.Meetings;
  if (!Array.isArray(meetings)) return undefined;
  return meetings.flatMap((m: { Sessions?: unknown } | null) =>
    Array.isArray(m?.Sessions)
      ? (m.Sessions as IndexSession[]).filter((s) => typeof s === 'object' && s !== null && typeof s.Path === 'string')
      : [],
  );
}

/** One GET to the F1 host with the token. No redirects, a 60 s deadline, a 256 MiB cap. Never throws. */
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

const describe = (error: Failure) => (error.code === 'http' ? `http ${error.status}` : error.code);

export async function fetchArchive(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  root = PRIVATE,
  now = () => Date.now(),
): Promise<number> {
  if (env.CI) {
    log('fetch-archive refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  let args: ReturnType<typeof parseOptions>;
  try {
    args = parseOptions(argv);
  } catch {
    log(USAGE);
    return EXIT_USAGE;
  }
  const [year = '', sessionKey = ''] = args.positionals;
  const tokenFile = args.values['token-file'];
  const dir = outDir(root, sessionKey);
  if (args.positionals.length !== 2 || !/^\d{4}$/.test(year) || dir === undefined || tokenFile === undefined) {
    log(USAGE);
    return EXIT_USAGE;
  }

  const file = readTokenFile(tokenFile);
  const checked = file.ok ? checkToken(file.value, now()) : file;
  if (!checked.ok) {
    log(`fetch-archive: ${checked.error}`);
    return 1;
  }
  const { token, exp } = checked.value;
  log(`token: expires ${new Date(exp * 1000).toISOString()}`);

  let path = args.values.path;
  if (path === undefined) {
    const index = await download(`${BASE}${year}/Index.json`, token);
    if (!index.ok) {
      log(`fetch-archive: index ${describe(index.error)}`);
      return 1;
    }
    const sessions = indexSessions(index.value.bytes.toString('utf8'));
    if (sessions === undefined) {
      log('fetch-archive: index_format');
      return 1;
    }
    const found = sessions.find((s) => Number(s.Key) === Number(sessionKey));
    if (found === undefined) {
      // Do not guess: the F1 Key may not be OpenF1's session_key. The owner picks a Path.
      log(`index: no session has Key == ${sessionKey} (the F1 Key may not be the OpenF1 session_key)`);
      for (const s of sessions) log(`  Key ${safe(s.Key)} ${safe(s.Type)} ${safe(s.Name)} ${safe(s.Path)}`);
      log('rerun with --path <Path> to pick one');
      return 1;
    }
    log(`index: Key ${sessionKey} matches ${safe(found.Type)} ${safe(found.Name)}`);
    path = found.Path;
  }
  if (!isArchivePath(path) || !path.startsWith(`${year}/`)) {
    log('fetch-archive: bad_path');
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  let failed = false;
  for (const topic of TOPICS) {
    for (const name of [`${topic}.jsonStream`, `${topic}.json`]) {
      const got = await download(`${BASE}${path}${name}`, token);
      if (got.ok) {
        writeFileSync(join(dir, name), got.value.bytes);
        log(`${name} ${got.value.status} ${got.value.bytes.length} bytes`);
      } else if (got.error.code === 'http' && (got.error.status === 404 || got.error.status === 403)) {
        // The archive answers a file it doesn't have (LapCount outside a race) with 403, not 404;
        // the Index already proved the token.
        log(`${name} ${got.error.status} skipped`);
      } else {
        log(`${name} ${describe(got.error)}`);
        failed = true;
        if (got.error.code === 'http' && got.error.status === 401) return 1;
      }
    }
  }
  return failed ? 1 : 0;
}

const parseOptions = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { 'token-file': { type: 'string' }, path: { type: 'string' } },
  });

if (import.meta.main) {
  process.exitCode = await fetchArchive(process.argv.slice(2), process.env);
}
