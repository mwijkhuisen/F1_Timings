import dns from 'node:dns';
import { BlockList, isIP, Socket } from 'node:net';
import { getSystemErrorMap } from 'node:util';
import { expect } from 'vitest';

// Tests run offline (A§12.1 invariant 4): nothing past loopback. msw answers HTTP and WebSocket, but msw 3 intercepts
// at the socket level and passes a connection it cannot read as HTTP through to the real host. test/msw.setup.ts
// installs this once per process, for every file of both projects:
//
// - The guard. A DNS lookup of any name but `localhost` and a TCP connect to any address outside 127.0.0.0/8 and ::1
//   are refused before anything leaves the process, and recorded. Every HTTP and WebSocket client in Node goes through
//   these two (nothing here uses UDP or c-ares queries). msw.setup.ts calls `check()` after each test and each file,
//   which fails with what was refused: a refused request alone can pass unnoticed (a fire-and-forget ping swallows it).
//
// Until msw 3.0.6 (@mswjs/interceptors 0.45.12, mswjs/interceptors#881) this also closed the idle connection undici
// opens after an aborted request, which msw passed through to the real host; offline.test.ts keeps that case.

export type Attempt = { kind: 'lookup' | 'connect'; target: string; test: string | undefined };
type Guard = { attempts: Attempt[]; currentTest: () => string | undefined };

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** 127.0.0.0/8 or ::1, IPv4-mapped forms included. */
export function isLoopback(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
const isLocalhost = (name: string) => /^localhost\.?$/i.test(name);

function install(): Guard {
  const guard: Guard = { attempts: [], currentTest: () => undefined };
  const record = (kind: Attempt['kind'], target: string) => {
    guard.attempts.push({ kind, target, test: guard.currentTest() });
  };

  // Lookups: net resolves every host name through dns.lookup unless the caller passes its own lookup. An IP literal,
  // `localhost` (the hosts file) and an empty or invalid argument go to the real one, which sends no query for them.
  const needsQuery = (hostname: unknown): hostname is string =>
    typeof hostname === 'string' && hostname !== '' && isIP(hostname) === 0 && !isLocalhost(hostname);
  const refused = (hostname: string) => {
    record('lookup', hostname);
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (refused: tests run offline)`), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname,
    });
  };
  const realLookup = dns.lookup;
  Reflect.set(dns, 'lookup', function lookup(this: unknown, hostname: unknown, ...rest: unknown[]) {
    const callback = rest.at(-1);
    if (!needsQuery(hostname) || typeof callback !== 'function') {
      return Reflect.apply(realLookup, this, [hostname, ...rest]);
    }
    process.nextTick(callback, refused(hostname));
    return {};
  });
  const realPromisesLookup = dns.promises.lookup;
  Reflect.set(dns.promises, 'lookup', async function lookup(this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (needsQuery(hostname)) throw refused(hostname);
    return Reflect.apply(realPromisesLookup, this, [hostname, ...rest]);
  });

  // Connects: net hands every TCP connect, address resolved, to its handle's connect or connect6. msw's mocked sockets
  // replace those two on their own handle, so only a real connection reaches the prototype. A probe socket yields the
  // prototype (its lookup never answers, so it connects nothing).
  const probe = new Socket();
  probe.connect({ host: 'probe.invalid', port: 9, lookup: () => {} });
  const tcp: object = Object.getPrototypeOf(Reflect.get(probe, '_handle'));
  probe.destroy();
  const ECONNREFUSED = [...getSystemErrorMap()].find(([, [name]]) => name === 'ECONNREFUSED')?.[0];
  for (const method of ['connect', 'connect6']) {
    const real: unknown = Reflect.get(tcp, method);
    if (typeof real !== 'function' || ECONNREFUSED === undefined) throw new Error(`offline: no TCP ${method} to guard`);
    const guarded = function (this: unknown, request: unknown, address: string, port: number, ...rest: unknown[]) {
      if (isLoopback(address)) return Reflect.apply(real, this, [request, address, port, ...rest]);
      record('connect', method === 'connect6' ? `[${address}]:${port}` : `${address}:${port}`);
      return ECONNREFUSED; // a libuv error code: net raises `connect ECONNREFUSED <address>:<port>`
    };
    Reflect.set(tcp, method, guarded);
  }
  return guard;
}

// One guard per process, whichever test file's copy of this module comes first.
const KEY = Symbol.for('f1.test.offline');
const guard: Guard = (Reflect.get(process, KEY) as Guard | undefined) ?? install();
Reflect.set(process, KEY, guard);
guard.currentTest = () => expect.getState().currentTestName;

export const offline = {
  /** The attempts refused since the last take or check, oldest first; clears them. */
  take: (): Attempt[] => guard.attempts.splice(0),
  /** Throws with every attempt refused since the last take or check (msw.setup.ts, after each test and file). */
  check(): void {
    const attempts = guard.attempts.splice(0);
    if (attempts.length === 0) return;
    const lines = attempts.map(({ kind, target, test }) => `  ${kind} ${target}${test ? ` (in "${test}")` : ''}`);
    throw new Error(
      [
        'Tests run offline (A§12.1 invariant 4); test/offline.ts refused:',
        ...lines,
        'Answer the request with an msw handler, or use a loopback server.',
      ].join('\n'),
    );
  },
};
