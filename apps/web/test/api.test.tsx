import { Seasons } from '@f1/contracts';
import { HttpResponse, http } from 'msw';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { server } from '../../../test/msw.setup.ts';
import { getJson, HttpError, retry } from '../src/lib/api.ts';
import { ErrorView, errorText } from '../src/ui/ErrorView.tsx';

// D6: every answer is parsed with its contract; the error view never echoes a body or a ZodError message.

const url = 'http://web.test/api/v1/seasons';
const get = () => getJson(url, Seasons, new AbortController().signal);
const zodError = Seasons.safeParse([{ year: '2026' }]).error;

describe('getJson', () => {
  it('returns the parsed answer', async () => {
    server.use(http.get(url, () => HttpResponse.json([{ year: 2026, meetings: 25, sessions: 121 }])));
    await expect(get()).resolves.toEqual([{ year: 2026, meetings: 25, sessions: 121 }]);
  });

  it('rejects an answer that fails its contract with a ZodError', async () => {
    server.use(http.get(url, () => HttpResponse.json([{ year: 2026, meetings: 25, sessions: 121, extra: 1 }])));
    await expect(get()).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects a non-OK status with an HttpError, without reading the body', async () => {
    server.use(http.get(url, () => HttpResponse.json({ error: 'not found' }, { status: 404 })));
    await expect(get()).rejects.toMatchObject({ name: 'HttpError', status: 404 });
  });

  it("turns a redirect (Access's login page) into a TypeError", async () => {
    server.use(http.get(url, () => HttpResponse.redirect('http://web.test/login', 302)));
    await expect(get()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('errorText', () => {
  it.each([
    ['a 401', new HttpError(401), 'Your Access session may have expired: reload to sign in.'],
    ['a TypeError', new TypeError('fetch failed'), 'Your Access session may have expired: reload to sign in.'],
    ['a 404', new HttpError(404), 'Not found.'],
    ['a ZodError', zodError, 'Unexpected data from the API.'],
    ['a 500', new HttpError(500), 'API error'],
    ['anything else', new Error('secret detail'), 'API error'],
  ])('%s', (_name, error, text) => {
    expect(errorText(error)).toBe(text);
  });

  it('renders as an alert without the error message', () => {
    const html = renderToStaticMarkup(<ErrorView error={zodError} />);
    expect(html).toBe('<p role="alert">Unexpected data from the API.</p>');
  });
});

describe('retry', () => {
  it.each([
    ['a 500', new HttpError(500), true],
    ['a TypeError', new TypeError('fetch failed'), true],
    ['a 401', new HttpError(401), false],
    ['a 404', new HttpError(404), false],
    ['a ZodError', zodError, false],
  ])('retries %s once: %s', (_name, error, again) => {
    expect(retry(0, error)).toBe(again);
    expect(retry(1, error)).toBe(false);
  });
});
