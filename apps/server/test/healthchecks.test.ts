import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { pingHealthchecks } from '../src/healthchecks.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 characters
let dir: string;
let urls: string[];
const log = { error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'f1-hc-'));
  urls = [];
  log.error.mockClear();
  server.use(
    http.get('https://hc-ping.com/*', ({ request }) => {
      urls.push(request.url);
      return new HttpResponse('OK');
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = (value: string) => writeFileSync(join(dir, 'hc_ping_key'), `${value}\n`);
const logged = () => JSON.stringify(log.error.mock.calls);

describe('pingHealthchecks', () => {
  it('requests exactly https://hc-ping.com/<key>/f1-ingest', async () => {
    key(KEY);
    await pingHealthchecks('f1-ingest', log, { secretsDir: dir });
    expect(urls).toEqual([`https://hc-ping.com/${KEY}/f1-ingest`]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('requests exactly https://hc-ping.com/<key>/f1-live/fail: the slug form of the fail signal', async () => {
    key(KEY);
    await pingHealthchecks('f1-live/fail', log, { secretsDir: dir });
    expect(urls).toEqual([`https://hc-ping.com/${KEY}/f1-live/fail`]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('sends no request without the secret file', async () => {
    await pingHealthchecks('f1-ingest', log, { secretsDir: dir });
    expect(urls).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('sends no request for an invalid key and logs a code, not the key', async () => {
    for (const bad of [`${KEY}x`, KEY.slice(1), `${KEY.slice(1)}/`, '../../x']) {
      key(bad);
      await pingHealthchecks('f1-ingest', log, { secretsDir: dir });
    }
    expect(urls).toEqual([]);
    expect(log.error).toHaveBeenCalledTimes(4);
    expect(logged()).toContain('hc_key_invalid');
    expect(logged()).not.toContain(KEY.slice(1));
  });

  it('swallows a 500 and logs hc_ping_failed without the key', async () => {
    key(KEY);
    server.use(http.get('https://hc-ping.com/*', () => new HttpResponse(null, { status: 500 })));
    await expect(pingHealthchecks('f1-ingest', log, { secretsDir: dir })).resolves.toBeUndefined();
    expect(logged()).toContain('hc_ping_failed');
    expect(logged()).not.toContain(KEY);
  });

  it('swallows a timeout and logs hc_ping_failed without the key', async () => {
    key(KEY);
    server.use(
      http.get('https://hc-ping.com/*', async () => {
        await delay(300); // finite: the reply comes after the 30 ms deadline
        return new HttpResponse('OK');
      }),
    );
    await expect(pingHealthchecks('f1-ingest', log, { secretsDir: dir, timeoutMs: 30 })).resolves.toBeUndefined();
    expect(logged()).toContain('hc_ping_failed');
    expect(logged()).not.toContain(KEY);
  });

  it('swallows a network error and a redirect', async () => {
    key(KEY);
    server.use(http.get('https://hc-ping.com/*', () => HttpResponse.error()));
    await pingHealthchecks('f1-ingest', log, { secretsDir: dir });
    server.use(
      http.get('https://hc-ping.com/*', () => new HttpResponse(null, { status: 302, headers: { location: '/x' } })),
    );
    await pingHealthchecks('f1-ingest', log, { secretsDir: dir });
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(logged()).not.toContain(KEY);
  });
});
