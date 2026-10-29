import type { webcrypto } from 'node:crypto';
import { sign } from 'hono/jwt';
import { HttpResponse, http } from 'msw';
import { server } from '../../../test/msw.setup.ts';

// Test-only Cloudflare Access: a made-up team and AUD (never a real one in git), RSA keys made per
// run, and the team's certs endpoint served through msw.

export const TEAM = 'test-team';
export const AUD = 'a'.repeat(64);
export const ISS = `https://${TEAM}.cloudflareaccess.com`;
export const CERTS = `${ISS}/cdn-cgi/access/certs`;

type Jwk = webcrypto.JsonWebKey & { kid: string; alg: 'RS256' };

export async function rsaKey(kid: string): Promise<{ priv: Jwk; pub: Jwk }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = async (key: CryptoKey): Promise<Jwk> => ({
    ...(await crypto.subtle.exportKey('jwk', key)),
    kid,
    alg: 'RS256',
  });
  return { priv: await jwk(pair.privateKey), pub: await jwk(pair.publicKey) };
}

export const seconds = () => Math.floor(Date.now() / 1000);
/** Cloudflare Access's claims, valid now; `over` replaces or (with undefined) removes one. */
export const claims = (over: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries({ iss: ISS, aud: [AUD], sub: 'test-user', iat: seconds(), exp: seconds() + 600, ...over }).filter(
      ([, v]) => v !== undefined,
    ),
  );
/** hono's sign puts the JWK's kid and alg in the header. */
export const jwt = (key: Jwk, over: Record<string, unknown> = {}) => sign(claims(over), key);

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** Any header; signed with `key` (RS256), or unsigned. */
export async function rawJwt(header: unknown, payload: unknown, key?: Jwk) {
  const data = `${part(header)}.${part(payload)}`;
  if (!key) return `${data}.`;
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const signing = await crypto.subtle.importKey('jwk', key, algorithm, false, ['sign']);
  const signature = await crypto.subtle.sign(algorithm, signing, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}

/** Serves the certs (Cloudflare's shape, extra fields included) and counts the fetches. */
export function serveCerts(keys: Jwk[], answer?: (request: Request) => Response | Promise<Response>) {
  const fetches = { n: 0 };
  server.use(
    http.get(CERTS, ({ request }) => {
      fetches.n++;
      return answer?.(request) ?? HttpResponse.json({ keys, public_cert: { kid: 'x', cert: 'PEM' }, public_certs: [] });
    }),
  );
  return fetches;
}
