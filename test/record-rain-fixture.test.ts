import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { HISTORICAL } from '../apps/server/src/rain/client.ts';
import { ATTRIBUTION, record } from '../scripts/record-rain-fixture.ts';
import { server } from './msw.setup.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'f1-rain-fixture-'));
const ARGS = ['central-wet', '43.7367', '7.4258', '2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z'];

describe('record-rain-fixture', () => {
  it('refuses to run under CI, before any request, and writes nothing', async () => {
    const dir = tmp();
    const lines: string[] = [];
    expect(await record(ARGS, { CI: 'true' }, (l) => lines.push(l), dir)).toBe(1);
    expect(lines).toEqual(['record-rain-fixture refuses to run under CI (A§12.1 invariant 4)']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the body as sent and the meta, for a 7 × 7 grid over [start − 60 min, end + 30 min]', async () => {
    const body = '{"error":true,"reason":"r"}';
    let query: URLSearchParams | undefined;
    server.use(
      http.get(HISTORICAL, ({ request }) => {
        query = new URL(request.url).searchParams;
        return new HttpResponse(body, { status: 400 });
      }),
    );
    const dir = tmp();
    expect(await record(ARGS, {}, () => {}, dir)).toBe(0);
    expect(readFileSync(join(dir, 'central-wet.raw'), 'utf8')).toBe(body);
    const meta = JSON.parse(readFileSync(join(dir, 'central-wet.meta.json'), 'utf8'));
    expect(meta).toMatchObject({ api: 'historical', status: 400, points: 49, attribution: ATTRIBUTION });
    expect(meta.query).toEqual(Object.fromEntries(query ?? []));
    expect(meta.query).toMatchObject({ start_minutely_15: '2023-05-28T12:00', end_minutely_15: '2023-05-28T15:30' });
    expect(meta.query.latitude.split(',')).toHaveLength(49);
  });

  it('refuses a bad argument with the usage', async () => {
    const lines: string[] = [];
    expect(await record(['Bad', '1', '2', 'x', 'y'], {}, (l) => lines.push(l), tmp())).toBe(64);
    expect(lines[0]).toMatch(/^usage: record-rain-fixture.ts/);
  });
});
