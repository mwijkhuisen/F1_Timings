import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Result } from '../openf1/schemas.ts';

// The F1 TV token file and the rules around it (P2b D2, P2c O4). The token goes only to
// livetiming.formula1.com. It is never logged and no error carries it: fixed codes only.

const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

const HOUR = 3_600_000;
const LOOKAHEAD = 48 * HOUR; // a session this close makes the token matter
const EXPIRING = 24 * HOUR;
const RETRY = 10 * 60_000;
const COOLDOWN = 6 * HOUR; // after FAILURES failures in a row
const FAILURES = 3;

export type TokenCode = 'token_file' | 'token_format' | 'token_expired';
/** Epoch ms. */
export type Session = { dateStart: number; dateEnd: number };

/** The token file's text: a regular file, mode & 0o077 === 0, small. Fixed codes only. */
export function readTokenFile(path: string): Result<string, TokenCode> {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { ok: false, error: 'token_file' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > MAX_TOKEN_FILE_BYTES) {
      return { ok: false, error: 'token_file' };
    }
    return { ok: true, value: readFileSync(fd, 'utf8') };
  } catch {
    return { ok: false, error: 'token_file' };
  } finally {
    closeSync(fd);
  }
}

/** Atomic: a 0600 temp file in the same directory, then rename. The temp file does not outlive a failure. */
export function writeToken(path: string, token: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A raw JWT or a `login-session` cookie value (URL-encoded JSON with data.subscriptionToken), on one line. */
export function extractToken(text: string): string | undefined {
  const line = text.replace(/\r?\n$/, '').trim();
  if (line === '' || /[\r\n]/.test(line)) return undefined;
  if (JWT.test(line)) return line;
  try {
    const cookie = JSON.parse(decodeURIComponent(line)) as { data?: { subscriptionToken?: unknown } } | null;
    const token = cookie?.data?.subscriptionToken;
    return typeof token === 'string' && JWT.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** `exp` (seconds) from the JWT payload, without verifying the signature. */
export function tokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown;
    } | null;
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Token file text → token and expiry. A token without `exp` (a safe integer that is a valid Date), or past it, is refused. */
export function checkToken(text: string, nowMs: number): Result<{ token: string; exp: number }, TokenCode> {
  const token = extractToken(text);
  const exp = token === undefined ? undefined : tokenExpiry(token);
  if (
    token === undefined ||
    exp === undefined ||
    !Number.isSafeInteger(exp) ||
    Number.isNaN(new Date(exp * 1000).getTime())
  ) {
    return { ok: false, error: 'token_format' };
  }
  return exp * 1000 <= nowMs ? { ok: false, error: 'token_expired' } : { ok: true, value: { token, exp } };
}

const soon = (next: Session | undefined, now: number): next is Session =>
  next !== undefined && next.dateStart - now <= LOOKAHEAD;

/** Sign in only for a session that starts within 48 h (or runs) and that the token does not cover to its end + 1 h. */
export function needsLogin(expiresAt: number | undefined, next: Session | undefined, now: number): boolean {
  return soon(next, now) && (expiresAt === undefined || expiresAt < next.dateEnd + HOUR);
}

/** At most one attempt per 10 min, and one per 6 h after 3 failures in a row. */
export function loginAllowed(lastLoginAt: number | undefined, failures: number, now: number): boolean {
  return lastLoginAt === undefined || now - lastLoginAt >= (failures >= FAILURES ? COOLDOWN : RETRY);
}

export function warningFor(a: {
  expiresAt: number | undefined;
  next: Session | undefined;
  loginFailed: boolean;
  diskLow: boolean;
  now: number;
}): 'login_failed' | 'token_expiring' | 'disk_low' | null {
  if (a.loginFailed) return 'login_failed';
  if (soon(a.next, a.now) && (a.expiresAt === undefined || a.expiresAt - a.now < EXPIRING)) return 'token_expiring';
  return a.diskLow ? 'disk_low' : null;
}
