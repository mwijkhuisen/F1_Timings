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

// Not strict: Cloudflare also sends public_cert/public_certs, and may add fields or other key types.
const Jwks = z.object({ keys: z.array(z.unknown()) });
const RsaKey = z.looseObject({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string() });
type Key = z.infer<typeof RsaKey>;

const CERTS_TTL_MS = 5 * 60_000;
const CERTS_KID_MS = 60_000; // an unknown kid refetches at most this often (a key rotation)
const CERTS_RETRY_MS = 30_000; // a failed fetch is not tried again sooner
const CERTS_STALE_MS = 60 * 60_000;
const CERTS_TIMEOUT_MS = 5_000;
const NBF_LEEWAY_S = 60;

const unauthorized = (c: Context) => c.json({ error: 'unauthorized' }, 401, { 'Cache-Control': 'no-store' });

/** The kid of an RS256 header, checked before any certs fetch: junk never triggers one. */
const rs256Kid = (token: string) => {
  try {
    const { header } = decode(token);
    return header.alg === 'RS256' && typeof header.kid === 'string' ? header.kid : undefined;
  } catch {
    return undefined;
  }
};

export function access({ team, aud }: AccessConfig, log: Pick<Logger, 'error'>): MiddlewareHandler {
  const iss = `https://${team}.cloudflareaccess.com`;
  let good: { keys: Key[]; at: number } | undefined; // the last certs fetched
  let failed = Number.NEGATIVE_INFINITY; // when the last fetch failed
  let pending: Promise<Key[]> | undefined; // one fetch, shared by concurrent requests
  const fetchCerts = async () => {
    const res = await fetch(`${iss}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error('certs');
    }
    // The RSA keys with a kid; any other entry is skipped, and none at all is a failure.
    const keys = Jwks.parse(await res.json()).keys.flatMap((key) => {
      const rsa = RsaKey.safeParse(key);
      return rsa.success ? [rsa.data] : [];
    });
    if (keys.length === 0) throw new Error('certs');
    good = { keys, at: Date.now() };
    return keys;
  };
  /**
   * Keys under 5 min old that hold the token's kid, or any under 1 min old (an unknown kid refetches
   * at most once a minute); else a refetch, unless the last one failed under 30 s ago. Without one,
   * or when it fails, keys under 1 h old; else it throws (503).
   */
  const keys = async (kid: string) => {
    const at = Date.now();
    const age = good ? at - good.at : Number.POSITIVE_INFINITY;
    if (good && (age < CERTS_KID_MS || (age < CERTS_TTL_MS && good.keys.some((k) => k.kid === kid)))) return good.keys;
    try {
      if (at - failed < CERTS_RETRY_MS) throw new Error('certs');
      pending ??= fetchCerts()
        .catch((err: unknown) => {
          failed = Date.now(); // seen by every request that shares this fetch
          throw err;
        })
        .finally(() => {
          pending = undefined;
        });
      return await pending;
    } catch (err) {
      if (!good || age >= CERTS_STALE_MS) throw err;
      log.error({ code: 'access_certs', stale: true }, 'access');
      return good.keys;
    }
  };

  return async (c, next) => {
    // The bare JWT; Authorization and cookies are ignored.
    const token = c.req.header('cf-access-jwt-assertion');
    const kid = token === undefined || token === '' || /\s/.test(token) ? undefined : rs256Kid(token);
    if (token === undefined || kid === undefined) return unauthorized(c);
    let known: Key[];
    try {
      known = await keys(kid);
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
