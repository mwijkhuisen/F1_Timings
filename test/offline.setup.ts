import dns from 'node:dns';
import { isIP } from 'node:net';

// Unit tests only: no hostname resolves, so no test can reach a real host by name (A§12.1 invariant 4).
// msw answers or fails every HTTP request it sees, but it passes a connection that carries no
// request through to the real host. Node's fetch opens one after an aborted request (a timeout,
// a cancelled body): it dials again for the aborted request, then drops it unsent. Such a connection
// now fails at its lookup, before anything can reuse it. msw's own connections never look up a
// name. An IP or `localhost` still resolves, for the loopback servers some tests start.
//
// Never undone: every test file gets a fresh worker (`isolate`), and undoing it in `afterAll` would
// let through a connection that msw passes on while the file's last hooks run.

// The CommonJS object that net reads `lookup` from; an `import * as` binding cannot be replaced.
const realLookup = dns.lookup;
const offlineLookup = (hostname: string, ...rest: unknown[]) => {
  if (isIP(hostname) !== 0 || hostname === 'localhost') return Reflect.apply(realLookup, dns, [hostname, ...rest]);
  const callback = rest.at(-1);
  if (typeof callback !== 'function') throw new TypeError('dns.lookup needs a callback');
  const message = `unit tests run offline: ${hostname} does not resolve (test/offline.setup.ts)`;
  const error = Object.assign(new Error(message), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname });
  process.nextTick(callback, error);
};
Reflect.set(dns, 'lookup', offlineLookup);
