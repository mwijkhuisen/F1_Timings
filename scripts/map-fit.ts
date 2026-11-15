import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { findFrame, outlinePoints, type Pt, toOutline } from '../apps/server/src/live/fit.ts';
import { OUTLINES } from '../apps/server/src/live/outlines.ts';
import { isObj, parseFeedLine } from '../apps/server/src/live/read.ts';
import { recordingLines } from '../apps/server/src/live/recording.ts';
import { decodeZ, positions, zCounts } from '../apps/server/src/live/telemetry.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { CIRCUITS } from '../packages/contracts/src/index.ts';

// The map frame's [box] check (P7a, A§11.3, T5), on the owner's machine only: CI never has F1 data. It reads one
// recorder directory through recordingLines, fits the frame with findFrame on the circuit's P5c outline, then measures
// how far every on-track sample of cars 1–99 inside a SessionStatus Started window lands from the outline polygon,
// after toOutline. It makes no network call and prints counts, millisecond timings and distances in metres, never a
// coordinate or a decoded value, so its output can go into a PR. The bar is p90 ≤ 20 m (the #122 spike: 13.5 m on the
// Mexico City recording, 19.3 m on the Interlagos archive).

const USAGE = 'usage: map-fit.ts <recording dir> --session <key> --circuit <circuit_short_name>';
const WITHIN_M = 25;

type Seg = { ax: number; ay: number; dx: number; dy: number; l2: number };
const segmentsOf = (outline: readonly Pt[]): Seg[] =>
  outline.map(([ax, ay], i) => {
    const [bx, by] = outline[(i + 1) % outline.length] as Pt;
    return { ax, ay, dx: bx - ax, dy: by - ay, l2: (bx - ax) ** 2 + (by - ay) ** 2 };
  });
/** The distance from a point to the closed polygon. ponytail: brute force, as fit.ts; fine for a one-off check. */
const distance = (segs: readonly Seg[], x: number, y: number) =>
  Math.sqrt(
    Math.min(
      ...segs.map((s) => {
        const u = s.l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.l2));
        return (s.ax + u * s.dx - x) ** 2 + (s.ay + u * s.dy - y) ** 2;
      }),
    ),
  );
const quantile = (sorted: readonly number[], q: number) => sorted[Math.floor(q * (sorted.length - 1))] as number;
const fixed = (n: number, d = 1) => n.toFixed(d);

export async function mapFit(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  if (env.CI) {
    log('map-fit refuses to run under CI (A§12.1 invariant 3)');
    return 1;
  }
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch {
    log(USAGE);
    return EXIT_USAGE;
  }
  const { session, circuit } = args.values;
  const outline = circuit === undefined ? undefined : OUTLINES[CIRCUITS[circuit]?.id ?? ''];
  if (args.positionals.length !== 1 || !/^\d+$/.test(session ?? '') || outline === undefined) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const dir = args.positionals[0] as string;

  const [t0, zc] = [performance.now(), zCounts()];
  const found = await findFrame(recordingLines(dir), Number(session), outline, zc);
  const ms = Math.round(performance.now() - t0);
  log(`outcome ${found ? 'found' : 'none'}`);
  if (!found) {
    log(`fit_ms ${ms}`);
    return 0; // none is a result, not a failure: the recording may have no complete on-track lap
  }

  // Second pass: the Started windows (a SessionStatus Started opens, any other status closes) and every Position
  // sample, which is judged once the whole feed is read; a sample arrives about 2 s after its time.
  const [windows, samples, last] = [[] as [number, number][], [] as number[], new Map<number, number>()];
  const failed = zCounts();
  let open: number | undefined;
  for await (const line of recordingLines(dir)) {
    for (const ev of parseFeedLine(line.text)) {
      if (ev.topic === 'SessionStatus' && isObj(ev.payload) && typeof ev.payload.Status === 'string') {
        if (ev.payload.Status === 'Started') open ??= ev.t;
        else if (open !== undefined) {
          windows.push([open, ev.t]);
          open = undefined;
        }
      } else if (ev.topic === 'Position.z') {
        const z = decodeZ(ev.payload);
        if (!z.ok) failed[z.fail]++;
        for (const { t, cars } of z.ok ? positions(z.value) : []) {
          for (const [car, s] of cars) {
            if (s.status !== 'OnTrack' || t <= (last.get(car) ?? Number.NEGATIVE_INFINITY)) continue; // a repeat
            last.set(car, t);
            samples.push(t, s.x, s.y);
          }
        }
      }
    }
  }
  if (open !== undefined) windows.push([open, Number.POSITIVE_INFINITY]);
  const [segs, d] = [segmentsOf(outlinePoints(outline)), [] as number[]];
  for (let i = 0; i < samples.length; i += 3) {
    const t = samples[i] as number;
    if (!windows.some(([a, b]) => t >= a && t < b)) continue;
    const [x, y] = toOutline(found.frame, samples[i + 1] as number, samples[i + 2] as number);
    d.push(distance(segs, x, y));
  }
  d.sort((a, b) => a - b);
  log(`lap_samples ${found.samples} rms_m ${fixed(found.rms)} fit_ms ${ms}`);
  if (d.length === 0) {
    log('measured 0');
  } else {
    const within = d.filter((m) => m <= WITHIN_M).length / d.length;
    log(`measured ${d.length}`);
    log(`median_m ${fixed(quantile(d, 0.5))} p90_m ${fixed(quantile(d, 0.9))} p99_m ${fixed(quantile(d, 0.99))}`);
    log(`within_${WITHIN_M}m ${fixed(within * 100)} %`);
  }
  log(
    Object.entries(failed)
      .map(([k, v]) => `${k} ${v}`)
      .join(' '),
  );
  return 0;
}

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { session: { type: 'string' }, circuit: { type: 'string' } },
  });

if (import.meta.main) {
  process.exitCode = await mapFit(process.argv.slice(2), process.env);
}
