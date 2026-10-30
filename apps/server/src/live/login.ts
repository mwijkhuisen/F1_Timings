/*
 * MIT License
 *
 * Copyright (c) 2026 Philipp Schäfer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Ports FastF1 3.9.0 fastf1/internals/f1account/{common,discovery,login,tokens}.py (the sign-in, not the token file).
// The F1 TV login (A§12.3, ADR-0005). Credentials come only from the file secrets; no credential, token, flow value
// or server text reaches an error (A§12.1 #1): fixed codes only.

import { createHash, randomBytes } from 'node:crypto';
import { readSecret } from '../db/migrate.ts';

const ACCOUNT = 'https://account.formula1.com';
const IDP = 'https://id.formula1.com';
const TIMEOUT_MS = 30_000;
// FastF1's hard-coded UA. FastF1 also fetches a current UA list from a third-party host; this never does.
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
// DaVinci answers with JSON instead of HTML pages.
const PING_SDK = { 'X-Requested-With': 'ping-sdk' };

export type Credentials = { username: string; password: string };
/** Epoch ms. `value` is the subscriptionToken, the archive's and live feed's Bearer token (A§12.3). */
export type Token = { value: string; expiresAt: number };
/** The `login_*` values of `recorder_status.last_error`. */
export type LoginCode = 'login_discovery' | 'login_authorize' | 'login_signin' | 'login_token' | 'login_claims';

/** Both file secrets; undefined when either is missing or empty. */
export function credentials(dir?: string): Credentials | undefined {
  const username = readSecret('f1tv_username', dir);
  const password = readSecret('f1tv_password', dir);
  return username && password ? { username, password } : undefined;
}

/** A fixed code and at most an HTTP status number: never a body, a URL or DaVinci's own status text. */
export class LoginError extends Error {
  code: LoginCode;
  status: number | undefined;
  constructor(code: LoginCode, status?: number) {
    super(`F1 TV login failed: ${code}`);
    this.name = 'LoginError';
    this.code = code;
    this.status = status;
  }
}

type Answer = { status: number; ok: boolean; text: string };
type Init = { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams };
type Call = (code: LoginCode, url: string, init?: Init) => Promise<Answer>;

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // a SyntaxError quotes the body
  }
};
const random = (bytes: number) => randomBytes(bytes).toString('base64url');

/** One cookie session for every step: the IdP ties the steps of the flow together through cookies. */
function session(): Call {
  // ponytail: keeps name=value pairs only and ignores Domain/Path/expiry, because the flow needs them only for
  // id.formula1.com within one minute. A real jar when the token step moves elsewhere or the flow gets slow.
  const jar = new Map<string, string>();
  return async (code, url, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    try {
      const res = await fetch(url, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: { ...BROWSER, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return { status: res.status, ok: res.ok, text: await res.text() };
    } catch {
      // Not the error: a fetch error may carry the URL, and the authorize URL holds the state and nonce.
      throw new LoginError(code);
    }
  };
}

/** The client id and DaVinci policy are app settings F1 may change: read them from the public frontend config. */
async function discover(call: Call) {
  const r = await call('login_discovery', `${ACCOUNT}/scripts/main.min.js`);
  if (!r.ok) throw new LoginError('login_discovery', r.status);
  const obj = /\bdavinci:\{([^}]*)\}/.exec(r.text)?.[1] ?? ''; // a flat object: no braces inside
  const field = (name: string) => new RegExp(`\\b${name}:"([^"]+)"`).exec(obj)?.[1];
  return { clientId: field('clientId'), acrValues: field('acrValues') };
}

async function authorize(call: Call, clientId: string, acrValues: string) {
  const verifier = random(64);
  const state = random(24);
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    response_mode: 'pi.flow', // redirectless: every step is a JSON call
    scope: 'openid', // the subscription token comes with any scope
    state,
    nonce: random(24),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    acr_values: acrValues, // selects the DaVinci flow
  });
  return { ...(await call('login_authorize', `${IDP}/as/authorize?${query}`, { headers: PING_SDK })), verifier, state };
}

type Form = { _links?: { next?: { href?: unknown } }; interactionId?: unknown; id?: unknown; eventName?: unknown };
type Flow = { status?: unknown; authorizeResponse?: { state?: unknown; code?: unknown } };

/** Unverified claims: the token is only read here, the F1 APIs verify it. */
function claimsOf(jwt: string): Record<string, unknown> | undefined {
  const p = json(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined;
}

export async function login(c: Credentials): Promise<Token> {
  const call = session();
  const { clientId, acrValues } = await discover(call);
  if (!clientId || !acrValues) throw new LoginError('login_discovery');

  const auth = await authorize(call, clientId, acrValues);
  if (!auth.ok) throw new LoginError('login_authorize', auth.status);
  const form = json(auth.text) as Form | undefined;
  const href = form?._links?.next?.href;
  const { interactionId, id, eventName } = form ?? {};
  if (
    typeof href !== 'string' ||
    typeof interactionId !== 'string' ||
    typeof id !== 'string' ||
    typeof eventName !== 'string'
  ) {
    throw new LoginError('login_authorize');
  }
  // Never send the credentials anywhere else.
  if (!href.startsWith(`${IDP}/`)) throw new LoginError('login_authorize');

  const signin = await call('login_signin', href, {
    method: 'POST',
    headers: { ...PING_SDK, interactionId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      eventName,
      interactionId,
      parameters: {
        eventType: 'submit',
        data: { actionKey: 'SIGNIN', formData: { username: c.username, password: c.password } },
      },
    }),
  });
  const flow = json(signin.text) as Flow | undefined;
  // DaVinci's `status` and `message` (wrong credentials, say) are never passed on.
  if (flow?.status !== 'COMPLETED') throw new LoginError('login_signin', signin.status);
  if (flow.authorizeResponse?.state !== auth.state) throw new LoginError('login_signin');
  const code = flow.authorizeResponse?.code;
  if (typeof code !== 'string' || code === '') throw new LoginError('login_signin');

  const token = await call('login_token', `${IDP}/as/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: auth.verifier,
    }),
  });
  if (!token.ok) throw new LoginError('login_token', token.status);
  const access = (json(token.text) as { access_token?: unknown } | undefined)?.access_token;
  if (typeof access !== 'string') throw new LoginError('login_token');

  // No refresh token: once it expires, the login runs again (ADR-0005).
  const value = claimsOf(access)?.subscriptionToken;
  if (typeof value !== 'string' || value === '') throw new LoginError('login_claims');
  const exp = claimsOf(value)?.exp;
  if (typeof exp !== 'number') throw new LoginError('login_claims');
  return { value, expiresAt: exp * 1000 };
}
