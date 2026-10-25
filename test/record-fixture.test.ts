import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { OPENF1 } from '../apps/server/src/openf1/client.ts';
import { record } from '../scripts/record-fixture.ts';
import { server } from './msw.setup.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'f1-fixture-'));
const pit = (driver_number: number, lap_number: number) => ({
  meeting_key: 1,
  session_key: 2,
  driver_number,
  lap_number,
  date: '2026-10-11T12:56:58.386000+00:00',
  pit_duration: 23.9,
  lane_duration: 23.9,
  stop_duration: null,
});

describe('record-fixture', () => {
  it('refuses to run under CI, before any request', async () => {
    const dir = tmp();
    const lines: string[] = [];
    expect(await record(['pit', 'normal', 'session_key=2'], { CI: 'true' }, (l) => lines.push(l), dir)).toBe(1);
    expect(lines).toEqual(['record-fixture refuses to run under CI (A§12.1 invariant 4)']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('trims to the given drivers and laps, then writes raw, meta and golden', async () => {
    server.use(http.get(`${OPENF1}/pit`, () => HttpResponse.json([pit(1, 5), pit(1, 20), pit(2, 5)])));
    const dir = tmp();
    const args = ['pit', 'normal', 'session_key=2', '--drivers', '1', '--laps', '1-10,30'];
    expect(await record(args, {}, () => {}, dir)).toBe(0);

    const file = (ext: string) => readFileSync(join(dir, `pit-normal${ext}`), 'utf8');
    expect(file('.raw')).toBe(`[\n${JSON.stringify(pit(1, 5))}\n]\n`);
    const { meeting_key: _, ...parsed } = pit(1, 5);
    expect(JSON.parse(file('.golden.json'))).toEqual([parsed]);
    expect(JSON.parse(file('.meta.json'))).toMatchObject({
      url: `${OPENF1}/pit?session_key=2`,
      status: 200,
      trim: { drivers: '1', laps: '1-10,30' },
      rows: { fetched: 3, kept: 1 },
    });
  });
});
