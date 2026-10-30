import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Insertable, Kysely } from 'kysely';
import type { Logger } from 'pino';
import { codeOf, type DB } from '../db/db.ts';
import type { Recording as RecordingRow } from '../db/types.ts';
import { type Conn, type ConnectOptions, connect, type FeedCode } from './feed-client.ts';
import { type Credentials, credentials, LoginError, login, type Token } from './login.ts';
import { gzipLeftovers, openRecording, type Recording } from './recording.ts';
import { view } from './state.ts';
import {
  checkToken,
  loginAllowed,
  needsLogin,
  readTokenFile,
  type Session,
  type TokenCode,
  warningFor,
  writeToken,
} from './token.ts';

// The live role (A§11.2): one tick loop that picks the session, keeps the token and reports the status, next to one
// connection loop per recording that a slow tick cannot hold up. Sequential by construction: while a recording runs,
// no other starts, so an overlapping session starts late. Logs carry fixed codes and non-secret fields only: never a
// token, password, cookie, URL, payload, server text or error message.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LEAD_MS = 60 * MINUTE;
const AFTER_MS = 30 * MINUTE;
const HARD_STOP_MS = 3 * HOUR;
// ponytail: 60 s is a judgement call: about two reconnects at full backoff. Tighten it if a real recording with a
// shorter gap turns out to miss laps.
const MAX_GAP_MS = 60_000;
const DISK_LOW_BYTES = 5 * 1024 ** 3;
const DISK_COOLDOWN_MS = 5 * MINUTE;
const BACKOFF_RESET_MS = 60_000;

export type SessionWindow = Session & { cancelled: boolean };
export type Decision = 'continue' | 'stop' | 'abort';

export function decide(a: {
  session: SessionWindow;
  status: string | undefined;
  startedSeen: boolean;
  endsAt: number | undefined;
  now: number;
}): Decision {
  const { session, status, now } = a;
  if (session.cancelled || now < session.dateStart - LEAD_MS) return 'abort';
  if (a.startedSeen && a.endsAt !== undefined && now >= a.endsAt + AFTER_MS) return 'stop';
  if (now >= session.dateEnd + HARD_STOP_MS) return 'stop';
  if (now >= session.dateEnd + AFTER_MS && status !== 'Started' && status !== 'Aborted') return 'stop';
  return 'continue';
}

/** One subscribed connection. `to` is unset while it is open. */
export type Link = { from: number; to?: number; token: boolean };

/**
 * Subscribed at least once, a token on every link that overlaps the window, and no disconnect over MAX_GAP_MS inside
 * the window. What lies before the first link counts from the window's start, so a late start is a gap too.
 */
export function isComplete(links: readonly Link[], stoppedAt: number, { dateStart, dateEnd }: Session): boolean {
  if (links.length === 0) return false;
  let longest = 0;
  let from = dateStart;
  for (const link of links) {
    const to = link.to ?? stoppedAt;
    if (!link.token && link.from <= dateEnd && to >= dateStart) return false;
    longest = Math.max(longest, Math.min(link.from, dateEnd) - Math.max(from, dateStart));
    from = to;
  }
  return Math.max(longest, Math.min(stoppedAt, dateEnd) - Math.max(from, dateStart)) <= MAX_GAP_MS;
}

export type RecorderDeps = {
  db: Kysely<DB>;
  now: () => Date;
  log: Pick<Logger, 'info' | 'error'>;
  /** Touches the heartbeat. */
  beat: () => void;
  ping: (slug: string) => Promise<void>;
  signal: AbortSignal;
  liveDir?: string;
  tokenPath?: string;
  secretsDir?: string;
  tickMs?: number;
  connect?: typeof connect;
  login?: typeof login;
  feedOptions?: ConnectOptions;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Free bytes. */
  statfs?: (path: string) => number;
};

type Target = SessionWindow & { key: number };
type Run = {
  key: number;
  session: SessionWindow;
  path: string;
  startedAt: number;
  rec: Recording;
  links: Link[];
  stop: AbortController;
  loop: Promise<void>;
  conn: Conn | undefined;
  /** The token the current connection carried. */
  carried: string | undefined;
  subscribed: boolean;
  startedSeen: boolean;
  endsAt: number | undefined;
  backoff: number;
  gzipFailures: number;
};

const freeBytes = (path: string) => {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
};

/** A missing file is no token and no error. */
function readToken(path: string, now: number): { token?: Token; error?: TokenCode } {
  if (!existsSync(path)) return {};
  const file = readTokenFile(path);
  if (!file.ok) return { error: file.error };
  const checked = checkToken(file.value, now);
  if (!checked.ok) return { error: checked.error };
  return { token: { value: checked.value.token, expiresAt: checked.value.exp * 1000 } };
}

const windowOf = (r: { date_start: Date; date_end: Date; is_cancelled: boolean }): SessionWindow => ({
  dateStart: r.date_start.getTime(),
  dateEnd: r.date_end.getTime(),
  cancelled: r.is_cancelled,
});

/** Resolves when `signal` aborts, after the running recording has been closed. */
export async function startRecorder(deps: RecorderDeps): Promise<void> {
  const { db, log, ping, signal, secretsDir, feedOptions } = deps;
  const {
    liveDir = '/srv/f1/live',
    tokenPath = '/srv/f1/state/f1tv-token',
    tickMs = 30_000,
    connect: open = connect,
    login: signIn = login,
    backoffMs = 1000,
    maxBackoffMs = 30_000,
    statfs = freeBytes,
  } = deps;
  const ms = () => deps.now().getTime();

  let booted = false;
  let active: Run | undefined;
  let next: Target | undefined;
  let token: Token | undefined;
  /** The value the feed refused: no token until the file holds another one. */
  let rejected: string | undefined;
  let failures = 0;
  let lastLoginAt: number | undefined;
  let loginError: string | undefined;
  let tokenError: TokenCode | undefined;
  let noCredentials = false;
  let feedError: FeedCode | undefined;
  let diskUntil = 0;
  let diskLow = false;
  /** Ended on `stop`: an early `Ends` must not start the same session again. An `abort` stays out: moved is recorded later. */
  const finished = new Set<number>();
  /** Closing writes that failed, retried on later ticks. */
  const unwritten: Insertable<RecordingRow>[] = [];

  const beat = () => {
    try {
      deps.beat();
    } catch (err) {
      log.error({ last_error: 'unknown', cause: codeOf(err) }, 'heartbeat failed');
    }
  };
  const whileBeating = async <T>(work: () => Promise<T>): Promise<T> => {
    const timer = setInterval(beat, tickMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  };
  /** One bounded database step (createDb's timeouts); undefined when it failed, and nothing but the log knows. */
  const dbStep = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    beat();
    try {
      return await work();
    } catch (err) {
      log.error({ last_error: 'db', cause: codeOf(err) }, 'database step failed');
      return undefined;
    }
  };
  const saveRow = async (row: Insertable<RecordingRow>) =>
    (await dbStep(() =>
      db
        .insertInto('recording')
        .values(row)
        .onConflict((oc) =>
          oc
            .column('path')
            .doUpdateSet({ bytes: row.bytes ?? 0, ended_at: row.ended_at ?? null, complete: !!row.complete }),
        )
        .execute(),
    )) !== undefined;
  const rowOf = (r: Run): Insertable<RecordingRow> => ({
    session_key: r.key,
    path: r.path,
    started_at: new Date(r.startedAt),
    bytes: r.rec.bytes,
  });
  const noteGzip = (r: Run) => {
    if (r.rec.backgroundFailures === r.gzipFailures) return;
    r.gzipFailures = r.rec.backgroundFailures;
    log.error({ last_error: 'gzip' }, 'background job failed');
  };

  const adopt = (t: Token | undefined) => {
    if (t && t.value !== rejected) rejected = undefined;
    token = t && t.value !== rejected ? t : undefined;
  };

  const writeStatus = () => {
    const now = ms();
    const target = active?.session ?? next;
    const need = needsLogin(token?.expiresAt, target, now);
    const loginFailed = failures > 0 && (need || token === undefined); // a good paste ends it
    const lastError =
      [
        now < diskUntil && 'disk',
        loginFailed && loginError,
        rejected !== undefined && 'feed_unauthorized',
        (need || tokenError !== 'token_expired') && tokenError, // between weekends an expired token is no fault
        noCredentials && 'no_credentials',
        feedError,
        diskLow && 'disk_low',
      ].find(Boolean) || null;
    const values = {
      state: active === undefined ? 'idle' : active.subscribed ? 'recording' : 'connecting',
      session_key: active?.key ?? null,
      token_expires_at: token === undefined ? null : new Date(token.expiresAt),
      last_error: lastError,
      warning: warningFor({ expiresAt: token?.expiresAt, next: target, loginFailed, diskLow, now }),
      login_failures: failures,
      last_login_at: lastLoginAt === undefined ? null : new Date(lastLoginAt),
      updated_at: new Date(now),
    };
    return dbStep(() =>
      db
        .insertInto('recorder_status')
        .values({ id: true, ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute(),
    );
  };

  /** Closes what the last process left open. Also restores the login limits: a restart is no way around them. */
  const boot = async () => {
    const open = await db.selectFrom('recording').select(['id', 'path']).where('ended_at', 'is', null).execute();
    for (const row of open) {
      const failed = await whileBeating(() => gzipLeftovers(join(liveDir, row.path)));
      if (failed > 0) log.error({ last_error: 'gzip' }, 'leftover gzip failed');
      await db
        .updateTable('recording')
        .set({ ended_at: new Date(ms()), complete: false })
        .where('id', '=', row.id)
        .execute();
    }
    const status = await db.selectFrom('recorder_status').selectAll().executeTakeFirst();
    failures = status?.login_failures ?? 0;
    lastLoginAt = status?.last_login_at?.getTime();
    if (/^(login_|unknown$)/.test(status?.last_error ?? '')) loginError = status?.last_error ?? undefined;
    return true;
  };

  const attemptLogin = async (c: Credentials) => {
    lastLoginAt = ms();
    await writeStatus(); // before the attempt: a crash during it still counts against the limit
    try {
      const t = await whileBeating(() => signIn(c));
      writeToken(tokenPath, t.value);
      adopt(t);
      failures = 0;
      loginError = undefined;
      tokenError = undefined;
      log.info({ expires_at: new Date(t.expiresAt).toISOString() }, 'logged in');
    } catch (err) {
      failures++;
      loginError = err instanceof LoginError ? err.code : 'unknown';
      log.error({ last_error: loginError, cause: codeOf(err) }, 'login failed');
    }
  };

  const connectionLoop = async (r: Run) => {
    while (!r.stop.signal.aborted) {
      const carried = token?.value; // none is deliberate: most topics still flow, and `complete` stays false
      const openedAt = ms();
      const link: Link = { from: openedAt, token: carried !== undefined };
      r.carried = carried;
      r.conn = open(carried, (topic, payload, ts, at) => r.rec.feed(at, topic, payload, ts), {
        ...feedOptions,
        onSubscribed: (result, at) => {
          r.rec.subscribed(at, result);
          link.from = ms();
          r.links.push(link);
          r.subscribed = true;
          feedError = undefined;
        },
      });
      const closed = await r.conn.closed;
      link.to = ms();
      r.subscribed = false;
      if (r.stop.signal.aborted) break;
      feedError = closed.error;
      const fields = { last_error: closed.error, close_code: closed.closeCode, status: closed.status };
      if (closed.error) log.error(fields, 'feed closed');
      else log.info(fields, 'feed closed');
      if (closed.error === 'feed_unauthorized' && carried !== undefined) {
        rejected = carried;
        if (token?.value === carried) token = undefined;
      }
      if (ms() - openedAt > BACKOFF_RESET_MS) r.backoff = backoffMs;
      const wait = r.backoff;
      r.backoff = Math.min(r.backoff * 2, maxBackoffMs);
      await sleep(wait, undefined, { signal: r.stop.signal }).catch(() => {});
    }
  };

  const start = (s: Target) => {
    const startedAt = ms();
    const path = `${s.key}-${startedAt}`;
    const r: Run = {
      key: s.key,
      session: s,
      path,
      startedAt,
      rec: openRecording({ dir: join(liveDir, path), now: ms }),
      links: [],
      stop: new AbortController(),
      loop: Promise.resolve(),
      conn: undefined,
      carried: undefined,
      subscribed: false,
      startedSeen: false,
      endsAt: undefined,
      backoff: backoffMs,
      gzipFailures: 0,
    };
    r.loop = connectionLoop(r).catch((err: unknown) => {
      log.error({ last_error: 'unknown', cause: codeOf(err) }, 'connection loop failed');
    });
    active = r;
    log.info({ session_key: s.key }, 'recording started');
  };

  const end = async (r: Run, reason: 'stop' | 'abort' | 'disk' | 'signal') => {
    const stoppedAt = ms(); // before the gzip, whose duration is no gap
    r.stop.abort();
    r.conn?.close();
    await r.loop;
    await whileBeating(() => r.rec.finish());
    noteGzip(r);
    active = undefined;
    next = undefined;
    feedError = undefined;
    if (reason === 'stop') finished.add(r.key);
    if (reason === 'disk') diskUntil = ms() + DISK_COOLDOWN_MS;
    const complete = reason === 'stop' && isComplete(r.links, stoppedAt, r.session);
    const row = { ...rowOf(r), ended_at: new Date(ms()), complete };
    if (!(await saveRow(row))) unwritten.push(row);
    log.info({ session_key: r.key, reason, complete, bytes: r.rec.bytes }, 'recording ended');
    if (complete) await ping('f1-live');
  };

  const supervise = async (r: Run) => {
    if (r.carried === undefined && token && r.conn) {
      r.backoff = backoffMs;
      r.conn.close(); // the loop reconnects with it
    }
    noteGzip(r);
    if (r.rec.failed === 'disk') {
      log.error({ last_error: 'disk' }, 'recording failed');
      return end(r, 'disk');
    }
    // The subscribe's full state can still hold the previous session's Ends: it counts only after a Started.
    const status = view(r.rec.state, 'SessionStatus')?.Status;
    if (status === 'Started') r.startedSeen = true;
    else if (status === 'Ends' && r.startedSeen) r.endsAt ??= ms();
    const decision = decide({ session: r.session, status, startedSeen: r.startedSeen, endsAt: r.endsAt, now: ms() });
    if (decision !== 'continue') await end(r, decision);
  };

  const readSession = async () => {
    const r = active;
    const columns = ['session_key', 'date_start', 'date_end', 'is_cancelled'] as const;
    if (r) {
      // A failed read keeps recording with the last values.
      const row = await dbStep(() =>
        db.selectFrom('session').select(columns).where('session_key', '=', r.key).executeTakeFirst(),
      );
      if (row) r.session = windowOf(row);
      return;
    }
    const found = await dbStep(async () => ({
      row: await db
        .selectFrom('session')
        .select(columns)
        .where('is_cancelled', '=', false)
        .where('date_end', '>', new Date(ms() - AFTER_MS))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('recording')
                .select('recording.id')
                .whereRef('recording.session_key', '=', 'session.session_key')
                .where('recording.complete', '=', true),
            ),
          ),
        )
        .$if(finished.size > 0, (qb) => qb.where('session_key', 'not in', [...finished]))
        .orderBy('date_start')
        .orderBy('session_key')
        .limit(1)
        .executeTakeFirst(),
    }));
    if (found) next = found.row && { key: found.row.session_key, ...windowOf(found.row) };
  };

  const tick = async () => {
    beat();
    if (!booted) booted = (await dbStep(boot)) === true;
    if (!booted) return; // no limits known, so no login; no open row closed, so no new one

    await readSession();
    for (const row of unwritten.splice(0)) if (!(await saveRow(row))) unwritten.push(row);

    const file = readToken(tokenPath, ms());
    adopt(file.token);
    tokenError = file.error;
    noCredentials = false;
    if (needsLogin(token?.expiresAt, active?.session ?? next, ms())) {
      const creds = credentials(secretsDir);
      if (!creds) noCredentials = true;
      else if (loginAllowed(lastLoginAt, failures, ms())) await attemptLogin(creds);
    }

    try {
      diskLow = statfs(liveDir) < DISK_LOW_BYTES;
    } catch (err) {
      diskLow = false;
      log.error({ last_error: 'statfs', cause: codeOf(err) }, 'statfs failed');
    }

    if (!active && next && !signal.aborted && ms() >= next.dateStart - LEAD_MS && ms() >= diskUntil) start(next);
    if (active) await supervise(active);
    if (active) await saveRow(rowOf(active)); // also the retry of an insert that failed
    await writeStatus();
  };

  // ponytail: a restart during a red-flag overrun past date_end + 30 min is not resumed; resume from the open row if
  // that ever happens.
  while (!signal.aborted) {
    try {
      await tick();
    } catch (err) {
      log.error({ last_error: 'unknown', cause: codeOf(err) }, 'tick failed');
    }
    await sleep(tickMs, undefined, { signal }).catch(() => {});
  }
  log.info({}, 'stopping');
  if (active) await end(active, 'signal');
  if (booted) await writeStatus();
}
