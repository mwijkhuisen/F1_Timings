import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrames, type Frame, findFrame, fitFrame, outlinePoints, type Pt, toOutline } from '../src/live/fit.ts';
import { createLaps } from '../src/live/laps.ts';
import { createFeed } from '../src/live/merge.ts';
import { OUTLINES } from '../src/live/outlines.ts';
import { parseFeedLine } from '../src/live/read.ts';
import type { Line } from '../src/live/recording.ts';
import { zCounts } from '../src/live/telemetry.ts';
import { along, type Car, session, toF1, type Value } from './track.ts';

// The map frame (P7a, T5) on the P5c Interlagos outline, with synthetic positions only (A§12.1 invariant 3).

const OUTLINE = OUTLINES['br-1940'] as string;
const deg = (d: number) => (d * Math.PI) / 180;
/** The plan's frame for the fit alone: θ 123°, s 0.97, mirrored, offset (−3,110 m, 2,250 m). */
const FAR: Frame = { s: 0.97, theta: deg(123), m: -1, tx: -3110, ty: 2250 };
/** One whose F1 coordinates fit int16, for the Position lines. */
const NEAR: Frame = { s: 1.03, theta: deg(-57), m: -1, tx: 210, ty: -140 };
const T0 = Date.parse('2027-03-05T11:30:00Z');

/** Outline metres → F1 0.1 m units, without the int16 check (FAR's offset is beyond it). */
const inverse = (f: Frame, [X, Y]: Pt): Pt => {
  const [u, v] = [(X - f.tx) / f.s, (Y - f.ty) / f.s];
  const [c, sn] = [Math.cos(f.theta), Math.sin(f.theta)];
  return [Math.round((c * u + sn * v) * 10), Math.round(f.m * (-sn * u + c * v) * 10)];
};
const metres = (p: Pt): Pt => [p[0] / 10, p[1] / 10];
/** How far toOutline puts an F1 sample from where it came from, in metres. */
const miss = (frame: Frame, [x, y]: Pt, [X, Y]: Pt) => {
  const [a, b] = toOutline(frame, x, y);
  return Math.hypot(a - X, b - Y);
};
const lines = (values: Value[]): Line[] => values.map((v) => ({ r: v[0], text: JSON.stringify(v) }));
async function* iterate(list: Line[], seen: Line[] = []) {
  for (const line of list) {
    seen.push(line);
    yield line;
  }
}
const practice = (cars: Car[], extra: Value[] = []) =>
  lines(
    [...session({ outline: OUTLINE, frame: NEAR, sessionKey: 9001, t0: T0, cars }), ...extra].sort(
      (a, b) => a[0] - b[0],
    ),
  );
const closeTo = (a: Frame, b: Frame) => {
  expect(a.m).toBe(b.m);
  expect(a.s).toBeCloseTo(b.s, 3);
  expect(Math.abs(Math.atan2(Math.sin(a.theta - b.theta), Math.cos(a.theta - b.theta)))).toBeLessThan(deg(0.1));
};

describe('fitFrame (P7a, T5)', () => {
  const track = along(OUTLINE);
  const every10m = Array.from({ length: Math.floor(track.length / 10) }, (_, i) => track.at(i * 10));

  it('maps the outline sampled every 10 m, rotated, scaled, mirrored and shifted, back within 1 m', async () => {
    expect(outlinePoints(OUTLINE).length).toBeGreaterThan(20);
    const f1 = every10m.map((p) => inverse(FAR, p));
    const { frame, rms } = await fitFrame(f1.map(metres), outlinePoints(OUTLINE));
    closeTo(frame, FAR);
    expect(rms).toBeLessThan(0.2);
    expect(Math.max(...f1.map((p, i) => miss(frame, p, every10m[i] as Pt)))).toBeLessThan(1);
  });

  it('the same with 10 % of the samples moved 30 m off the track: the trim leaves them out', async () => {
    const moved = every10m.map((p, i): Pt => {
      if (i % 10 !== 3) return p;
      const [a, b] = [track.at(i * 10 - 1), track.at(i * 10 + 1)];
      const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [p[0] - (30 * (b[1] - a[1])) / n, p[1] + (30 * (b[0] - a[0])) / n]; // 30 m to the left
    });
    const f1 = moved.map((p) => inverse(FAR, p));
    const { frame } = await fitFrame(f1.map(metres), outlinePoints(OUTLINE));
    closeTo(frame, FAR);
    const off = f1.flatMap((p, i) => (i % 10 === 3 ? [] : [miss(frame, p, every10m[i] as Pt)]));
    expect(Math.max(...off)).toBeLessThan(1);
  });

  it('toOutline takes 0.1 m units and gives integer metres, never −0', () => {
    const id: Frame = { s: 1, theta: 0, m: 1, tx: 0, ty: 0 };
    expect(toOutline(id, 12_345, -6_789)).toEqual([1235, -679]);
    expect(Object.is(toOutline(id, -4, -4)[0], 0)).toBe(true);
    expect(toOutline({ ...id, m: -1, tx: 5 }, 10, 20)).toEqual([6, -2]);
  });
});

describe('the synthetic session (test/track.ts)', () => {
  it('createLaps starts each lap at its count, lap 1 an out-lap', () => {
    const [feed, engine] = [createFeed(), createLaps(9001, 'f1-live')];
    for (const line of practice([{ driver: 4, laps: [80_000, 75_000, 76_000] }])) {
      for (const ev of parseFeedLine(line.text)) {
        if (ev.topic.endsWith('.z')) continue;
        const delta = feed.apply(ev);
        if (delta !== undefined) engine.push(ev, delta);
      }
    }
    expect(
      engine.rows().laps.map((l) => [l.driver_number, l.lap_number, l.date_start, l.is_pit_out, l.is_pit_in]),
    ).toEqual([
      [4, 1, new Date(T0).toISOString(), true, false],
      [4, 2, new Date(T0 + 80_000).toISOString(), false, false],
      [4, 3, new Date(T0 + 155_000).toISOString(), false, false],
      [4, 4, new Date(T0 + 231_000).toISOString(), false, false],
    ]);
  });

  it('refuses a frame that puts the track outside int16', () => {
    expect(() => toF1(FAR, [0, 0])).toThrow('int16');
  });
});

describe('findFrame (P7a, D2)', () => {
  const junk = (r: number): Value => [r, 'Position.z', '!!!', new Date(r).toISOString()];

  it('finds the first complete lap of a practice session; nothing is decoded before a lap starts', async () => {
    const counts = zCounts();
    const found = await findFrame(
      iterate(practice([{ driver: 4, laps: [80_000, 75_000, 76_000] }], [junk(T0 - 20_000), junk(T0 + 10_000)])),
      9001,
      OUTLINE,
      counts,
    );
    expect(found).toBeDefined();
    closeTo(found?.frame as Frame, NEAR);
    expect(found?.rms).toBeLessThan(1);
    expect(found?.samples).toBe(75_000 / 250); // lap 2: lap 1 is the out-lap
    expect(counts).toEqual({ ...zCounts(), bad_base64: 1 }); // the line before t0 was never decoded
  });

  it('skips a lap with a 2 s gap or an OffTrack sample and takes the next one', async () => {
    for (const car of [
      { driver: 4, laps: [80_000, 75_000, 76_000, 77_000], gaps: [[110_000, 112_000]] },
      { driver: 4, laps: [80_000, 75_000, 76_000, 77_000], offTrack: [[120_000, 120_250]] },
    ] satisfies Car[]) {
      const found = await findFrame(iterate(practice([car])), 9001, OUTLINE, zCounts());
      expect(found?.samples).toBe(76_000 / 250);
    }
    // A gap of 1 s is jitter (T3): lap 2 stands.
    const jitter = { driver: 4, laps: [80_000, 75_000, 76_000], gaps: [[110_000, 111_000]] } satisfies Car;
    expect((await findFrame(iterate(practice([jitter])), 9001, OUTLINE, zCounts()))?.samples).toBe(75_000 / 250 - 4);
  });

  it('no complete lap, or another session: undefined', async () => {
    expect(
      await findFrame(iterate(practice([{ driver: 4, laps: [80_000] }])), 9001, OUTLINE, zCounts()),
    ).toBeUndefined();
    const other = practice([{ driver: 4, laps: [80_000, 75_000, 76_000] }]);
    expect(await findFrame(iterate(other), 9002, OUTLINE, zCounts())).toBeUndefined();
  });

  it('gives up after 50 candidates', async () => {
    const laps = Array.from({ length: 60 }, () => 31_000);
    const gaps = laps.map((_, i): [number, number] => [i * 31_000 + 10_000, i * 31_000 + 12_000]);
    const seen: Line[] = [];
    expect(
      await findFrame(iterate(practice([{ driver: 4, laps, gaps }]), seen), 9001, OUTLINE, zCounts()),
    ).toBeUndefined();
    // Laps 2–51 tried: it stops at the first Position line past lap 51's end + 1.5 s.
    expect((seen.at(-1) as Line).r - (T0 + 51 * 31_000)).toBeGreaterThan(3_000);
    expect((seen.at(-1) as Line).r - (T0 + 51 * 31_000)).toBeLessThan(5_000);
  });

  it('gives up 30 min of feed time after the first lap', async () => {
    const laps = Array.from({ length: 25 }, () => 100_000);
    const gaps = laps.map((_, i): [number, number] => [i * 100_000 + 10_000, i * 100_000 + 12_000]);
    const seen: Line[] = [];
    expect(
      await findFrame(iterate(practice([{ driver: 4, laps, gaps }]), seen), 9001, OUTLINE, zCounts()),
    ).toBeUndefined();
    expect((seen.at(-1) as Line).r - T0).toBeGreaterThan(1_800_000);
    expect((seen.at(-1) as Line).r - T0).toBeLessThan(1_805_000);
  });
});

describe('createFrames (P7a, D2)', () => {
  const dirs: string[] = [];
  const recording = (values: Value[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-fit-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'feed.jsonl'), values.map((v) => `${JSON.stringify(v)}\n`).join(''));
    return dir;
  };
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const logger = () => {
    const seen: { level: string; fields: Record<string, unknown>; msg: string }[] = [];
    const log = {
      info: (fields: Record<string, unknown>, msg: string) => seen.push({ level: 'info', fields, msg }),
      error: (fields: Record<string, unknown>, msg: string) => seen.push({ level: 'error', fields, msg }),
    };
    return { seen, log: log as unknown as Parameters<typeof createFrames>[0] };
  };
  const ask = (dir: string, ended: boolean) => ({ id: '7', dir, sessionKey: 9001, outline: OUTLINE, ended });
  const sessionOf = (cars: Car[]) => session({ outline: OUTLINE, frame: NEAR, sessionKey: 9001, t0: T0, cars });

  it('a found frame is final: one run, shared by concurrent callers, one fixed-field line', async () => {
    const { seen, log } = logger();
    const frames = createFrames(log);
    const dir = recording(sessionOf([{ driver: 4, laps: [80_000, 75_000, 76_000] }]));
    const [a, b] = await Promise.all([frames.get(ask(dir, false)), frames.get(ask(dir, false))]);
    closeTo(a as Frame, NEAR);
    expect(b).toBe(a);
    expect(await frames.get(ask(dir, false))).toBe(a);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.msg).toBe('playback fit');
    expect(Object.keys(seen[0]?.fields ?? {})).toEqual([
      'outcome',
      'ms',
      'lines',
      'samples',
      'rms_m',
      'bad_base64',
      'bad_deflate',
      'too_large',
      'zlib',
      'bad_json',
    ]);
    expect(seen[0]?.fields).toMatchObject({ outcome: 'found', samples: 300, bad_base64: 0 });
    expect(seen[0]?.fields.rms_m).toBeLessThan(0.5);
  });

  it('none for an open recording is asked again after 30 s; for an ended one it is final', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { seen, log } = logger();
    const frames = createFrames(log);
    const dir = recording(sessionOf([{ driver: 4, laps: [80_000] }]));
    expect(await frames.get(ask(dir, false))).toBeUndefined();
    vi.setSystemTime(Date.now() + 29_000);
    await frames.get(ask(dir, false));
    expect(seen).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    await frames.get(ask(dir, true));
    expect(seen).toHaveLength(2);
    vi.setSystemTime(Date.now() + 60_000);
    await frames.get(ask(dir, true));
    expect(seen.map((s) => [s.level, s.fields.outcome, s.fields.samples, s.fields.rms_m])).toEqual([
      ['info', 'none', 0, null],
      ['info', 'none', 0, null],
    ]);
  });

  it('a failed run is logged as its code, gives undefined and is not cached', async () => {
    const { seen, log } = logger();
    const frames = createFrames(log);
    const gone = join(tmpdir(), 'f1-fit-missing-recording');
    expect(await frames.get(ask(gone, true))).toBeUndefined();
    expect(await frames.get(ask(gone, true))).toBeUndefined();
    expect(seen).toEqual([
      { level: 'error', fields: { cause: 'ENOENT' }, msg: 'playback fit' },
      { level: 'error', fields: { cause: 'ENOENT' }, msg: 'playback fit' },
    ]);
  });

  it('counts a failed decode in its line', async () => {
    const { seen, log } = logger();
    const bad: Value = [T0 + 5_000, 'Position.z', deflateRawSync('{').toString('base64'), new Date(T0).toISOString()];
    const dir = recording(
      [...sessionOf([{ driver: 4, laps: [80_000, 75_000, 76_000] }]), bad].sort((a, b) => a[0] - b[0]),
    );
    expect(await createFrames(log).get(ask(dir, true))).toBeDefined();
    expect(seen[0]?.fields).toMatchObject({ outcome: 'found', bad_json: 1 });
  });
});
