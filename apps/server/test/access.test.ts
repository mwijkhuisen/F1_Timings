import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { HttpResponse } from 'msw';
import pino from 'pino';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, accessConfig } from '../src/api/access.ts';
import { AUD, claims, ISS, jwt, rawJwt, rsaKey, seconds, serveCerts, TEAM } from './jwt.ts';

// The Access JWT middleware on a minimal app; the team's certs come from msw.

const lines: string[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });
const appWith = () => {
  const app = new Hono();
  app.use('/api/*', access({ team: TEAM, aud: AUD }, log));
  app.get('/api/data', (c) => c.json({ data: true }));
  return app;
};
const get = (app: Hono, headers: Record<string, string> = {}) => app.request('/api/data', { headers });
const assertion = (token: string) => ({ 'cf-access-jwt-assertion': token });

type Key = Awaited<ReturnType<typeof rsaKey>>;
let key: Key;
let other: Key; // another key pair under the same kid
let stranger: Key;
let rotated: Key; // the team's next key, under a kid the certs do not hold yet
beforeAll(async () => {
  [key, other, stranger, rotated] = await Promise.all([
    rsaKey('test-kid'),
    rsaKey('test-kid'),
    rsaKey('stranger-kid'),
    rsaKey('rotated-kid'),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  // No log line ever holds a token.
  expect(lines.join('')).not.toMatch(/eyJ/);
});

/**
 * A fake clock at `time` on 2026-10-26 UTC. The first call fakes `Date` (the tokens' claims) and
 * `performance` (the certs' windows); later ones move both forward together.
 */
const at = (time: string) => {
  const to = new Date(`2026-10-26T${time}Z`).getTime();
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(to);
    return;
  }
  expect(to).toBeGreaterThanOrEqual(Date.now());
  vi.advanceTimersByTime(to - Date.now());
};

const expectUnauthorized = async (res: Response) => {
  expect(res.status).toBe(401);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('{"error":"unauthorized"}');
};

describe('accessConfig', () => {
  it('takes CF_ACCESS_TEAM and CF_ACCESS_AUD, or names the one that is missing or malformed', () => {
    expect(accessConfig({ CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD })).toEqual({ team: TEAM, aud: AUD });
    expect(accessConfig({ CF_ACCESS_AUD: AUD })).toBe('CF_ACCESS_TEAM');
    for (const team of ['', 'Test-Team', '-team', 'evil.com/x', 'a.b', `a${'b'.repeat(63)}`])
      expect(accessConfig({ CF_ACCESS_TEAM: team, CF_ACCESS_AUD: AUD })).toBe('CF_ACCESS_TEAM');
    expect(accessConfig({ CF_ACCESS_TEAM: TEAM })).toBe('CF_ACCESS_AUD');
    for (const aud of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), ` ${'a'.repeat(64)}`])
      expect(accessConfig({ CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: aud })).toBe('CF_ACCESS_AUD');
  });
});

describe('access', () => {
  it('a valid token passes: aud as a string or an array holding ours; iat and nbf up to 60 s ahead', async () => {
    const fetches = serveCerts([key.pub, stranger.pub]);
    const app = appWith();
    for (const over of [{}, { aud: AUD }, { aud: ['other', AUD] }, { iat: seconds() + 30 }, { nbf: seconds() + 30 }]) {
      const res = await get(app, assertion(await jwt(key.priv, over)));
      expect(res.status, JSON.stringify(over)).toBe(200);
      expect(await res.json()).toEqual({ data: true });
    }
    expect(fetches.n).toBe(1);
  });

  it('junk is refused before any certs fetch', async () => {
    const fetches = serveCerts([key.pub]);
    const app = appWith();
    const valid = await jwt(key.priv);
    const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
    const junk = [
      undefined,
      '',
      'garbage',
      'a.b.c',
      'eyJhbGciOiJSUzI1NiJ9.e30',
      `Bearer ${valid}`,
      `${valid} ${valid}`, // (Headers trim the ends of a value)
      await rawJwt({ ...header, alg: 'none' }, claims()),
      await sign(claims(), 'a shared secret', 'HS256'),
      await rawJwt({ ...header, alg: 'HS256' }, claims(), key.priv),
      await rawJwt({ alg: 'RS256', typ: 'JWT' }, claims(), key.priv), // no kid
      await rawJwt(null, claims(), key.priv),
    ];
    for (const token of junk) await expectUnauthorized(await get(app, token === undefined ? {} : assertion(token)));
    // A valid token anywhere but Cf-Access-Jwt-Assertion counts for nothing.
    await expectUnauthorized(await get(app, { authorization: `Bearer ${valid}` }));
    await expectUnauthorized(await get(app, { cookie: `CF_Authorization=${valid}` }));
    expect(fetches.n).toBe(0);
  });

  it('refuses a bad claim or signature; an unknown kid within a minute of the fetch, or a jku header, fetches nothing more', async () => {
    const fetches = serveCerts([key.pub]);
    const app = appWith();
    const bad = [
      await jwt(key.priv, { aud: 'b'.repeat(64) }),
      await jwt(key.priv, { aud: ['b'.repeat(64)] }),
      await jwt(key.priv, { aud: undefined }),
      await jwt(key.priv, { iss: 'https://other-team.cloudflareaccess.com' }),
      await jwt(key.priv, { iss: undefined }),
      await jwt(key.priv, { exp: seconds() - 1 }),
      await jwt(key.priv, { exp: undefined }),
      await jwt(key.priv, { exp: String(seconds() + 600) }),
      await jwt(key.priv, { nbf: seconds() + 120 }),
      await jwt(key.priv, { nbf: 'soon' }),
      await jwt(other.priv), // same kid, another key
      await jwt(stranger.priv), // a kid the certs do not hold
      await rawJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'stranger-kid', jku: 'https://jwks.attacker.test/certs' },
        claims(),
        stranger.priv,
      ),
      await rawJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'test-kid', x5u: 'https://x5u.attacker.test/c' },
        claims(),
        other.priv,
      ),
      `${(await jwt(key.priv)).slice(0, -4)}AAAA`,
    ];
    for (const token of bad) await expectUnauthorized(await get(app, assertion(token)));
    expect(fetches.n).toBe(1); // the first request's; never refetched, never another URL (msw fails those)
  });

  describe('an unknown kid (a key rotation)', () => {
    let certs: unknown[];
    let up: boolean;
    let fetches: { n: number };
    let app: Hono;
    const status = async (signer: Key) => (await get(app, assertion(await jwt(signer.priv)))).status;
    beforeEach(async () => {
      certs = [key.pub];
      up = true;
      // The 502 is framed, as the failures below are.
      fetches = serveCerts([], () =>
        up ? HttpResponse.json({ keys: certs }) : HttpResponse.text(null, { status: 502 }),
      );
      app = appWith();
      at('12:00:00');
      expect(await status(key)).toBe(200);
      expect(fetches.n).toBe(1);
    });

    it('refetches once and then verifies, at most once a minute', async () => {
      certs = [key.pub, rotated.pub];
      at('12:00:59');
      expect(await status(rotated)).toBe(401); // the certs are under a minute old
      expect(fetches.n).toBe(1);
      at('12:01:00');
      expect(await status(rotated)).toBe(200);
      expect(fetches.n).toBe(2);
      expect([await status(rotated), await status(key)]).toEqual([200, 200]);
      expect(fetches.n).toBe(2);
    });

    it('a second unknown kid within a minute does not refetch', async () => {
      certs = [key.pub, rotated.pub];
      at('12:02:00');
      expect(await status(rotated)).toBe(200);
      expect(fetches.n).toBe(2);
      at('12:02:59');
      expect(await status(stranger)).toBe(401);
      expect(fetches.n).toBe(2);
      at('12:03:00');
      expect(await status(stranger)).toBe(401); // refetched, and still not in the certs
      expect(fetches.n).toBe(3);
    });

    it('a refetch that fails keeps the keys: a 401, no fetch for 30 s, and stale logged only past 5 min', async () => {
      up = false;
      lines.length = 0;
      at('12:01:00');
      expect(await status(rotated)).toBe(401);
      expect(fetches.n).toBe(2);
      at('12:01:29');
      expect([await status(rotated), await status(key)]).toEqual([401, 200]);
      expect(fetches.n).toBe(2);
      at('12:01:30');
      expect(await status(rotated)).toBe(401);
      expect(fetches.n).toBe(3);
      // Keys under 5 min old: a known kid and an unknown one leave the same log, none.
      expect(lines).toEqual([]);
      at('12:05:00');
      expect([await status(rotated), await status(key)]).toEqual([401, 200]);
      expect(fetches.n).toBe(4);
      const stale = expect.objectContaining({ code: 'access_certs', stale: true });
      expect(lines.map((l) => JSON.parse(l))).toEqual([stale, stale]);
    });
  });

  it('two concurrent cold requests share one certs fetch; the certs are kept for 5 min', async () => {
    at('12:00:00');
    const fetches = serveCerts([key.pub]);
    const app = appWith();
    const token = await jwt(key.priv);
    const both = await Promise.all([get(app, assertion(token)), get(app, assertion(token))]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(fetches.n).toBe(1);
    at('12:04:59');
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect(fetches.n).toBe(1);
    at('12:05:00');
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect(fetches.n).toBe(2);
  });

  // A failure the middleware cancels is framed (HttpResponse.text sets Content-Length), as a real
  // server's is: msw ends an unframed body a tick later, so the cancel would abort the exchange in
  // flight, and fetch then dials again for the aborted request (test/offline.ts closes that one).
  it.each([
    ['a 500', () => HttpResponse.text('boom', { status: 500 })],
    ['a 204', () => new HttpResponse(null, { status: 204 })],
    ['a network error', () => HttpResponse.error()],
    ['no keys', () => HttpResponse.json({ keys: [] })],
    ['an HTML page', () => new HttpResponse('<html></html>', { headers: { 'content-type': 'text/html' } })],
  ])('certs failing with %s → 503, logged as a code; no fetch for 30 s, then one again', async (_, answer) => {
    lines.length = 0;
    const fetches = serveCerts([key.pub], answer);
    const app = appWith();
    at('12:00:00.000');
    const res = await get(app, assertion(await jwt(key.priv)));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"error":"unavailable"}');
    const again = serveCerts([key.pub]);
    at('12:00:29.999'); // the failure is cached: a 503 at once, each logged
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(503);
    const logged = expect.objectContaining({ code: 'access_certs', msg: 'access' });
    expect(lines.map((l) => JSON.parse(l))).toEqual([logged, logged]);
    expect(lines.join('')).not.toMatch(/cloudflareaccess|https?:|boom/);
    expect([fetches.n, again.n]).toEqual([1, 0]);
    at('12:00:30.000');
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect([fetches.n, again.n]).toEqual([1, 1]);
  });

  it('concurrent requests during a failing fetch share it, and all see the 30 s hold', async () => {
    at('12:00:00');
    const fetches = serveCerts([key.pub], () => HttpResponse.text('boom', { status: 500 }));
    const app = appWith();
    const token = await jwt(key.priv);
    const all = await Promise.all([1, 2, 3].map(() => get(app, assertion(token))));
    expect(all.map((r) => r.status)).toEqual([503, 503, 503]);
    expect(fetches.n).toBe(1);
    at('12:00:29');
    expect((await get(app, assertion(token))).status).toBe(503);
    expect(fetches.n).toBe(1);
  });

  it('the windows run on the monotonic clock: a wall clock stepped back changes none', async () => {
    at('12:00:00');
    const fetches = serveCerts([key.pub], () => HttpResponse.text(null, { status: 502 }));
    const app = appWith();
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(503);
    vi.setSystemTime(new Date('2026-10-26T11:00:00Z')); // Date only: performance.now() goes on
    vi.advanceTimersByTime(30_000);
    const again = serveCerts([key.pub]);
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200); // 30 s after the failure
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect([fetches.n, again.n]).toEqual([1, 1]);
    vi.advanceTimersByTime(1);
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200); // 5 min after the fetch
    expect(again.n).toBe(2);
  });

  it('certs entries that are not RSA keys with a kid are skipped; none left → 503', async () => {
    const ec = { kty: 'EC', kid: 'ec-kid', crv: 'P-256', x: 'AAAA', y: 'AAAA' };
    const { kid: _, ...noKid } = stranger.pub;
    const mixed = [ec, noKid, 'not a key', key.pub];
    serveCerts([], () => HttpResponse.json({ keys: mixed }));
    expect((await get(appWith(), assertion(await jwt(key.priv)))).status).toBe(200);
    serveCerts([], () => HttpResponse.json({ keys: [ec, noKid] }));
    expect((await get(appWith(), assertion(await jwt(key.priv)))).status).toBe(503);
  });

  it('a failed refresh after 5 min keeps the last keys for up to 1 h, then 503; a good fetch recovers', async () => {
    let up = true;
    // The 502 is framed, as the failures above are.
    const fetches = serveCerts([key.pub], () =>
      up ? HttpResponse.json({ keys: [key.pub] }) : HttpResponse.text(null, { status: 502 }),
    );
    const app = appWith();
    const status = async () => (await get(app, assertion(await jwt(key.priv)))).status;
    at('12:00:00');
    expect(await status()).toBe(200);
    up = false;
    lines.length = 0;
    at('12:05:00');
    expect(await status()).toBe(200);
    at('12:59:59');
    expect(await status()).toBe(200);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ code: 'access_certs', stale: true }),
      expect.objectContaining({ code: 'access_certs', stale: true }),
    ]);
    at('13:00:00');
    expect(await status()).toBe(503); // the 12:59:59 failure is cached: no fetch
    up = true;
    at('13:00:28');
    expect(await status()).toBe(503);
    expect(fetches.n).toBe(3);
    at('13:00:29'); // 30 s after the last failure
    expect(await status()).toBe(200);
    expect(fetches.n).toBe(4); // 12:00, 12:05, 12:59:59 and 13:00:29
  });

  it('certs that take over 5 s time out → 503', { timeout: 15_000 }, async () => {
    // Held until the client aborts and the interceptor aborts the request, never answered later: a
    // handler still sleeping (msw `delay`) would answer a destroyed socket after the test is over.
    serveCerts(
      [key.pub],
      ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(HttpResponse.error()))),
    );
    const started = Date.now();
    const res = await get(appWith(), assertion(await jwt(key.priv)));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_500);
  });

  it('the issuer is the team; only the team certs URL is ever fetched', async () => {
    expect(ISS).toBe('https://test-team.cloudflareaccess.com');
    const fetches = serveCerts([key.pub]);
    expect((await get(appWith(), assertion(await jwt(key.priv)))).status).toBe(200);
    expect(fetches.n).toBe(1);
  });
});
