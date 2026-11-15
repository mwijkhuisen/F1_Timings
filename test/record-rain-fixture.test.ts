import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { FORECAST, HISTORICAL } from '../apps/server/src/rain/client.ts';
import { ATTRIBUTION, record } from '../scripts/record-rain-fixture.ts';
import { server } from './msw.setup.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'f1-rain-fixture-'));
const ARGS = ['central-wet', '43.7367', '7.4258', '2023-05-28T13:00:00Z', '2023-05-28T15:00:00Z'];
// #120: Las Vegas 2026, FP1's start to the race's end. A negative coordinate needs `--` (else parseArgs reads an option).
const VEGAS = [
  '--forecast',
  '--',
  'forecast-vegas',
  '36.1167',
  '-115.1666',
  '2026-11-20T00:30:00Z',
  '2026-11-22T06:00:00Z',
];

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

  it('--forecast refuses to run under CI, before any request, and writes nothing', async () => {
    const dir = tmp();
    const lines: string[] = [];
    expect(await record(VEGAS, { CI: 'true' }, (l) => lines.push(l), dir)).toBe(1);
    expect(lines).toEqual(['record-rain-fixture refuses to run under CI (A§12.1 invariant 4)']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('--forecast writes the body as sent and the meta, one point over [floorHour(start), ceilHour(end)]', async () => {
    const body = '{"error":true,"reason":"r"}';
    let query: URLSearchParams | undefined;
    server.use(
      http.get(FORECAST, ({ request }) => {
        query = new URL(request.url).searchParams;
        return new HttpResponse(body, { status: 400 });
      }),
    );
    const dir = tmp();
    expect(await record(VEGAS, {}, () => {}, dir)).toBe(0);
    expect(readFileSync(join(dir, 'forecast-vegas.raw'), 'utf8')).toBe(body);
    const meta = JSON.parse(readFileSync(join(dir, 'forecast-vegas.meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      api: 'forecast',
      kind: 'forecast',
      status: 400,
      location: { lat: 36.1167, lon: -115.1666 },
      attribution: ATTRIBUTION,
    });
    expect(meta.query).toEqual(Object.fromEntries(query ?? []));
    expect(meta.query).toMatchObject({
      latitude: '36.1167',
      longitude: '-115.1666',
      start_hour: '2026-11-20T00:00',
      end_hour: '2026-11-22T06:00',
    });
  });

  it.each([
    ['--forecast with --api historical', ['--api', 'historical', ...VEGAS]],
    ['--forecast with a bad date', VEGAS.map((a) => (a === '2026-11-20T00:30:00Z' ? 'x' : a))],
    ['--forecast without the end', VEGAS.filter((a) => a !== '2026-11-22T06:00:00Z')],
    ['--forecast with a value', ['--forecast=yes', ...VEGAS.slice(1)]],
    ['a negative coordinate without --', VEGAS.filter((a) => a !== '--')],
  ])('refuses %s with the usage, before any request', async (_, argv) => {
    const lines: string[] = [];
    const dir = tmp();
    expect(await record(argv, {}, (l) => lines.push(l), dir)).toBe(64);
    expect(lines[0]).toMatch(/^usage: record-rain-fixture.ts/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
