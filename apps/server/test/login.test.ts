import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { credentials, LoginError, login } from '../src/live/login.ts';

// The whole flow with fake answers and synthetic JWTs.
const CREDS = { username: 'sentinel-user@example.com', password: 'sentinel-password' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'none' })}.${b64(claims)}.c2ln`;
const EXP = 1_900_000_000;
const SUB = jwt({ exp: EXP });
const NEXT = 'https://id.formula1.com/davinci/next';
const EVIL = 'https://evil.example/davinci/next';

type Steps = {
  discovery?: () => Response;
  href?: string;
  flow?: (state: string) => unknown;
  token?: () => Response;
};
let signins: { body: string; cookie: string | null; interactionId: string | null }[];
let tokens: URLSearchParams[];
let evil: number;

function flow({ discovery, href = NEXT, flow: answer, token }: Steps = {}) {
  let state = '';
  server.use(
    http.get(
      'https://account.formula1.com/scripts/main.min.js',
      () => discovery?.() ?? new HttpResponse('x={davinci:{clientId:"cid",acrValues:"acr"},other:{a:1}}'),
    ),
    http.get('https://id.formula1.com/as/authorize', ({ request }) => {
      const q = new URL(request.url).searchParams;
      state = q.get('state') ?? '';
      expect(q.get('client_id')).toBe('cid');
      expect(q.get('acr_values')).toBe('acr');
      return HttpResponse.json(
        { _links: { next: { href } }, interactionId: 'iid', id: 'form', eventName: 'continue' },
        { headers: { 'Set-Cookie': 'flow=abc; Path=/; Secure' } },
      );
    }),
    http.post(NEXT, async ({ request }) => {
      signins.push({
        body: await request.text(),
        cookie: request.headers.get('cookie'),
        interactionId: request.headers.get('interactionId'),
      });
      return HttpResponse.json(
        (answer?.(state) ?? { status: 'COMPLETED', authorizeResponse: { state, code: 'the-code' } }) as object,
      );
    }),
    http.post(EVIL, () => {
      evil++;
      return HttpResponse.json({});
    }),
    http.post('https://id.formula1.com/as/token', async ({ request }) => {
      tokens.push(new URLSearchParams(await request.text()));
      return token?.() ?? HttpResponse.json({ access_token: jwt({ subscriptionToken: SUB }) });
    }),
  );
}

/** The LoginError, after checking that nothing but its fixed text and numbers came along. */
async function failure(...leaks: string[]): Promise<LoginError> {
  const err = await login(CREDS).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LoginError);
  const text = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack}`;
  for (const secret of [CREDS.username, CREDS.password, 'the-code', ...leaks]) expect(text).not.toContain(secret);
  expect((err as LoginError).cause).toBeUndefined();
  return err as LoginError;
}

beforeEach(() => {
  signins = [];
  tokens = [];
  evil = 0;
});

describe('login', () => {
  it('returns the subscription token and its expiry, with the cookie and the PKCE verifier on the way', async () => {
    flow();
    await expect(login(CREDS)).resolves.toEqual({ value: SUB, expiresAt: EXP * 1000 });
    expect(signins).toHaveLength(1);
    const body = JSON.parse(signins[0]?.body ?? '') as { parameters: { data: { formData: object } } };
    expect(body.parameters.data.formData).toEqual(CREDS);
    expect(signins[0]?.cookie).toContain('flow=abc');
    expect(signins[0]?.interactionId).toBe('iid');
    expect(tokens[0]?.get('code')).toBe('the-code');
    expect(tokens[0]?.get('code_verifier')).toMatch(/^[\w-]{43,}$/);
  });

  it('refuses a foreign sign-in URL and sends no credentials there', async () => {
    flow({ href: EVIL });
    expect((await failure('evil.example')).code).toBe('login_authorize');
    expect(evil).toBe(0);
    expect(signins).toHaveLength(0);
  });

  it('refuses a look-alike host that only starts with the IdP name', async () => {
    flow({ href: 'https://id.formula1.com.evil.example/next' });
    expect((await failure('evil.example')).code).toBe('login_authorize');
    expect(signins).toHaveLength(0);
  });

  it('refuses a state mismatch before the token step', async () => {
    flow({ flow: () => ({ status: 'COMPLETED', authorizeResponse: { state: 'other', code: 'the-code' } }) });
    expect((await failure()).code).toBe('login_signin');
    expect(tokens).toHaveLength(0);
  });

  it("keeps DaVinci's status and message out of the error", async () => {
    flow({ flow: () => ({ status: 'ACCOUNT_LOCKED_SENTINEL', message: 'Hello sentinel-user@example.com' }) });
    const err = await failure('ACCOUNT_LOCKED_SENTINEL', 'Hello');
    expect(err.code).toBe('login_signin');
    expect(err.message).toBe('F1 TV login failed: login_signin');
    expect(err.status).toBe(200);
  });

  it('refuses a token without a subscriptionToken, or one with no exp', async () => {
    flow({ token: () => HttpResponse.json({ access_token: jwt({ sub: 'x' }) }) });
    expect((await failure()).code).toBe('login_claims');
    flow({ token: () => HttpResponse.json({ access_token: jwt({ subscriptionToken: jwt({}) }) }) });
    expect((await failure()).code).toBe('login_claims');
  });

  it('gives a token-step status as a number', async () => {
    flow({ token: () => new HttpResponse('sentinel-body', { status: 400 }) });
    const err = await failure('sentinel-body');
    expect(err.code).toBe('login_token');
    expect(err.status).toBe(400);
  });

  it('turns a network failure into a fixed code, without the URL', async () => {
    flow({ discovery: () => HttpResponse.error() });
    const err = await failure('formula1.com');
    expect(err.code).toBe('login_discovery');
    expect(err.status).toBeUndefined();
  });

  it('refuses a frontend config with no DaVinci settings', async () => {
    flow({ discovery: () => new HttpResponse('nothing here') });
    expect((await failure()).code).toBe('login_discovery');
  });
});

describe('credentials', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f1-login-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads both file secrets', () => {
    writeFileSync(join(dir, 'f1tv_username'), 'u\n');
    writeFileSync(join(dir, 'f1tv_password'), 'p\n');
    expect(credentials(dir)).toEqual({ username: 'u', password: 'p' });
  });
  it('is undefined when either is missing or empty', () => {
    expect(credentials(dir)).toBeUndefined();
    writeFileSync(join(dir, 'f1tv_username'), 'u\n');
    expect(credentials(dir)).toBeUndefined();
    writeFileSync(join(dir, 'f1tv_password'), '\n');
    expect(credentials(dir)).toBeUndefined();
  });
});
