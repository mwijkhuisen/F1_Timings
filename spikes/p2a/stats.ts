import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { TOPICS } from './native.ts';

// P2a stats over record.ts conn dirs, as Markdown. Aggregates only: topic names and counts, never payload values.

type Topic = { stateBytes?: number; count: number; bytes: number };
type Dir = {
  name: string;
  wallMs: number;
  connects: number;
  closes: string[];
  topics: Map<string, Topic>;
  perMinute: Map<number, number>;
  maxGapMs: number;
  latencies: number[];
  noZone: number;
  badLines: number;
  feedBytes: number;
  gzipBytes: number;
  keys: Set<string>;
  duplicates: number;
};

// A truncated last line (a killed run) must not throw: a SyntaxError quotes the line, which is F1 TV data.
const tryParse = (l: string): unknown => {
  try {
    return JSON.parse(l);
  } catch {
    return undefined;
  }
};

async function read(dir: string): Promise<Dir> {
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .map((l) => tryParse(l) as { t: number; ev: string; code?: number; ageMs: number; error?: { step: string } })
    .filter((e) => e !== undefined);
  const closes = events
    .filter((e) => e.ev === 'close')
    .map((e) => `${e.code ?? e.error?.step ?? 'client'} at ${Math.round(e.ageMs / 1000)} s`);
  const file = join(dir, 'feed.jsonl');
  const d: Dir = {
    name: basename(dir),
    wallMs: (events.at(-1)?.t ?? 0) - (events[0]?.t ?? 0),
    connects: events.filter((e) => e.ev === 'connect').length,
    closes,
    topics: new Map(),
    perMinute: new Map(),
    maxGapMs: 0,
    latencies: [],
    noZone: 0,
    badLines: 0,
    feedBytes: statSync(file).size,
    // ponytail: whole file in memory, fine for a session's ~100+ MB; stream it through createGzip if that hurts.
    gzipBytes: gzipSync(readFileSync(file)).length,
    // ponytail: one sha1 key per message held per dir, ~100 B each: a race is ~1M messages, fine for 3 dirs.
    keys: new Set(),
    duplicates: 0,
  };
  const topic = (name: string) => {
    const t = d.topics.get(name) ?? { count: 0, bytes: 0 };
    d.topics.set(name, t);
    return t;
  };
  for (const name of TOPICS) topic(name); // list subscribed topics that never arrived, too
  let firstState = true;
  let last: number | undefined;
  for await (const l of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!l) continue;
    const row = tryParse(l) as [number, string, unknown, string?] | undefined;
    if (!Array.isArray(row)) {
      d.badLines++;
      continue;
    }
    const [at, name, payload, ts] = row;
    if (name === '_subscribe') {
      if (firstState)
        for (const [k, v] of Object.entries(payload ?? {})) topic(k).stateBytes = Buffer.byteLength(JSON.stringify(v));
      firstState = false;
      last = undefined; // a reconnect window is not a feed gap
      continue;
    }
    const t = topic(name);
    t.count++;
    t.bytes += Buffer.byteLength(l) + 1;
    const minute = Math.floor(at / 60_000);
    d.perMinute.set(minute, (d.perMinute.get(minute) ?? 0) + 1);
    if (last !== undefined) d.maxGapMs = Math.max(d.maxGapMs, at - last);
    last = at;
    // A timestamp without a zone would parse as local time and pass an offset off as latency: count those apart.
    const sent = /(Z|[+-]\d\d:?\d\d)$/.test(ts ?? '') ? Date.parse(ts ?? '') : Number.NaN;
    if (Number.isNaN(sent)) d.noZone++;
    else d.latencies.push(at - sent);
    const key = `${name}|${ts}|${createHash('sha1').update(JSON.stringify(payload)).digest('hex')}`;
    if (d.keys.has(key)) d.duplicates++;
    else d.keys.add(key);
  }
  return d;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

const dirs = await Promise.all(process.argv.slice(2).map(read));
if (dirs.length === 0) {
  console.error('usage: stats.ts <conn dir>...');
  process.exit(2);
}
const out: string[] = [];
for (const d of dirs) {
  const hours = d.wallMs / 3_600_000;
  const msgs = [...d.topics.values()].reduce((n, t) => n + t.count, 0);
  const lat = [...d.latencies].sort((a, b) => a - b);
  out.push(
    `## ${d.name}`,
    '',
    `- wall time ${(d.wallMs / 1000).toFixed(0)} s, ${d.connects} connects, closes: ${d.closes.join('; ') || 'none'}`,
    `- ${msgs} feed messages, ${(msgs / (d.wallMs / 1000)).toFixed(2)} msg/s mean, peak ${Math.max(0, ...d.perMinute.values())} in one minute`,
    `- ${kb(d.feedBytes / hours)}/h raw, ${kb(d.gzipBytes / hours)}/h gzip (feed.jsonl ${kb(d.feedBytes)}, gzip ${kb(d.gzipBytes)})`,
    `- largest feed gap outside reconnects ${(d.maxGapMs / 1000).toFixed(1)} s; ${d.duplicates} duplicates; ${d.badLines} unparsable lines`,
    `- latency receivedAt − ts: median ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms (${lat.length} samples, ${d.noZone} without a zone)`,
    '',
    '| topic | in first state | state bytes | feed msgs | feed bytes |',
    '| --- | --- | --- | --- | --- |',
    ...[...d.topics]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([n, t]) =>
          `| ${n} | ${t.stateBytes === undefined ? 'no' : 'yes'} | ${t.stateBytes ?? '—'} | ${t.count} | ${t.bytes} |`,
      ),
    '',
  );
}
if (dirs.length > 1) {
  const names = [...new Set(dirs.flatMap((d) => [...d.topics.keys()]))].sort();
  out.push(
    '## Topics × dirs (feed messages)',
    '',
    `| topic | ${dirs.map((d) => d.name).join(' | ')} |`,
    `| --- |${' --- |'.repeat(dirs.length)}`,
    ...names.map((n) => `| ${n} | ${dirs.map((d) => d.topics.get(n)?.count || '—').join(' | ')} |`),
    '',
    '## Pairs (key topic|ts|sha1(payload))',
    '',
    '| A | B | in A, missing from B | duplicates in A |',
    '| --- | --- | --- | --- |',
  );
  for (const a of dirs) {
    for (const b of dirs) {
      if (a === b) continue;
      let missing = 0;
      for (const k of a.keys) if (!b.keys.has(k)) missing++;
      out.push(`| ${a.name} | ${b.name} | ${missing} | ${a.duplicates} |`);
    }
  }
}
console.log(out.join('\n'));
