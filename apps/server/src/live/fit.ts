import { setImmediate } from 'node:timers/promises';
import type { Logger } from 'pino';
import { codeOf } from '../db/db.ts';
import { createLaps, type LapRow } from './laps.ts';
import { createFeed } from './merge.ts';
import { isObj, parseFeedLine, UNPARSED } from './read.ts';
import { type Line, recordingLines } from './recording.ts';
import { decodeZ, positions, type ZFail, zCounts } from './telemetry.ts';

// The map frame (P7a, A§11.3, T5): a similarity transform from the F1 Position frame onto the P5c outline, fitted per
// recording from its first complete on-track lap and cached (D2). The fit is the #122 spike's: PCA starts × 8
// rotations × 2 mirrors, then trimmed ICP (the closest 85 %) with point-to-segment correspondences on the outline
// polygon and the closed-form Umeyama step. The frame is a transform only and carries no position.

/** F1 metres → outline metres (x east, y south, from the outline's centre): y × m, rotate by theta, scale, shift. */
export type Frame = { s: number; theta: number; m: 1 | -1; tx: number; ty: number };
export type Pt = [x: number, y: number];

const TRIM = 0.85;
const MAX_IT = 60;
const SCREEN = 300; // points per start
const REFINE = 2_000; // points for the best 3
const DENSE_M = 5; // the outline's sampling for its PCA, so a curve's many vertices weigh no more than a straight

const BUFFER_MS = 4 * 60_000;
const BUFFER_MAX = 2_000;
const ROWS_MS = 10_000; // laps.ts rows() clones and sorts every row: at most once per 10 s of F1 time
const GIVE_UP_MS = 30 * 60_000;
const CANDIDATES = 50;
// The budget (P7a review): a fit runs outside the 8-stream cap. About one Position line a second, so GIVE_UP_MS is
// about 1,800 decoded lines; a 4 h race is about 99k lines, so LINES_MAX covers one that starts an hour early too.
const DECODED_MAX = 4_000;
const LINES_MAX = 200_000;
const GAP_MS = 1_500; // T3: a longer gap on a lap is a real dropout; also the edges and the wait for late samples
const MIN_SAMPLES = 60;
const MIN_LAP_MS = 30_000;
const MAX_RMS_M = 15; // the spike's lap fits: 2.4–6.9 m
const AGAIN_MS = 30_000;

/** The outline's `M x y L … Z` path (km) as its vertices in metres, the closing segment implied. */
export const outlinePoints = (path: string): Pt[] =>
  [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]) * 1000, Number(m[2]) * 1000]);

const apply = (f: Frame, x: number, y: number): Pt => {
  const [c, sn, yy] = [Math.cos(f.theta), Math.sin(f.theta), f.m * y];
  return [f.s * (c * x - sn * yy) + f.tx, f.s * (sn * x + c * yy) + f.ty];
};

/** A Position sample in 0.1 m units → outline metres, rounded to integers. */
export const toOutline = (frame: Frame, x: number, y: number): Pt => {
  const [X, Y] = apply(frame, x / 10, y / 10);
  return [Math.round(X) + 0, Math.round(Y) + 0]; // + 0: no −0
};

type Seg = { ax: number; ay: number; dx: number; dy: number; l2: number };
type Pair = { px: number; py: number; qx: number; qy: number; d: number };

const segmentsOf = (outline: readonly Pt[]): Seg[] =>
  outline.map(([ax, ay], i) => {
    const [bx, by] = outline[(i + 1) % outline.length] as Pt;
    const [dx, dy] = [bx - ax, by - ay];
    return { ax, ay, dx, dy, l2: dx * dx + dy * dy };
  });

/**
 * The nearest point on the closed polygon. ponytail: brute force over the segments, O(segments) per point (30–150);
 * a grid if outlines ever get much denser.
 */
function nearest(segs: readonly Seg[], x: number, y: number): Pt {
  let [best, bx, by] = [Number.POSITIVE_INFINITY, x, y];
  for (const s of segs) {
    const u = s.l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.l2));
    const px = s.ax + u * s.dx;
    const py = s.ay + u * s.dy;
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (d2 < best) {
      best = d2;
      bx = px;
      by = py;
    }
  }
  return [bx, by];
}

function pca(pts: readonly Pt[]) {
  const n = pts.length;
  const [mx, my] = pts.reduce(([sx, sy], [x, y]) => [sx + x / n, sy + y / n], [0, 0]);
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const [x, y] of pts) [sxx, syy, sxy] = [sxx + (x - mx) ** 2, syy + (y - my) ** 2, sxy + (x - mx) * (y - my)];
  return { mx, my, ang: 0.5 * Math.atan2(2 * sxy, sxx - syy), rms: Math.sqrt((sxx + syy) / n) };
}

/** Umeyama's least-squares similarity in 2-D from the (mirrored) p to q. */
function umeyama(pairs: readonly Pair[]): Omit<Frame, 'm'> {
  const n = pairs.length;
  const [mpx, mpy, mqx, mqy] = pairs.reduce(
    ([a, b, c, d], p) => [a + p.px / n, b + p.py / n, c + p.qx / n, d + p.qy / n],
    [0, 0, 0, 0],
  );
  let [a, b, pp] = [0, 0, 0];
  for (const p of pairs) {
    const [ax, ay, bx, by] = [p.px - mpx, p.py - mpy, p.qx - mqx, p.qy - mqy];
    [a, b, pp] = [a + ax * by - ay * bx, b + ax * bx + ay * by, pp + ax * ax + ay * ay];
  }
  const [theta, s] = [Math.atan2(a, b), Math.hypot(a, b) / pp];
  const [c, sn] = [Math.cos(theta), Math.sin(theta)];
  return { s, theta, tx: mqx - s * (c * mpx - sn * mpy), ty: mqy - s * (sn * mpx + c * mpy) };
}

/**
 * Trimmed ICP from `init`: each point's nearest point on the polygon, the closest TRIM of them, then Umeyama onto
 * those (the mirror stays). It stops when the trimmed rms changes by under 1e-4 of itself, at most MAX_IT rounds.
 */
function icp(segs: readonly Seg[], pts: readonly Pt[], init: Frame): { frame: Frame; rms: number } {
  let [f, prev, rms] = [init, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (let it = 0; it < MAX_IT; it++) {
    const pairs = pts.map(([x, y]): Pair => {
      const [ux, uy] = apply(f, x, y);
      const [qx, qy] = nearest(segs, ux, uy);
      return { px: x, py: f.m * y, qx, qy, d: Math.hypot(qx - ux, qy - uy) };
    });
    const cut = pairs.map((p) => p.d).sort((a, b) => a - b)[Math.floor(TRIM * (pairs.length - 1))] as number;
    const kept = pairs.filter((p) => p.d <= cut);
    rms = Math.sqrt(kept.reduce((sum, p) => sum + p.d ** 2, 0) / kept.length);
    if (Math.abs(prev - rms) < 1e-4 * prev) break;
    prev = rms;
    f = { ...umeyama(kept), m: f.m };
  }
  return { frame: f, rms };
}

/** Every `ceil(n / max)`-th point: at most `max`. */
const every = (pts: readonly Pt[], max: number) => pts.filter((_, i) => i % Math.ceil(pts.length / max) === 0);

/**
 * F1 points onto the outline, both in metres: 16 starts screened on at most SCREEN points, the best 3 refined on at
 * most REFINE. `rms` is the trimmed residual in metres. It yields to the event loop between starts, so the 1-CPU VM
 * keeps serving the other streams.
 */
export async function fitFrame(points: readonly Pt[], outline: readonly Pt[]): Promise<{ frame: Frame; rms: number }> {
  const segs = segmentsOf(outline);
  const po = pca(
    segs.flatMap((s) => {
      const k = Math.max(1, Math.ceil(Math.sqrt(s.l2) / DENSE_M));
      return Array.from({ length: k }, (_, u): Pt => [s.ax + (s.dx * u) / k, s.ay + (s.dy * u) / k]);
    }),
  );
  const [few, all] = [every(points, SCREEN), every(points, REFINE)];
  const starts: { frame: Frame; rms: number }[] = [];
  for (const m of [1, -1] as const) {
    const pf = pca(all.map(([x, y]): Pt => [x, m * y]));
    const s = po.rms / pf.rms;
    for (let k = 0; k < 8; k++) {
      const theta = po.ang - pf.ang + (k * Math.PI) / 4;
      const [c, sn] = [Math.cos(theta), Math.sin(theta)];
      const [tx, ty] = [po.mx - s * (c * pf.mx - sn * pf.my), po.my - s * (sn * pf.mx + c * pf.my)];
      await setImmediate();
      starts.push(icp(segs, few, { s, theta, m, tx, ty }));
    }
  }
  starts.sort((a, b) => a.rms - b.rms);
  let best = { frame: (starts[0] as { frame: Frame }).frame, rms: Number.POSITIVE_INFINITY };
  for (const start of starts.slice(0, 3)) {
    await setImmediate();
    const refined = icp(segs, all, start.frame);
    if (refined.rms < best.rms) best = refined;
  }
  return best;
}

type Sample = { t: number; on: boolean; x: number; y: number };
type Candidate = { driver: number; start: number; end: number };
export type Found = { frame: Frame; rms: number; samples: number; lines: number };
/** A frame, a give-up (the same lines give it again) or the end of the lines (an open recording may have more). */
export type Fit = { outcome: 'found'; found: Found } | { outcome: 'gave_up' | 'none'; found?: undefined };
const GAVE_UP: Fit = { outcome: 'gave_up' };

const keyOf = (info: unknown) => (isObj(info) && typeof info.Key === 'number' ? info.Key : undefined);
const hasCount = (delta: unknown) =>
  isObj(delta) && isObj(delta.Lines) && Object.values(delta.Lines).some((l) => isObj(l) && 'NumberOfLaps' in l);

/** Lap n of a driver whose lap n + 1 has started, n neither an out-lap nor an in-lap. */
function* complete(laps: readonly LapRow[]): Generator<Candidate & { key: string }> {
  for (let i = 0; i + 1 < laps.length; i++) {
    const [l, next] = [laps[i] as LapRow, laps[i + 1] as LapRow];
    if (next.driver_number !== l.driver_number || next.lap_number !== l.lap_number + 1) continue;
    if (l.date_start === null || next.date_start === null || l.is_pit_out || l.is_pit_in) continue;
    const [start, end] = [Date.parse(l.date_start), Date.parse(next.date_start)];
    yield { key: `${l.driver_number} ${l.lap_number}`, driver: l.driver_number, start, end };
  }
}

/**
 * The recording's first complete on-track lap, fitted (D2). One createFeed and createLaps over the non-`.z` events,
 * as playback's apply runs them (UNPARSED skipped); `Position.z` is decoded only once a lap has a start, into a per-car
 * buffer of the last BUFFER_MS (at most BUFFER_MAX samples). After a TimingData count, the laps' rows (at most every ROWS_MS of F1
 * time) give the candidates; one is judged once the Position data reaches its end + GAP_MS, as samples arrive
 * 1.7–2.3 s late (A§6.2). It passes when every sample in [start, end) is OnTrack, at least MIN_SAMPLES over at least
 * MIN_LAP_MS, with no gap and neither edge over GAP_MS, and the fit's rms is at most MAX_RMS_M. A lap start from a
 * Subscribe state carries its receive time (limit C, about 2 s): a few points of the next lap, still on the track.
 * It gives up after CANDIDATES tries, GIVE_UP_MS of feed time after the first lap, DECODED_MAX decoded lines or
 * LINES_MAX lines read, and is none at the end of the lines. A failed decode is counted in `counts`, never thrown.
 */
export async function findFrame(
  lines: AsyncIterable<Line>,
  sessionKey: number,
  outline: string,
  counts: Record<ZFail, number>,
): Promise<Fit> {
  const shape = outlinePoints(outline);
  const feed = createFeed();
  const engine = createLaps(sessionKey, 'f1-live');
  const cars = new Map<number, Sample[]>();
  const seen = new Set<string>();
  const pending: Candidate[] = [];
  let [read, decoded, tried, reached, rowsAt] = [0, 0, 0, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let [decoding, due] = [false, false];
  let first: number | undefined; // the F1 time of the first lap

  const judge = async ({ driver, start, end }: Candidate): Promise<Found | undefined> => {
    const lap = (cars.get(driver) ?? []).filter((s) => s.t >= start && s.t < end);
    const [a, b] = [lap[0], lap.at(-1)];
    if (!a || !b || lap.length < MIN_SAMPLES || end - start < MIN_LAP_MS) return undefined;
    if (a.t - start > GAP_MS || end - b.t > GAP_MS) return undefined;
    if (lap.some((s, i) => !s.on || (i > 0 && s.t - (lap[i - 1] as Sample).t > GAP_MS))) return undefined;
    const fit = await fitFrame(
      lap.map((s): Pt => [s.x / 10, s.y / 10]),
      shape,
    );
    return fit.rms <= MAX_RMS_M ? { ...fit, samples: lap.length, lines: read } : undefined;
  };

  for await (const line of lines) {
    if (++read > LINES_MAX) return GAVE_UP;
    for (const ev of parseFeedLine(line.text)) {
      if (ev.topic === 'Position.z') {
        if (decoding && ++decoded > DECODED_MAX) return GAVE_UP;
        const z = decoding ? decodeZ(ev.payload) : undefined;
        if (z && !z.ok) counts[z.fail]++;
        for (const { t, cars: list } of z?.ok ? positions(z.value) : []) {
          reached = Math.max(reached, t);
          for (const [car, s] of list) {
            const buf = cars.get(car) ?? [];
            cars.set(car, buf);
            if (t <= (buf.at(-1)?.t ?? Number.NEGATIVE_INFINITY)) continue; // a repeat: a reconnect replays
            buf.push({ t, on: s.status === 'OnTrack', x: s.x, y: s.y });
            while (buf.length > BUFFER_MAX || (buf[0] as Sample).t < t - BUFFER_MS) buf.shift();
          }
        }
      } else if (!ev.topic.endsWith('.z') && !UNPARSED.has(ev.topic)) {
        // A new session's SessionInfo clears the state first, as in playback.
        const [key, current] = [keyOf(ev.payload), keyOf(feed.state.SessionInfo)];
        if (ev.topic === 'SessionInfo' && key !== undefined && current !== undefined && key !== current) {
          for (const topic of Object.keys(feed.state)) delete feed.state[topic];
        }
        const data = feed.apply(ev);
        if (data !== undefined) engine.push(ev, data);
        if (ev.topic === 'TimingData' && hasCount(data)) due = true;
      }
      if (due && ev.t - rowsAt >= ROWS_MS) {
        [due, rowsAt] = [false, ev.t];
        const { laps } = engine.rows();
        if (!decoding && laps.some((l) => l.date_start !== null)) [decoding, first] = [true, ev.t];
        for (const { key, ...c } of complete(laps)) {
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push(c);
        }
        pending.sort((x, y) => x.end - y.end);
      }
      if (first !== undefined && ev.t - first > GIVE_UP_MS) return GAVE_UP;
      while (pending[0] && pending[0].end + GAP_MS <= reached) {
        const found = await judge(pending.shift() as Candidate);
        if (found) return { outcome: 'found', found };
        if (++tried >= CANDIDATES) return GAVE_UP;
      }
    }
  }
  return { outcome: 'none' };
}

type Entry = { at: number; final: boolean; value: Promise<Frame | undefined> };
type Ask = { id: string; dir: string; sessionKey: number; outline: string; ended: boolean };

/**
 * The frames by recording id, one cache per api. A found frame is final, and so is a give-up, and none for an ended
 * recording; an open one whose lines ended without a frame is fitted again (re-read from its start) once AGAIN_MS
 * have passed since its last run ended, and concurrent callers share a run. The runs go one at a time per process
 * (they run outside the 8-stream cap, and a closed stream does not stop one; findFrame's budget bounds each). A
 * rejection is not cached: it is logged as its code and gives undefined. Each run logs one `playback fit` line,
 * fixed fields only.
 * ponytail: per process and unbounded, a few hundred recordings at about 100 B each; P7b's telemetry_session (A§7)
 * can replace it.
 */
export function createFrames(log: Pick<Logger, 'error' | 'info'>): {
  get(ask: Ask): Promise<Frame | undefined>;
} {
  const cache = new Map<string, Entry>();
  let queue: Promise<unknown> = Promise.resolve(); // the last run asked for: the next one starts after it
  const run = async (entry: Entry, { id, dir, sessionKey, outline, ended }: Ask) => {
    const [zc, t0] = [zCounts(), performance.now()];
    let read = 0;
    async function* counted() {
      for await (const line of recordingLines(dir)) {
        read++;
        yield line;
      }
    }
    try {
      const { outcome, found } = await findFrame(counted(), sessionKey, outline, zc);
      const ms = Math.round(performance.now() - t0);
      const [samples, rms_m] = found ? [found.samples, Math.round(found.rms * 10) / 10] : [0, null];
      log.info({ outcome, ms, lines: read, samples, rms_m, ...zc }, 'playback fit');
      [entry.final, entry.at] = [outcome !== 'none' || ended, Date.now()];
      return found?.frame;
    } catch (err) {
      if (cache.get(id) === entry) cache.delete(id);
      log.error({ cause: codeOf(err) }, 'playback fit');
      return undefined;
    }
  };
  return {
    get(ask) {
      const hit = cache.get(ask.id);
      if (hit && (hit.final || Date.now() - hit.at < AGAIN_MS)) return hit.value; // a running one has at = ∞
      const entry: Entry = { at: Number.POSITIVE_INFINITY, final: false, value: Promise.resolve(undefined) };
      cache.set(ask.id, entry);
      entry.value = queue.then(() => run(entry, ask));
      queue = entry.value.catch(() => undefined); // run never rejects; even so, one failure must not stop the queue
      return entry.value;
    },
  };
}
