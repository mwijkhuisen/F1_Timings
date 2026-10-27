import type { Context, MiddlewareHandler } from 'hono';
import { decode, verifyWithJwks } from 'hono/jwt';
import type { Logger } from 'pino';
import { z } from 'zod';

// The Cloudflare Access gate on /api (ADR-0004, A§10): the only one, so it fails closed.
// Not hono/jwk: that middleware wants `Bearer <token>`, and Cloudflare sends the bare JWT in
// Cf-Access-Jwt-Assertion. Every refusal is the same 401 with no reason, in the body or the log.

type Env = Readonly<Record<string, string | undefined>>;
export type AccessConfig = { team: string; aud: string };

/** `/etc/f1/f1.env` (not secrets): the Access team, and the AUD tag of the application. */
export function accessConfig(env: Env): AccessConfig | string {
  const { CF_ACCESS_TEAM: team, CF_ACCESS_AUD: aud } = env;
  // A strict team name keeps the certs URL on cloudflareaccess.com.
  if (team === undefined || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(team)) return 'CF_ACCESS_TEAM';
  if (aud === undefined || !/^[0-9a-f]{64}$/.test(aud)) return 'CF_ACCESS_AUD';
  return { team, aud };
}

// Not strict: Cloudflare also sends public_cert/public_certs, and may add fields.
const Jwks = z.object({
  keys: z.array(z.looseObject({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string() })).min(1),
});
type Keys = z.infer<typeof Jwks>['keys'];

const CERTS_TTL_MS = 5 * 60_000;
const CERTS_TIMEOUT_MS = 5_000;
const NBF_LEEWAY_S = 60;

const unauthorized = (c: Context) => c.json({ error: 'unauthorized' }, 401, { 'Cache-Control': 'no-store' });

/** RS256 with a kid, checked before any certs fetch: junk never triggers one. */
const rs256 = (token: string) => {
  try {
    const { header } = decode(token);
    return header.alg === 'RS256' && typeof header.kid === 'string';
  } catch {
    return false;
  }
};

export function access({ team, aud }: AccessConfig, log: Pick<Logger, 'error'>): MiddlewareHandler {
  const iss = `https://${team}.cloudflareaccess.com`;
  // ponytail: a key rotation can 401 for up to 5 min (fix: refetch on an unknown kid, rate-limited),
  // and a failure is not cached (fix: 30 s if unauthenticated traffic ever reaches the origin past Access).
  let certs: { keys: Promise<Keys>; at: number } | undefined;
  const keys = () => {
    if (certs === undefined || Date.now() - certs.at >= CERTS_TTL_MS) {
      // The promise is cached: concurrent cold requests share one fetch.
      const pending = fetch(`${iss}/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
        redirect: 'error',
      }).then(async (res) => {
        if (res.status !== 200) {
          await res.body?.cancel();
          throw new Error('certs');
        }
        return Jwks.parse(await res.json()).keys;
      });
      certs = { keys: pending, at: Date.now() };
      pending.catch(() => {
        if (certs?.keys === pending) certs = undefined;
      });
    }
    return certs.keys;
  };

  return async (c, next) => {
    // The bare JWT; Authorization and cookies are ignored.
    const token = c.req.header('cf-access-jwt-assertion');
    if (token === undefined || token === '' || /\s/.test(token) || !rs256(token)) return unauthorized(c);
    let known: Keys;
    try {
      known = await keys();
    } catch {
      log.error({ code: 'access_certs' }, 'access');
      return c.json({ error: 'unavailable' }, 503, { 'Cache-Control': 'no-store' });
    }
    try {
      // Our keys only, never jwks_uri: a token's jku/x5u is never followed. hono checks the
      // signature, the kid, exp when present, iss and aud (a string or an array holding ours).
      const payload = await verifyWithJwks(token, {
        keys: known,
        allowedAlgorithms: ['RS256'],
        verification: { iss, aud, iat: false, nbf: false },
      });
      // hono skips an absent exp. iat is not checked: hono has no leeway, and a clock 1 s behind
      // would refuse fresh logins; exp and nbf cover freshness.
      const now = Date.now() / 1000;
      const { exp, nbf } = payload;
      if (typeof exp !== 'number' || !Number.isFinite(exp)) return unauthorized(c);
      if (nbf !== undefined && (typeof nbf !== 'number' || !(nbf <= now + NBF_LEEWAY_S))) return unauthorized(c);
    } catch {
      return unauthorized(c);
    }
    await next();
  };
}
