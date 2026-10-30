import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { normaliseSession } from '../apps/server/src/ingest/normalise.ts';
import { createLaps } from '../apps/server/src/live/laps.ts';
import { createFeed, merge } from '../apps/server/src/live/merge.ts';
import { archiveT0, type FeedEvent, parseFeedLine, parseJsonStream } from '../apps/server/src/live/read.ts';
import { view } from '../apps/server/src/live/state.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { createClient } from '../apps/server/src/openf1/client.ts';
import { parse } from '../apps/server/src/openf1/schemas.ts';
import { safe } from './fetch-archive.ts';

// The P2b [box] judge: laps reconstructed from a P2a recording (feed.jsonl or its directory) or an
// archive directory (fetch-archive.ts) against OpenF1's laps and stints. Run on the owner's machine
// only: CI never calls OpenF1 (A§12.1 invariant 4). It prints lap and stint numbers, times and the
// compared fields, plus merge paths; never a raw payload value.

const USAGE = 'usage: compare-laps.ts <feed.jsonl | recording dir | archive dir>…';
export const BAR = 0.99;
const EXAMPLES = 10;

export type Row = { driver_number: number; [field: string]: unknown };
export type Diff = { driver: number; n: number | string; field: string; theirs: unknown; ours: unknown };
export type Extra = { count: number; examples: Diff[] };

const TIME_FIELDS = ['lap_ms', 's1_ms', 's2_ms', 's3_ms'];
const EXTRA_FIELDS = ['is_pit_out', 'is_pit_in', 'i1_kph', 'i2_kph', 'st_kph', 'seg1', 'seg2', 'seg3', 'date_start'];
const STINT_FIELDS = ['lap_start', 'lap_end', 'compound', 'tyre_age_at_start'];

const nul = (v: unknown) => v ?? null;
const epoch = (v: unknown) => (v === null ? null : new Date(v as string | Date).getTime());
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const within1 = (a: unknown, b: unknown) =>
  a === null || b === null ? a === b : typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1;

/** `date_start` differs by more than 1 s, segments as lists, everything else strictly. */
function differs(field: string, ours: unknown, theirs: unknown): boolean {
  if (field === 'date_start') {
    const [a, b] = [epoch(ours), epoch(theirs)];
    return a === null || b === null ? a !== b : Math.abs(a - b) > 1000;
  }
  return JSON.stringify(ours) !== JSON.stringify(theirs);
}

const byKey = (rows: readonly Row[], number: string) =>
  new Map(rows.map((r) => [`${r.driver_number}/${r[number]}`, r] as const));
const order = (a: string, b: string) => {
  const [d1 = 0, n1 = 0] = a.split('/').map(Number);
  const [d2 = 0, n2 = 0] = b.split('/').map(Number);
  return d1 - d2 || n1 - n2;
};

/**
 * Laps by (driver, lap): `matched` has both sides and every time field within 1 ms (or both null);
 * `rate` is matched over the union of keys. A lap on one side only is a mismatch with field `lap`.
 */
export function compareLaps(ours: readonly Row[], theirs: readonly Row[]) {
  const [o, t] = [byKey(ours, 'lap_number'), byKey(theirs, 'lap_number')];
  const mismatches: Diff[] = [];
  const extras = Object.fromEntries(EXTRA_FIELDS.map((f) => [f, { count: 0, examples: [] } as Extra]));
  let matched = 0;
  const keys = [...new Set([...o.keys(), ...t.keys()])].sort(order);
  for (const key of keys) {
    const [a, b] = [o.get(key), t.get(key)];
    const [driver = 0, n = 0] = key.split('/').map(Number);
    if (a === undefined || b === undefined) {
      mismatches.push({ driver, n, field: 'lap', theirs: b ? 'present' : 'missing', ours: a ? 'present' : 'missing' });
      continue;
    }
    const bad = TIME_FIELDS.filter((f) => !within1(nul(a[f]), nul(b[f])));
    for (const field of bad) mismatches.push({ driver, n, field, theirs: nul(b[field]), ours: nul(a[field]) });
    if (bad.length === 0) matched++;
    for (const field of EXTRA_FIELDS) {
      if (!differs(field, nul(a[field]), nul(b[field]))) continue;
      const extra = extras[field] as Extra;
      extra.count++;
      if (extra.examples.length < EXAMPLES) {
        extra.examples.push({ driver, n, field, theirs: nul(b[field]), ours: nul(a[field]) });
      }
    }
  }
  return {
    ours: o.size,
    theirs: t.size,
    matched,
    union: keys.length,
    rate: keys.length ? matched / keys.length : 0,
    mismatches,
    extras,
  };
}

/** Every stint difference by (driver, stint): a stint on one side only, or a differing field. */
export function compareStints(ours: readonly Row[], theirs: readonly Row[]): Diff[] {
  const [o, t] = [byKey(ours, 'stint_number'), byKey(theirs, 'stint_number')];
  const out: Diff[] = [];
  for (const key of [...new Set([...o.keys(), ...t.keys()])].sort(order)) {
    const [a, b] = [o.get(key), t.get(key)];
    const [driver = 0, n = 0] = key.split('/').map(Number);
    if (a === undefined || b === undefined) {
      out.push({ driver, n, field: 'stint', theirs: b ? 'present' : 'missing', ours: a ? 'present' : 'missing' });
      continue;
    }
    for (const field of STINT_FIELDS) {
      if (nul(a[field]) !== nul(b[field])) out.push({ driver, n, field, theirs: nul(b[field]), ours: nul(a[field]) });
    }
  }
  return out;
}

/** The first path where two states differ (never a value), or undefined when equal. */
export function firstDiff(a: unknown, b: unknown, path = ''): string | undefined {
  if (!isObj(a) || !isObj(b)) return Object.is(a, b) ? undefined : path;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(key in a) || !(key in b)) return `${path}.${key}`;
    const d = firstDiff(a[key], b[key], `${path}.${key}`);
    if (d !== undefined) return d;
  }
  return undefined;
}

/** `merge <Topic>: …` for one `<Topic>.json` against the merged stream's state of that topic. */
export function mergeCheck(topic: string, state: Record<string, unknown>, json: unknown): string {
  let expected = json;
  if (isObj(json)) {
    const target = {};
    merge(target, json);
    expected = target;
  }
  const d = firstDiff(state[topic], expected);
  return safe(`merge ${topic}: ${d === undefined ? 'equal' : `differs at ${d || '(root)'}`}`);
}

const show = (v: unknown) => JSON.stringify(v);
const line = (d: Diff, what: string) =>
  safe(`  driver ${d.driver} ${what} ${d.n} ${d.field}: openf1 ${show(d.theirs)} ours ${show(d.ours)}`);

export type Input = { events: FeedEvent[]; archiveDir?: string; skipped: number };

/** A recording (feed.jsonl or a directory holding it) or an archive directory → events. */
export async function readInput(input: string): Promise<Input | undefined> {
  try {
    const dir = statSync(input).isDirectory();
    const feed = dir ? join(input, 'feed.jsonl') : input;
    if (!dir || readdirSync(input).includes('feed.jsonl')) {
      const events: FeedEvent[] = [];
      for await (const l of createInterface({ input: createReadStream(feed), crlfDelay: Number.POSITIVE_INFINITY })) {
        events.push(...parseFeedLine(l));
      }
      return { events, skipped: 0 };
    }
    const files = readdirSync(input)
      .filter((f) => f.endsWith('.jsonStream'))
      .sort();
    const text = (f: string) => readFileSync(join(input, f), 'utf8');
    const t0 = archiveT0(
      files.includes('Heartbeat.jsonStream')
        ? parseJsonStream(text('Heartbeat.jsonStream'), 'Heartbeat', 0).events
        : [],
    );
    if (t0 === undefined) return undefined;
    let skipped = 0;
    // Stable sort: events at the same t stay in file-name order.
    const events = files.flatMap((f) => {
      const parsed = parseJsonStream(text(f), f.slice(0, -'.jsonStream'.length), t0);
      skipped += parsed.skipped;
      return parsed.events;
    });
    return { events: events.sort((a, b) => a.t - b.t), archiveDir: input, skipped };
  } catch {
    return undefined;
  }
}

/** Our rows. Two passes: the first finds the session key and type (SessionInfo), the second builds the rows. */
export function reconstruct(events: readonly FeedEvent[], source: 'f1-live' | 'f1-archive') {
  const first = createFeed();
  for (const ev of events) first.apply(ev);
  const info = view(first.state, 'SessionInfo');
  if (info?.Key === undefined) return { state: first.state, info };
  const [feed, laps] = [createFeed(), createLaps(info.Key, source)];
  for (const ev of events) {
    const delta = feed.apply(ev);
    if (delta !== undefined) laps.push(ev, delta);
  }
  return { state: first.state, info, rows: laps.rows() };
}

export type Oracle = (key: number, type: string | null) => Promise<{ laps: Row[]; stints: Row[] } | string>;

/** OpenF1's laps and stints as the ingest stores them. A failure is a fixed code, e.g. a live-window 401. */
export const openf1: Oracle = async (key, type) => {
  const client = createClient();
  const [laps, stints] = [
    await client.get('laps', { session_key: key }),
    await client.get('stints', { session_key: key }),
  ];
  if (!laps.ok) return JSON.stringify(laps.error);
  if (!stints.ok) return JSON.stringify(stints.error);
  const [l, s] = [parse('laps', laps.value.body), parse('stints', stints.value.body)];
  if (!l.ok || !s.ok) return 'shape';
  const data = { laps: l.value, stints: s.value, drivers: [], pit: [], race_control: [], session_result: [] };
  const { rows } = normaliseSession(key, data, type);
  return { laps: rows.lap, stints: rows.stint };
};

export async function compare(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (l) => console.log(l),
  oracle: Oracle = openf1,
): Promise<number> {
  if (env.CI) {
    log('compare-laps refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  let inputs: string[];
  try {
    inputs = parseArgs({ args: [...argv], allowPositionals: true, options: {} }).positionals;
  } catch {
    inputs = [];
  }
  if (inputs.length === 0) {
    log(USAGE);
    return EXIT_USAGE;
  }

  let exit = 0;
  for (const name of inputs) {
    log(`== ${name}`);
    const input = await readInput(name);
    if (input === undefined) {
      log('compare-laps: input (unreadable, or an archive without a Heartbeat t0)');
      return 1;
    }
    const { state, info, rows } = reconstruct(input.events, input.archiveDir ? 'f1-archive' : 'f1-live');
    log(`events ${input.events.length}, skipped lines ${input.skipped}`);
    if (info?.Key === undefined || rows === undefined) {
      log('session: no SessionInfo.Key in the feed');
      exit = 1;
      continue;
    }
    log(`session ${info.Key} type ${safe(info.Type ?? 'unknown')}`);
    const theirs = await oracle(info.Key, info.Type ?? null);
    if (typeof theirs === 'string') {
      log(`compare-laps: openf1 ${theirs}`);
      return 1;
    }
    const laps = compareLaps(rows.laps, theirs.laps);
    log(
      `laps: ours ${laps.ours}, openf1 ${laps.theirs}${laps.theirs === 0 ? ' (none under this session key: is SessionInfo.Key the OpenF1 key?)' : ''}`,
    );
    log(
      `matched ${laps.matched} of ${laps.union} (${(laps.rate * 100).toFixed(2)}%): ${laps.rate >= BAR ? 'PASS' : 'FAIL'}`,
    );
    for (const d of laps.mismatches) log(line(d, 'lap'));
    for (const [field, extra] of Object.entries(laps.extras)) {
      if (extra.count === 0) continue;
      log(
        `${field}: ${extra.count} differ${field === 'date_start' ? ' by more than 1 s' : ''}, first ${extra.examples.length}`,
      );
      for (const d of extra.examples) log(line(d, 'lap'));
    }
    const stints = compareStints(rows.stints, theirs.stints);
    log(`stints: ours ${rows.stints.length}, openf1 ${theirs.stints.length}, ${stints.length} differences`);
    for (const d of stints) log(line(d, 'stint'));
    if (input.archiveDir !== undefined) {
      for (const f of readdirSync(input.archiveDir)
        .filter((f) => f.endsWith('.json'))
        .sort()) {
        try {
          const json: unknown = JSON.parse(readFileSync(join(input.archiveDir, f), 'utf8').replace(/^﻿/, ''));
          log(mergeCheck(f.slice(0, -'.json'.length), state, json));
        } catch {
          log(`merge ${f.slice(0, -'.json'.length)}: unreadable`);
        }
      }
    }
    if (laps.rate < BAR) exit = 1;
  }
  return exit;
}

if (import.meta.main) {
  process.exitCode = await compare(process.argv.slice(2), process.env);
}
