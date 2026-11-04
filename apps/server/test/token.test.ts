import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkToken, loginAllowed, needsLogin, warningFor, writeToken } from '../src/live/token.ts';

// Synthetic tokens only. Times are epoch ms.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSeconds: number) => `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.c2ln`;
const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
// A session that starts in 10 h and lasts 2 h: it ends at NOW + 12 h, so a token must reach NOW + 13 h.
const SESSION = { dateStart: NOW + 10 * H, dateEnd: NOW + 12 * H };

describe('needsLogin', () => {
  it('is false while the token covers the session end + 1 h (the boundary included)', () => {
    expect(needsLogin(NOW + 13 * H, SESSION, NOW)).toBe(false);
    expect(needsLogin(NOW + 20 * H, SESSION, NOW)).toBe(false);
  });
  it('is true when the token expires inside that window', () => {
    expect(needsLogin(NOW + 13 * H - 1, SESSION, NOW)).toBe(true);
    expect(needsLogin(NOW + 11 * H, SESSION, NOW)).toBe(true);
  });
  it('is true without a token', () => {
    expect(needsLogin(undefined, SESSION, NOW)).toBe(true);
  });
  it('is true while the session runs', () => {
    expect(needsLogin(NOW, { dateStart: NOW - H, dateEnd: NOW + H }, NOW)).toBe(true);
  });
  it('is false for a session beyond 48 h (the boundary at 48 h is within)', () => {
    expect(needsLogin(undefined, { dateStart: NOW + 48 * H + 1, dateEnd: NOW + 50 * H }, NOW)).toBe(false);
    expect(needsLogin(undefined, { dateStart: NOW + 48 * H, dateEnd: NOW + 50 * H }, NOW)).toBe(true);
  });
  it('is false without a next session, whatever the token', () => {
    expect(needsLogin(undefined, undefined, NOW)).toBe(false);
    expect(needsLogin(NOW - H, undefined, NOW)).toBe(false);
  });
});

describe('loginAllowed', () => {
  it('allows a first attempt', () => {
    expect(loginAllowed(undefined, 0, NOW)).toBe(true);
    expect(loginAllowed(undefined, 5, NOW)).toBe(true);
  });
  it('allows one attempt per 10 min', () => {
    expect(loginAllowed(NOW - 10 * MIN + 1, 0, NOW)).toBe(false);
    expect(loginAllowed(NOW - 10 * MIN, 0, NOW)).toBe(true);
    expect(loginAllowed(NOW - 10 * MIN, 2, NOW)).toBe(true);
  });
  it('allows one attempt per 6 h after 3 failures in a row', () => {
    expect(loginAllowed(NOW - 10 * MIN, 3, NOW)).toBe(false);
    expect(loginAllowed(NOW - 6 * H + 1, 3, NOW)).toBe(false);
    expect(loginAllowed(NOW - 6 * H, 3, NOW)).toBe(true);
    expect(loginAllowed(NOW - 7 * H, 9, NOW)).toBe(true);
  });
});

describe('warningFor', () => {
  const base = { expiresAt: NOW + 30 * H, next: SESSION, loginFailed: false, diskLow: false, now: NOW };
  it('is null when all is well', () => {
    expect(warningFor(base)).toBeNull();
  });
  it('warns of an expiring token within 24 h only when a session is within 48 h', () => {
    expect(warningFor({ ...base, expiresAt: NOW + 24 * H - 1 })).toBe('token_expiring');
    expect(warningFor({ ...base, expiresAt: NOW + 24 * H })).toBeNull();
    expect(warningFor({ ...base, expiresAt: undefined })).toBe('token_expiring');
    expect(
      warningFor({ ...base, expiresAt: undefined, next: { dateStart: NOW + 48 * H + 1, dateEnd: NOW + 50 * H } }),
    ).toBeNull();
  });
  it('is null between weekends: an expired token and no session within 48 h', () => {
    expect(warningFor({ ...base, expiresAt: NOW - 5 * 24 * H, next: undefined })).toBeNull();
    expect(
      warningFor({
        ...base,
        expiresAt: NOW - 5 * 24 * H,
        next: { dateStart: NOW + 6 * 24 * H, dateEnd: NOW + 7 * 24 * H },
      }),
    ).toBeNull();
  });
  it('ranks login_failed over token_expiring over disk_low', () => {
    const all = { ...base, expiresAt: undefined, loginFailed: true, diskLow: true };
    expect(warningFor(all)).toBe('login_failed');
    expect(warningFor({ ...all, loginFailed: false })).toBe('token_expiring');
    expect(warningFor({ ...all, loginFailed: false, next: undefined })).toBe('disk_low');
    expect(warningFor({ ...base, loginFailed: true, next: undefined })).toBe('login_failed');
  });
});

describe('writeToken', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'f1-token-'));
  it('writes one line with mode 0600, overwrites, and leaves no temp file', () => {
    const d = dir();
    const path = join(d, 'f1tv-token');
    writeToken(path, 'first.token.value');
    expect(readFileSync(path, 'utf8')).toBe('first.token.value\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, 'old');
    chmodSync(path, 0o644);
    writeToken(path, 'second.token.value');
    expect(readFileSync(path, 'utf8')).toBe('second.token.value\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(['f1tv-token']);
  });
  it('throws without leaving a temp file when the rename fails', () => {
    const d = dir();
    const path = join(d, 'f1tv-token');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), ''); // a rename onto a non-empty directory fails
    expect(() => writeToken(path, 'x.y.z')).toThrow();
    expect(readdirSync(d)).toEqual(['f1tv-token']);
  });
});

describe('paste formats through checkToken', () => {
  const exp = NOW / 1000 + 3600;
  it('takes a raw JWT, with or without a trailing newline', () => {
    const t = jwt(exp);
    expect(checkToken(t, NOW)).toEqual({ ok: true, value: { token: t, exp } });
    expect(checkToken(`${t}\n`, NOW)).toEqual({ ok: true, value: { token: t, exp } });
  });
  it('takes a login-session cookie value (URL-encoded JSON)', () => {
    const t = jwt(exp);
    const cookie = encodeURIComponent(JSON.stringify({ data: { subscriptionToken: t }, other: 1 }));
    expect(checkToken(cookie, NOW)).toEqual({ ok: true, value: { token: t, exp } });
  });
  it('refuses an expired token, junk and a cookie without a token', () => {
    expect(checkToken(jwt(NOW / 1000 - 1), NOW)).toEqual({ ok: false, error: 'token_expired' });
    expect(checkToken('not a token', NOW)).toEqual({ ok: false, error: 'token_format' });
    expect(checkToken(encodeURIComponent(JSON.stringify({ data: {} })), NOW)).toEqual({
      ok: false,
      error: 'token_format',
    });
  });
});
