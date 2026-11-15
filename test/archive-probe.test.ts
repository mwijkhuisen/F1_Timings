import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../apps/server/src/archive/files.ts';
import { archiveProbe } from '../scripts/archive-probe.ts';
import { server } from './msw.setup.ts';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const jwt = (exp?: number) => `${b64({ alg: 'none' })}.${b64(exp === undefined ? {} : { exp })}.c2ln`;
const FRESH = jwt(NOW / 1000 + 3600);
const tokenFile = (content: string, mode = 0o600) => {
  const path = join(mkdtempSync(join(tmpdir(), 'f1-probe-')), 'token');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};
const index = (sessions: object[][]) => JSON.stringify({ Meetings: sessions.map((Sessions) => ({ Sessions })) });

describe('archiveProbe', () => {
  it('refuses under CI and with bad arguments, before any request', async () => {
    const lines: string[] = [];
    const run = (argv: string[], env: Record<string, string> = {}) =>
      archiveProbe(
        argv,
        env,
        (l) => lines.push(l),
        () => NOW,
      );
    expect(await run(['--token-file', 't'], { CI: 'true' })).toBe(1);
    expect(await run([])).toBe(64);
    expect(await run(['--token-file', 't', 'extra'])).toBe(64);
    expect(await run(['--token-file', 't', '--from', '2011x'])).toBe(64);
    expect(await run(['--token-file', 't', '--from', '1949'])).toBe(64);
    expect(await run(['--token-file', 't', '--from', '2016', '--to', '2015'])).toBe(64);
    expect(await run(['--token-file', 't', '--to', '2027'])).toBe(64);
    expect(await run(['--token-file', 't', '--nope'])).toBe(64);
    expect(lines[0]).toBe('archive-probe refuses to run under CI (A§12.1 invariant 4)');
    expect(lines[1]).toMatch(/^usage: archive-probe\.ts --token-file <path>/);
  });

  it('refuses an expired token and a wide token file without a request', async () => {
    const lines: string[] = [];
    const run = (file: string) =>
      archiveProbe(
        ['--token-file', file],
        {},
        (l) => lines.push(l),
        () => NOW,
      );
    expect(await run(tokenFile(jwt(NOW / 1000 - 5)))).toBe(1);
    expect(await run(tokenFile(FRESH, 0o644))).toBe(1);
    expect(lines).toEqual(['archive-probe: token_expired', 'archive-probe: token_file']);
  });

  it('asks the control first, then each year 2 s apart, statuses and counts only', async () => {
    const events: string[] = [];
    const seen = new Set<string | null>();
    server.use(
      http.get(`${ORIGIN}/static/:year/Index.json`, ({ request, params }) => {
        events.push(String(params.year));
        seen.add(request.headers.get('authorization'));
        switch (params.year) {
          case '2018':
            return new HttpResponse(
              `﻿${index([[{ Path: 'secret name' }, { Path: 'x/y/' }], [{ Name: 'secret name' }]])}`,
            );
          case '2011':
            return new HttpResponse('secret body', { status: 401 });
          case '2012':
            return new HttpResponse('secret body', { status: 403 });
          case '2013':
            return new HttpResponse('secret body', { status: 404 });
          case '2014':
            return new HttpResponse('secret body');
          case '2015':
            return new HttpResponse('{"Meetings":[]}');
          case '2016':
            return HttpResponse.redirect('https://evil.example/', 302);
          default:
            return new HttpResponse(index([[{ Name: 'a' }, { Name: 'b' }]]));
        }
      }),
    );
    const lines: string[] = [];
    expect(
      await archiveProbe(
        ['--token-file', tokenFile(`${FRESH}\n`)],
        {},
        (l) => lines.push(l),
        () => NOW,
        async (ms) => {
          events.push(`sleep ${ms}`);
        },
      ),
    ).toBe(0);
    expect(events).toEqual([
      '2018',
      ...['2011', '2012', '2013', '2014', '2015', '2016', '2017'].flatMap((y) => ['sleep 2000', y]),
    ]);
    expect(seen).toEqual(new Set([`Bearer ${FRESH}`]));
    expect(lines).toEqual([
      'token: expires 2026-10-30T13:00:00.000Z',
      '2018 200 meetings 2 sessions 3 paths 2 (control)',
      '2011 401',
      '2012 403',
      '2013 404',
      '2014 200 index_format',
      '2015 200 meetings 0 sessions 0 paths 0',
      '2016 network',
      '2017 200 meetings 1 sessions 2 paths 0',
    ]);
    const out = lines.join('\n');
    for (const leak of [FRESH, 'secret', 'livetiming', 'static/', 'Index.json']) expect(out).not.toContain(leak);
  });

  it('fails when the control is no 200 Index with sessions, after one request', async () => {
    const answers = [
      [new HttpResponse('secret body', { status: 401 }), '2018 401 (control)'],
      [new HttpResponse('secret body', { status: 403 }), '2018 403 (control)'],
      [new HttpResponse('secret body'), '2018 200 index_format (control)'],
      [
        HttpResponse.json({ Meetings: [{ Sessions: [{ Name: 'secret name' }] }] }),
        '2018 200 meetings 1 sessions 1 paths 0 (control)',
      ],
    ] as const;
    for (const [answer, line] of answers) {
      const asked: string[] = [];
      server.use(
        http.get(`${ORIGIN}/static/:year/Index.json`, ({ params }) => {
          asked.push(String(params.year));
          return answer.clone();
        }),
      );
      const lines: string[] = [];
      expect(
        await archiveProbe(
          ['--token-file', tokenFile(FRESH)],
          {},
          (l) => lines.push(l),
          () => NOW,
          async () => {},
        ),
      ).toBe(1);
      expect(asked).toEqual(['2018']);
      expect(lines.slice(1)).toEqual([
        line,
        'archive-probe: control 2018 is no 200 Index with sessions, the token is not proven',
      ]);
    }
  });

  it('asks 2018 once when the range includes it', async () => {
    const asked: string[] = [];
    server.use(
      http.get(`${ORIGIN}/static/:year/Index.json`, ({ params }) => {
        asked.push(String(params.year));
        return new HttpResponse(index([[{ Path: 'x/y/' }]]));
      }),
    );
    expect(
      await archiveProbe(
        ['--token-file', tokenFile(FRESH), '--from', '2017', '--to', '2019'],
        {},
        () => {},
        () => NOW,
        async () => {},
      ),
    ).toBe(0);
    expect(asked).toEqual(['2018', '2017', '2019']);
  });
});
