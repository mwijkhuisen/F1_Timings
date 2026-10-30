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
// Throwaway P2a spike (issue #10): the F1 TV login (A§12.3, ADR-0005) plus an archive probe (A§6.2). Credentials
// come only from the file secrets; nothing is written to disk, and no credential, token or flow value is printed
// or put in an error (A§12.1 #1).

import { createHash, randomBytes } from 'node:crypto';
import { readSecret } from '../../apps/server/src/db/migrate.ts';

export const SECRETS_DIR = '/etc/f1/secrets';
const SECRETS = ['f1tv_username', 'f1tv_password'];
const ACCOUNT = 'https://account.formula1.com';
const IDP = 'https://id.formula1.com';
const ARCHIVE = 'https://livetiming.formula1.com/static';
const TIMEOUT_MS = 30_000;
// FastF1's hard-coded UA. FastF1 also fetches a current UA list from a third-party host; this never does.
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
// DaVinci answers with JSON instead of HTML pages.
const PING_SDK = { 'X-Requested-With': 'ping-sdk' };

export type Credentials = { username: string; password: string };

/** Both A4 file secrets via readSecret; undefined when either is missing. */
export function credentials(dir = SECRETS_DIR): Credentials | undefined {
  const username = readSecret('f1tv_username', dir);
  const password = readSecret('f1tv_password', dir);
  return username && password ? { username, password } : undefined;
}

/** Epoch ms. `value` is the subscriptionToken, the archive's and live feed's Bearer token (A§12.3). */
export type Token = { value: string; expiresAt: number; issuedAt: number | undefined; claimNames: string[] };

type Step = 'discovery' | 'authorize' | 'signin' | 'token' | 'claims';

/** Fixed text from the step and a status (HTTP status, DaVinci `status` or a fixed word), never a body or URL. */
export class LoginError extends Error {
  step: Step;
  status: string | undefined;
  constructor(step: Step, status?: number | string) {
    const s = status === undefined ? undefined : /^[\w .-]{1,40}$/.test(String(status)) ? String(status) : 'unexpected';
    super(`F1 TV login failed at ${step}${s === undefined ? '' : ` (${s})`}`);
    this.name = 'LoginError';
    this.step = step;
    this.status = s;
  }
}

type Answer = { status: number; ok: boolean; text: string };
type Init = { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams };
type Call = (step: Step, url: string, init?: Init) => Promise<Answer>;

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
  return async (step, url, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    try {
      const res = await fetch(url, {
        method: init.method,
        body: init.body,
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
    } catch (err) {
      // Only a fixed word: a fetch error may carry the URL, and the authorize URL holds the state and nonce.
      throw new LoginError(step, (err as Error).name === 'TimeoutError' ? 'timeout' : 'network');
    }
  };
}

/** The client id and DaVinci policy are app settings F1 may change: read them from the public frontend config. */
async function discover(call: Call) {
  const r = await call('discovery', `${ACCOUNT}/scripts/main.min.js`);
  if (!r.ok) throw new LoginError('discovery', r.status);
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
  return { ...(await call('authorize', `${IDP}/as/authorize?${query}`, { headers: PING_SDK })), verifier, state };
}

type Form = { _links?: { next?: { href?: unknown } }; interactionId?: unknown; id?: unknown; eventName?: unknown };
type Flow = { status?: unknown; authorizeResponse?: { state?: unknown; code?: unknown } };

/** Unverified claims: the token is only read here, the F1 APIs verify it. */
function payload(jwt: string): Record<string, unknown> | undefined {
  const p = json(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined;
}

export async function login(c: Credentials): Promise<Token> {
  const call = session();
  const { clientId, acrValues } = await discover(call);
  if (!clientId || !acrValues) throw new LoginError('discovery', 'no davinci config');

  const auth = await authorize(call, clientId, acrValues);
  if (!auth.ok) throw new LoginError('authorize', auth.status);
  const form = json(auth.text) as Form | undefined;
  const href = form?._links?.next?.href;
  const { interactionId, id, eventName } = form ?? {};
  if (
    typeof href !== 'string' ||
    typeof interactionId !== 'string' ||
    typeof id !== 'string' ||
    typeof eventName !== 'string'
  ) {
    throw new LoginError('authorize', 'unexpected form');
  }
  // Never send the credentials anywhere else.
  if (!href.startsWith(`${IDP}/`)) throw new LoginError('authorize', 'foreign sign-in url');

  const signin = await call('signin', href, {
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
  // DaVinci's `message` (wrong credentials, say) is never passed on, only its status.
  if (flow?.status !== 'COMPLETED') {
    throw new LoginError('signin', typeof flow?.status === 'string' ? flow.status : signin.status);
  }
  if (flow.authorizeResponse?.state !== auth.state) throw new LoginError('signin', 'state mismatch');
  const code = flow.authorizeResponse?.code;
  if (typeof code !== 'string' || code === '') throw new LoginError('signin', 'no code');

  const token = await call('token', `${IDP}/as/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: auth.verifier,
    }),
  });
  if (!token.ok) throw new LoginError('token', token.status);
  const access = (json(token.text) as { access_token?: unknown } | undefined)?.access_token;
  if (typeof access !== 'string') throw new LoginError('token', 'no access_token');

  // No refresh token: once it expires, the login runs again (ADR-0005).
  const value = payload(access)?.subscriptionToken;
  if (typeof value !== 'string' || value === '') throw new LoginError('claims', 'no subscriptionToken');
  const claims = payload(value);
  if (typeof claims?.exp !== 'number') throw new LoginError('claims', 'no exp');
  return {
    value,
    expiresAt: claims.exp * 1000,
    issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : undefined,
    claimNames: Object.keys(claims),
  };
}

// The CLI. It prints statuses, sizes, counts and names only: archive content is F1 TV data (A§12.1 #3).

const hours = (ms: number) => (ms / 3_600_000).toFixed(1);

async function archive(label: string, path: string, token?: string) {
  const res = await fetch(`${ARCHIVE}/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  console.log(`archive ${label} ${token ? 'with' : 'without'} token: ${res.status}, ${body.length} bytes`);
  return { status: res.status, body };
}

type Index = { Meetings?: { Sessions?: { Path?: unknown; StartDate?: unknown }[] }[] };

async function probe(token?: string) {
  let index = await archive('2026/Index.json', '2026/Index.json');
  if (token) index = await archive('2026/Index.json', '2026/Index.json', token);
  if (index.status !== 200) return;
  // TextDecoder drops the leading UTF-8 BOM the archive files carry.
  const data = json(new TextDecoder().decode(index.body)) as Index | undefined;
  if (data === undefined) return console.log('archive index: not JSON');
  const meetings = Array.isArray(data?.Meetings) ? data.Meetings : [];
  const sessions = meetings.flatMap((m) => (Array.isArray(m?.Sessions) ? m.Sessions : []));
  console.log(`archive index: ${meetings.length} meetings, ${sessions.length} sessions`);
  // StartDate is local time without an offset: good enough to skip sessions that have not started.
  const latest = sessions
    .filter((s) => typeof s?.Path === 'string' && !(Date.parse(String(s.StartDate)) > Date.now()))
    .sort((a, b) => String(a.StartDate ?? '').localeCompare(String(b.StartDate ?? '')))
    .at(-1);
  if (latest) await archive('SessionInfo.json of the latest session', `${latest.Path}SessionInfo.json`, token);
}

async function main(): Promise<number> {
  const c = credentials();
  if (!c) {
    const missing = SECRETS.filter((name) => readSecret(name, SECRETS_DIR) === undefined);
    console.log(`missing or unreadable in ${SECRETS_DIR}: ${missing.join(', ')}`);
    // A pre-check that needs no credentials: discovery and the start of the flow.
    const call = session();
    const { clientId, acrValues } = await discover(call);
    console.log(
      `discovery ok: clientId ${clientId ? 'found' : 'missing'}, acrValues ${acrValues ? 'found' : 'missing'}`,
    );
    if (clientId && acrValues) {
      const auth = await authorize(call, clientId, acrValues);
      const answer = json(auth.text);
      const keys = answer !== null && typeof answer === 'object' ? Object.keys(answer).join(', ') : 'not a JSON object';
      console.log(`authorize: ${auth.status}, keys: ${keys}`);
    }
    await probe();
    return 78;
  }
  const token = await login(c);
  const lifetime = token.issuedAt === undefined ? '' : `, lifetime ${hours(token.expiresAt - token.issuedAt)} h`;
  console.log('login ok');
  console.log(
    `expires ${new Date(token.expiresAt).toISOString()}${lifetime}, ${hours(token.expiresAt - Date.now())} h left`,
  );
  console.log(`claim names: ${token.claimNames.join(', ')}`);
  await probe(token.value);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (err) {
    if (err instanceof LoginError) console.error(err.message);
    else {
      const e = err as { name?: unknown; cause?: { code?: unknown } } | undefined;
      console.error(`failed: ${String(e?.name)}${e?.cause?.code === undefined ? '' : ` (${String(e.cause.code)})`}`);
    }
    process.exitCode = 1;
  }
}
