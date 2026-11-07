import { parseArgs } from 'node:util';
import { createFeed } from '../apps/server/src/live/merge.ts';
import type { FeedEvent } from '../apps/server/src/live/read.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { view } from '../packages/contracts/src/index.ts';
import { readInput } from './compare-laps.ts';
import { safe } from './fetch-archive.ts';

// The keys one feed topic carries, per session (A§11.3): every key path in the topic's messages, with the number of
// messages that carry it. Array indices and numeric keys (driver numbers, sectors, qualifying parts) print as #. A
// recording groups its messages by the SessionInfo Key and Type in force when each arrived, because a feed joined
// before its session first shows the previous one (the session gate); an archive is one session. For [U] checks of
// the feed format on the owner's machine, such as the tower's gap fields per session type (A§13). It reads local
// files only and prints key names and counts, never a value, so its output can go into a PR.

const USAGE = 'usage: feed-keys.ts [--topic <name>] <feed.jsonl | recording dir | archive dir>…';
const MAX_DEPTH = 32; // as merge() (A§11.3): input is untrusted

/** Every key path in `value`, numeric keys and array indices as `#`. A leaf, or an empty object or array, ends one. */
export function keyPaths(value: unknown, into = new Set<string>(), prefix = '', depth = 0): Set<string> {
  const keys = typeof value === 'object' && value !== null && depth < MAX_DEPTH ? Object.keys(value) : [];
  if (keys.length === 0 && prefix !== '') into.add(prefix);
  for (const key of keys) {
    const name = /^\d+$/.test(key) ? '#' : key;
    keyPaths((value as Record<string, unknown>)[key], into, prefix === '' ? name : `${prefix}.${name}`, depth + 1);
  }
  return into;
}

type Group = { messages: number; paths: Map<string, number> };

/** `<Key> <Type>` of the SessionInfo in `state`, `?` for what is missing. */
function label(state: Record<string, unknown>): string {
  const info = view(state, 'SessionInfo');
  return `${info?.Key ?? '?'} ${info?.Type ?? '?'}`;
}

/** The topic's messages by session label, in the order the labels first appear. */
export function census(events: readonly FeedEvent[], topic: string, archive: boolean): Map<string, Group> {
  const feed = createFeed();
  let whole: string | undefined; // an archive's one session: its final SessionInfo
  if (archive) {
    const first = createFeed();
    for (const ev of events) first.apply(ev);
    whole = label(first.state);
  }
  const groups = new Map<string, Group>();
  for (const ev of events) {
    feed.apply(ev);
    if (ev.topic !== topic) continue;
    const key = whole ?? label(feed.state);
    const group = groups.get(key) ?? { messages: 0, paths: new Map<string, number>() };
    group.messages++;
    for (const path of keyPaths(ev.payload)) group.paths.set(path, (group.paths.get(path) ?? 0) + 1);
    groups.set(key, group);
  }
  return groups;
}

export async function feedKeys(argv: readonly string[], log: (line: string) => void = (l) => console.log(l)) {
  let topic: string;
  let inputs: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { topic: { type: 'string', default: 'TimingData' } },
    });
    [topic, inputs] = [parsed.values.topic, parsed.positionals];
  } catch {
    [topic, inputs] = ['', []];
  }
  if (inputs.length === 0) {
    log(USAGE);
    return EXIT_USAGE;
  }
  for (const name of inputs) {
    log(`== ${name}`);
    const input = await readInput(name);
    if (input === undefined) {
      log('feed-keys: input (unreadable, or an archive without a Heartbeat t0)');
      return 1;
    }
    log(`events ${input.events.length}, skipped lines ${input.skipped}`);
    const groups = census(input.events, topic, input.archiveDir !== undefined);
    if (groups.size === 0) log(safe(`no ${topic} messages`));
    for (const [session, group] of groups) {
      log(safe(`session ${session}: ${topic} ${group.messages} messages`));
      for (const [path, n] of [...group.paths].sort(([a], [b]) => (a < b ? -1 : 1))) log(safe(`  ${path} ${n}`));
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await feedKeys(process.argv.slice(2));
}
