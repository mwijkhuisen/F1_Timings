import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTLINES } from '../apps/server/src/live/outlines.ts';
import { session } from '../apps/server/test/track.ts';
import { mapFit } from '../scripts/map-fit.ts';

// The [box] script on a synthetic recording (A§12.1 invariant 3): invented cars on the Interlagos outline.
const T0 = Date.parse('2027-03-05T11:30:00Z');
const NEAR = { s: 1.03, theta: (-57 * Math.PI) / 180, m: -1 as const, tx: 210, ty: -140 };
const recording = (cars: { driver: number; laps: number[] }[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'f1-mapfit-'));
  const values = [
    ...session({ outline: OUTLINES['br-1940'] as string, frame: NEAR, sessionKey: 9001, t0: T0, cars }),
    [T0 - 1_000, 'SessionStatus', { Status: 'Started' }, new Date(T0 - 1_000).toISOString()],
  ].sort((a, b) => (a[0] as number) - (b[0] as number));
  writeFileSync(join(dir, 'feed.jsonl'), `${values.map((v) => JSON.stringify(v)).join('\n')}\n`);
  return dir;
};
const run = async (argv: string[], env: Record<string, string> = {}) => {
  const lines: string[] = [];
  return { code: await mapFit(argv, env, (l) => lines.push(l)), lines };
};

describe('mapFit', () => {
  it('refuses under CI and with bad arguments', async () => {
    expect(await run(['d', '--session', '1', '--circuit', 'Interlagos'], { CI: 'true' })).toEqual({
      code: 1,
      lines: ['map-fit refuses to run under CI (A§12.1 invariant 3)'],
    });
    for (const argv of [[], ['d'], ['d', '--session', '1'], ['d', '--session', 'x', '--circuit', 'Interlagos']]) {
      expect((await run(argv)).code).toBe(64);
    }
    expect((await run(['d', '--session', '1', '--circuit', 'Nowhere'])).code).toBe(64);
    expect((await run(['d', '--session', '1', '--circuit', 'Interlagos', '--nope'])).code).toBe(64);
  });

  it('finds the frame and measures the samples within a metre or two, numbers only', async () => {
    const dir = recording([{ driver: 4, laps: [80_000, 75_000, 76_000] }]);
    const { code, lines } = await run([dir, '--session', '9001', '--circuit', 'Interlagos']);
    expect(code).toBe(0);
    expect(lines[0]).toBe('outcome found');
    expect(lines.join('\n')).toMatch(
      /measured \d+\nmedian_m [01]\.\d p90_m [0-2]\.\d p99_m [0-2]\.\d\nwithin_25m 100\.0 %/,
    );
    expect(lines.at(-1)).toBe('bad_base64 0 bad_deflate 0 too_large 0 zlib 0 bad_json 0');
  });

  it('says none for a recording whose only lap is an out-lap', async () => {
    const dir = recording([{ driver: 4, laps: [80_000] }]);
    expect(await run([dir, '--session', '9001', '--circuit', 'Interlagos'])).toEqual({
      code: 0,
      lines: ['outcome none', expect.stringMatching(/^fit_ms \d+$/)],
    });
  });
});
