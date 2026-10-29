import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import * as lib from './lib.ts';
import type { Closed, Conn } from './native.ts';
import * as native from './native.ts';

// P2a recorder: one loop per --conn, each with its own feed.jsonl and events.jsonl (A§11.2). Console output never
// carries a token, a connectionToken, a cookie or a payload; payloads go to disk under fixtures-private/ only.

type Spec = { client: 'native' | 'lib'; auth: 'token' | 'anon'; dropMin?: number; name: string };
type Token = { value: string; expiresAt: number }; // login.ts: epoch ms

const USAGE =
  'usage: record.ts --label <[a-z0-9-]+> [--start <ISO>] --stop <ISO> --out <dir under fixtures-private/> ' +
  '--conn <native|lib>:<token|anon>[:drop=<minutes>] ...';

const secrets: string[] = [];
function log(line: string): void {
  const redact = secrets.some((s) => s.length > 0 && line.includes(s));
  console.log(`${new Date().toISOString()} ${redact ? '[redacted]' : line}`);
}
function usage(why: string): never {
  log(`${why}\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    start: { type: 'string' },
    stop: { type: 'string' },
    out: { type: 'string' },
    conn: { type: 'string', multiple: true },
  },
});
const label = values.label ?? '';
if (!/^[a-z0-9-]+$/.test(label)) usage('bad --label');
const startAt = values.start === undefined ? Date.now() : Date.parse(values.start);
const stopAt = Date.parse(values.stop ?? '');
if (Number.isNaN(startAt) || Number.isNaN(stopAt) || stopAt <= startAt) usage('bad --start/--stop');
// Node clamps a timer past 24.8 days to 1 ms, which would start the run at once.
if (stopAt - Date.now() > 7 * 86_400_000) usage('--stop is more than 7 days ahead');
const out = resolve(values.out ?? '');
// Invariant 3: F1 feed data lives only in a git-ignored fixtures-private/, in whichever checkout (the main one keeps
// the recordings when the worktree goes). `git check-ignore` exits 0 only for an ignored path inside a repository.
const ignored = () => {
  try {
    mkdirSync(out, { recursive: true });
    execFileSync('git', ['-C', out, 'check-ignore', '-q', '.']);
    return true;
  } catch {
    return false;
  }
};
if (!`${out}/`.includes('/fixtures-private/') || !ignored())
  usage('--out must be a git-ignored fixtures-private/ path');
const specs: Spec[] = (values.conn ?? []).map((c) => {
  const m = /^(native|lib):(token|anon)(?::drop=(\d+))?$/.exec(c);
  if (!m) usage(`bad --conn ${c}`);
  return {
    client: m[1] as Spec['client'],
    auth: m[2] as Spec['auth'],
    dropMin: m[3] ? Number(m[3]) : undefined,
    name: `${label}-${m[1]}-${m[2]}`,
  };
});
if (specs.length === 0) usage('no --conn');
if (new Set(specs.map((s) => s.name)).size !== specs.length) usage('two --conn write the same directory');

const stopAc = new AbortController();
const stop = () => stopAc.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const nap = (ms: number) => sleep(ms, undefined, { signal: stopAc.signal }).catch(() => {});

// Token conns share one login and one re-login (A§12.3). Dynamic import: anon-only runs never load login.ts.
let token: Token | undefined;
let relogin: (() => Promise<void>) | undefined;
if (specs.some((s) => s.auth === 'token')) {
  const { credentials, login } = await import('./login.ts');
  const creds = credentials();
  if (!creds) {
    log('missing file secrets f1tv_username/f1tv_password');
    process.exit(78);
  }
  secrets.push(...Object.values(creds).filter((v): v is string => typeof v === 'string'));
  let pending: Promise<void> | undefined;
  relogin = () => {
    pending ??= login(creds)
      .then((t: Token) => {
        token = t;
        secrets.push(t.value);
        log(`login ok, expires ${new Date(t.expiresAt).toISOString()}`);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

if (Date.now() < startAt) log(`waiting until ${new Date(startAt).toISOString()}`);
await nap(Math.max(0, startAt - Date.now()));
if (stopAc.signal.aborted) process.exit(0); // stopped while waiting: no login, nothing written
// The login runs at --start, not at launch: a run launched days ahead gets a fresh token (A§12.3).
if (relogin) {
  try {
    await relogin();
  } catch (err) {
    // A LoginError's message is fixed text (login.ts); anything else prints its name only.
    log(err instanceof Error && err.name === 'LoginError' ? err.message : `login failed (${(err as Error)?.name})`);
    process.exit(1);
  }
}
const stopTimer = setTimeout(stop, Math.max(0, stopAt - Date.now()));
const live = new Set<Conn>();
stopAc.signal.addEventListener('abort', () => {
  for (const c of live) c.close();
});

function line(stream: WriteStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}
const ended = (s: WriteStream) => new Promise((res) => s.end(res));

async function run(spec: Spec): Promise<string[]> {
  const dir = join(out, spec.name);
  mkdirSync(dir, { recursive: true });
  const feed = createWriteStream(join(dir, 'feed.jsonl'), { flags: 'a' });
  const events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a' });
  const ev = (name: string, extra: object = {}) => line(events, { t: Date.now(), ev: name, ...extra });
  const client = spec.client === 'native' ? native : lib;
  let backoff = 1_000;
  let first = true;

  while (!stopAc.signal.aborted) {
    const t0 = Date.now();
    ev('connect');
    const conn = client.connect(
      spec.auth === 'token' ? token?.value : undefined,
      (topic, payload, ts, receivedAt) => line(feed, [receivedAt, topic, payload, ts]),
      (step) => ev(step),
    );
    live.add(conn);
    conn.subscribed.then(
      (result) => {
        line(feed, [Date.now(), '_subscribe', result]);
        const topics = Object.keys((result ?? {}) as object);
        ev('subscribed', { topics, bytes: Buffer.byteLength(JSON.stringify(result ?? null)) });
        log(`${spec.name}: subscribed, ${topics.length} topics in the state`);
      },
      () => {},
    );
    let drop: ReturnType<typeof setTimeout> | undefined;
    if (first && spec.dropMin !== undefined) {
      drop = setTimeout(() => {
        ev('drop');
        log(`${spec.name}: forced drop`);
        conn.close();
      }, spec.dropMin * 60_000);
    }
    first = false;

    const c: Closed = await conn.closed;
    clearTimeout(drop);
    live.delete(conn);
    const ageMs = Date.now() - t0;
    ev('close', { code: c.code, reason: c.reason, allowReconnect: c.allowReconnect, ageMs, error: c.error });
    log(
      `${spec.name}: closed after ${Math.round(ageMs / 1000)} s, code ${c.code ?? '-'}, ${JSON.stringify(c.error ?? {})}`,
    );
    if (stopAc.signal.aborted) break;

    if (ageMs > 60_000) backoff = 1_000;
    const negotiate401 = c.error?.status === 401 && (c.error.step === 'negotiate' || c.error.step === 'lib');
    if (negotiate401 && spec.auth === 'token' && relogin) {
      await relogin().catch((err: unknown) => log(`${spec.name}: re-login failed (${(err as Error)?.name})`));
    }
    await nap(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
  ev('stop');
  await Promise.all([ended(feed), ended(events)]);
  return [join(dir, 'feed.jsonl'), join(dir, 'events.jsonl')];
}

log(`recording ${specs.map((s) => s.name).join(', ')} until ${new Date(stopAt).toISOString()}`);
const files = (await Promise.all(specs.map(run))).flat();
clearTimeout(stopTimer);

// The held secrets must not have reached any output file.
const hits = files.filter((f) => {
  const buf = readFileSync(f);
  return secrets.some((s) => s.length > 0 && buf.indexOf(s) !== -1);
});
log(hits.length === 0 ? 'secret-scan: clean' : `secret-scan: found in ${hits.join(', ')}`);
process.exit(hits.length === 0 ? 0 : 1);
