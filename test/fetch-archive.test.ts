import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  checkToken,
  extractToken,
  fetchArchive,
  indexSessions,
  isArchivePath,
  ORIGIN,
  outDir,
  readTokenFile,
  TOPICS,
  tokenExpiry,
} from '../scripts/fetch-archive.ts';
import { server } from './msw.setup.ts';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const jwt = (exp?: number) => `${b64({ alg: 'none' })}.${b64(exp === undefined ? {} : { exp })}.c2ln`;
const FRESH = jwt(NOW / 1000 + 3600);
const tmp = () => mkdtempSync(join(tmpdir(), 'f1-archive-'));
const tokenFile = (content: string, mode = 0o600) => {
  const path = join(tmp(), 'token');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

describe('token file', () => {
  it('accepts a 0600 regular file and refuses wider modes, directories and missing files', () => {
    expect(readTokenFile(tokenFile(`${FRESH}\n`))).toEqual({ ok: true, value: `${FRESH}\n` });
    expect(readTokenFile(tokenFile(FRESH, 0o640))).toEqual({ ok: false, error: 'token_file' });
    expect(readTokenFile(tokenFile(FRESH, 0o604))).toEqual({ ok: false, error: 'token_file' });
    const dir = tmp();
    expect(readTokenFile(dir)).toEqual({ ok: false, error: 'token_file' });
    expect(readTokenFile(join(dir, 'missing'))).toEqual({ ok: false, error: 'token_file' });
  });

  it('takes a raw JWT or a login-session cookie, on one line', () => {
    const cookie = encodeURIComponent(JSON.stringify({ data: { subscriptionToken: FRESH } }));
    expect(extractToken(`${FRESH}\n`)).toBe(FRESH);
    expect(extractToken(`${FRESH}\r\n`)).toBe(FRESH);
    expect(extractToken(cookie)).toBe(FRESH);
    expect(extractToken(`${FRESH}\n${FRESH}\n`)).toBeUndefined();
    expect(extractToken('')).toBeUndefined();
    expect(extractToken('not a token')).toBeUndefined();
    expect(extractToken(encodeURIComponent(JSON.stringify({ data: {} })))).toBeUndefined();
  });

  it('reads exp without verifying, refuses an expired token or one without exp', () => {
    expect(tokenExpiry(FRESH)).toBe(NOW / 1000 + 3600);
    expect(tokenExpiry(jwt())).toBeUndefined();
    expect(checkToken(FRESH, NOW)).toEqual({ ok: true, value: { token: FRESH, exp: NOW / 1000 + 3600 } });
    expect(checkToken(jwt(NOW / 1000 - 1), NOW)).toEqual({ ok: false, error: 'token_expired' });
    expect(checkToken(jwt(NOW / 1000), NOW)).toEqual({ ok: false, error: 'token_expired' });
    expect(checkToken(jwt(), NOW)).toEqual({ ok: false, error: 'token_format' });
    expect(checkToken('garbage', NOW)).toEqual({ ok: false, error: 'token_format' });
  });
});

describe('paths', () => {
  it('accepts only <year>/<meeting>/<session>/', () => {
    expect(isArchivePath('2026/2026-10-25_Mexico_City_Grand_Prix/2026-10-25_Race/')).toBe(true);
    for (const bad of [
      '2026/a/b',
      '2026/a/b/c/',
      '2026/../b/',
      '2026/a/b/?x=1',
      'x/a/b/',
      '//evil.example/a/b/',
      '2026/a b/c/',
    ]) {
      expect(isArchivePath(bad)).toBe(false);
    }
  });

  it('keeps the output directory inside <root>/archive', () => {
    expect(outDir('/r', '11397')).toBe('/r/archive/11397');
    for (const bad of ['..', '../x', '1/../../x', '', '12a', '/etc', '0123456789'])
      expect(outDir('/r', bad)).toBeUndefined();
  });
});

describe('fetchArchive', () => {
  const PATH = '2026/2026-10-25_Mexico/2026-10-25_Race/';
  const sessions = (key: number) => ({
    Meetings: [{ Sessions: [{ Key: key, Type: 'Race', Name: 'Race', Path: PATH }] }],
  });
  const index = (key: number) => new HttpResponse(`﻿${JSON.stringify(sessions(key))}`);

  it('refuses under CI and with bad arguments, before any request', async () => {
    const lines: string[] = [];
    expect(await fetchArchive(['2026', '11397'], { CI: 'true' }, (l) => lines.push(l), tmp())).toBe(1);
    expect(await fetchArchive(['2026'], {}, (l) => lines.push(l), tmp())).toBe(64);
    expect(await fetchArchive(['2026', '../x', '--token-file', 't'], {}, (l) => lines.push(l), tmp())).toBe(64);
    expect(lines[0]).toBe('fetch-archive refuses to run under CI (A§12.1 invariant 4)');
  });

  it('refuses an expired token and a wide token file without a request', async () => {
    const lines: string[] = [];
    const run = (file: string) =>
      fetchArchive(
        ['2026', '11397', '--token-file', file],
        {},
        (l) => lines.push(l),
        tmp(),
        () => NOW,
      );
    expect(await run(tokenFile(jwt(NOW / 1000 - 5)))).toBe(1);
    expect(await run(tokenFile(FRESH, 0o644))).toBe(1);
    expect(lines).toEqual(['fetch-archive: token_expired', 'fetch-archive: token_file']);
  });

  it('downloads every topic with the token only in the header, skips a 404, never logs the token', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(`${ORIGIN}/static/2026/Index.json`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return index(11397);
      }),
      http.get(`${ORIGIN}/static/${PATH}:file`, ({ request, params }) => {
        seen.push(request.headers.get('authorization'));
        return params.file === 'DriverList.jsonStream'
          ? new HttpResponse('secret body', { status: 404 })
          : new HttpResponse('data');
      }),
    );
    const [root, lines] = [tmp(), [] as string[]];
    const file = tokenFile(`${FRESH}\n`);
    expect(
      await fetchArchive(
        ['2026', '11397', '--token-file', file],
        {},
        (l) => lines.push(l),
        root,
        () => NOW,
      ),
    ).toBe(0);

    expect(seen).toHaveLength(1 + TOPICS.length * 2);
    expect(new Set(seen)).toEqual(new Set([`Bearer ${FRESH}`]));
    expect(lines).toContain('token: expires 2026-10-30T13:00:00.000Z');
    expect(lines).toContain('DriverList.jsonStream 404 skipped');
    expect(lines).toContain('Heartbeat.json 200 4 bytes');
    expect(lines.join('\n')).not.toContain(FRESH);
    expect(lines.join('\n')).not.toContain('secret body');
    expect(readFileSync(join(root, 'archive/11397/TimingData.jsonStream'), 'utf8')).toBe('data');
    expect(existsSync(join(root, 'archive/11397/DriverList.jsonStream'))).toBe(false);
  });

  it('does not guess when no Key matches: it lists the sessions and downloads nothing', async () => {
    server.use(http.get(`${ORIGIN}/static/2026/Index.json`, () => index(9999)));
    const [root, lines] = [tmp(), [] as string[]];
    const file = tokenFile(FRESH);
    expect(
      await fetchArchive(
        ['2026', '11397', '--token-file', file],
        {},
        (l) => lines.push(l),
        root,
        () => NOW,
      ),
    ).toBe(1);
    expect(lines.some((l) => l.startsWith('index: no session has Key == 11397'))).toBe(true);
    expect(lines).toContain(`  Key 9999 Race Race ${PATH}`);
    expect(existsSync(join(root, 'archive'))).toBe(false);
  });

  it('stops at a 401 with the status only, and never follows a redirect', async () => {
    server.use(http.get(`${ORIGIN}/static/2026/Index.json`, () => new HttpResponse('token rejected', { status: 401 })));
    const lines: string[] = [];
    const file = tokenFile(FRESH);
    expect(
      await fetchArchive(
        ['2026', '11397', '--token-file', file],
        {},
        (l) => lines.push(l),
        tmp(),
        () => NOW,
      ),
    ).toBe(1);
    expect(lines.at(-1)).toBe('fetch-archive: index http 401');

    server.use(http.get(`${ORIGIN}/static/2026/Index.json`, () => HttpResponse.redirect('https://evil.example/', 302)));
    lines.length = 0;
    expect(
      await fetchArchive(
        ['2026', '11397', '--token-file', file],
        {},
        (l) => lines.push(l),
        tmp(),
        () => NOW,
      ),
    ).toBe(1);
    expect(lines.at(-1)).toBe('fetch-archive: index network');
  });

  it('indexSessions strips the BOM and keeps sessions with a Path', () => {
    expect(indexSessions(`﻿${JSON.stringify(sessions(1))}`)?.map((s) => s.Key)).toEqual([1]);
    expect(indexSessions('{}')).toBeUndefined();
    expect(indexSessions('nope')).toBeUndefined();
  });
});
