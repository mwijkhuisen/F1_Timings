import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { HttpResponse } from 'msw';
import pino from 'pino';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
beforeAll(async () => {
  [key, other, stranger] = await Promise.all([rsaKey('test-kid'), rsaKey('test-kid'), rsaKey('stranger-kid')]);
});
afterEach(() => {
  vi.useRealTimers();
  // No log line ever holds a token.
  expect(lines.join('')).not.toMatch(/eyJ/);
});

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

  it('refuses a bad claim or signature; an unknown kid or a jku header fetches nothing more', async () => {
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

  it('two concurrent cold requests share one certs fetch; the certs are kept for 5 min', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const fetches = serveCerts([key.pub]);
    const app = appWith();
    const token = await jwt(key.priv);
    const both = await Promise.all([get(app, assertion(token)), get(app, assertion(token))]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(fetches.n).toBe(1);
    vi.setSystemTime(new Date('2026-10-26T12:04:59Z'));
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect(fetches.n).toBe(1);
    vi.setSystemTime(new Date('2026-10-26T12:05:00Z'));
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect(fetches.n).toBe(2);
  });

  it.each([
    ['a 500', () => new HttpResponse('boom', { status: 500 })],
    ['a 204', () => new HttpResponse(null, { status: 204 })],
    ['a network error', () => HttpResponse.error()],
    ['no keys', () => HttpResponse.json({ keys: [] })],
    ['an HTML page', () => new HttpResponse('<html></html>', { headers: { 'content-type': 'text/html' } })],
  ])('certs failing with %s → 503, logged as a code; the next request fetches again', async (_, answer) => {
    lines.length = 0;
    const fetches = serveCerts([key.pub], answer);
    const app = appWith();
    const res = await get(app, assertion(await jwt(key.priv)));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"error":"unavailable"}');
    expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ code: 'access_certs', msg: 'access' })]);
    expect(lines.join('')).not.toMatch(/cloudflareaccess|https?:|boom/);
    const again = serveCerts([key.pub]);
    expect((await get(app, assertion(await jwt(key.priv)))).status).toBe(200);
    expect([fetches.n, again.n]).toEqual([1, 1]);
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
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = (time: string) => vi.setSystemTime(new Date(`2026-10-26T${time}Z`));
    let up = true;
    const fetches = serveCerts([key.pub], () =>
      up ? HttpResponse.json({ keys: [key.pub] }) : new HttpResponse(null, { status: 502 }),
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
    expect(await status()).toBe(503);
    up = true;
    expect(await status()).toBe(200);
    expect(fetches.n).toBe(5); // one per request past the TTL: no negative cache (ponytail)
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
