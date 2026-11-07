import dns from 'node:dns';
import { once } from 'node:events';
import { type AddressInfo, connect, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from './msw.setup.ts';
import { isLoopback, offline } from './offline.ts';

// The proof for test/offline.ts: what the guard refuses and lets through, that a refusal fails the test, and that an
// aborted fetch under msw leaves no connection to the real host behind.

const lookup = (hostname: string) =>
  new Promise<string>((resolve, reject) => {
    dns.lookup(hostname, (error, address) => (error ? reject(error) : resolve(address)));
  });
const attempts = () => offline.take().map(({ kind, target }) => `${kind} ${target}`);

describe('the guard, with msw closed (real sockets)', () => {
  beforeAll(() => server.close());
  afterAll(() => server.listen({ onUnhandledFrame: 'error' }));

  it('refuses a lookup of any name but localhost, before a query is sent', async () => {
    await expect(lookup('api.openf1.org')).rejects.toMatchObject({ code: 'ENOTFOUND', hostname: 'api.openf1.org' });
    await expect(dns.promises.lookup('livetiming.formula1.com')).rejects.toThrow('refused: tests run offline');
    expect(offline.take()).toEqual([
      { kind: 'lookup', target: 'api.openf1.org', test: expect.stringContaining('refuses a lookup') },
      { kind: 'lookup', target: 'livetiming.formula1.com', test: expect.stringContaining('refuses a lookup') },
    ]);
  });

  it('refuses a TCP connect outside loopback, IPv4 and IPv6', async () => {
    for (const host of ['192.0.2.1', '2001:db8::1']) {
      const [error] = await once(connect({ host, port: 443 }), 'error');
      expect(error).toMatchObject({ code: 'ECONNREFUSED', address: host, port: 443 });
    }
    expect(attempts()).toEqual(['connect 192.0.2.1:443', 'connect [2001:db8::1]:443']);
  });

  it('a fetch to OpenF1 fails without leaving the machine', async () => {
    await expect(fetch('https://api.openf1.org/v1/sessions')).rejects.toThrow('fetch failed');
    expect(attempts()).toEqual(['lookup api.openf1.org']);
  });

  it('lets loopback through: 127.0.0.1 and localhost', async () => {
    const listener = createServer((socket) => socket.end());
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as AddressInfo;
    try {
      for (const host of ['127.0.0.1', 'localhost']) {
        const socket = connect({ host, port, family: 4 });
        await once(socket, 'connect');
        socket.destroy();
      }
      expect(isLoopback(await lookup('localhost'))).toBe(true);
    } finally {
      listener.close();
    }
    expect(attempts()).toEqual([]);
  });

  it('check() fails with every refused attempt and the test that made it, then starts over', async () => {
    await expect(lookup('hc-ping.com')).rejects.toThrow('refused');
    expect(() => offline.check()).toThrow(
      /test\/offline\.ts refused:\n {2}lookup hc-ping\.com \(in ".*check\(\) fails with every refused attempt/,
    );
    expect(() => offline.check()).not.toThrow();
  });
});

describe('an aborted fetch under msw (mswjs/interceptors#881)', () => {
  // A 502 without a body has no length, so cancelling it aborts the request mid-response, as access.ts does.
  const url = 'https://certs.example.test/cdn-cgi/access/certs';
  let answered = 0;
  beforeEach(() => {
    answered = 0;
    server.use(
      http.get(url, () => {
        answered++;
        return new HttpResponse(null, { status: 502 });
      }),
    );
  });
  const abortedFetch = async () => {
    const res = await fetch(url);
    await res.body?.cancel();
    await sleep(20); // past undici's reconnect and msw's read-before-write check one setImmediate later
  };

  it('leaves no connection to the real host behind, and the next fetch is answered', async () => {
    await abortedFetch();
    const res = await fetch(url);
    await res.arrayBuffer();
    expect([res.status, answered]).toEqual([502, 2]);
    expect(attempts()).toEqual([]);
  });

  it('without the idle-reconnect close, msw passes the connection through to the real host', async () => {
    offline.closeIdleReconnects(false);
    try {
      await abortedFetch();
    } finally {
      offline.closeIdleReconnects(true);
    }
    // Nothing attempted means msw no longer passes an idle connection through: drop that part of test/offline.ts.
    expect(attempts()).toEqual(['lookup certs.example.test']);
  });
});
