import type { Server } from 'node:http';
import { resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import pino from 'pino';
import { access, accessConfig } from './api/access.ts';
import { createApp } from './api/app.ts';
import { ARCHIVE_DIR, archive, TOKEN_FILE } from './archive/job.ts';
import { codeOf, createDb } from './db/db.ts';
import { dbUrl, EXIT_CONFIG, runMigrate } from './db/migrate.ts';
import { pingHealthchecks } from './healthchecks.ts';
import { healthy, startHeartbeat, touch } from './heartbeat.ts';
import { backfill, processSession, startIngest } from './ingest/ingest.ts';
import { LIVE_DIR, startRecorder } from './live/recorder.ts';
import { fill } from './merge/fill.ts';
import { createClient, systemClock } from './openf1/client.ts';
import { createBudget, createRainClient } from './rain/client.ts';
import { createRainStep } from './rain/job.ts';

/** Roles of the single server image (A§4); the first argument picks one. */
export const ROLES = [
  'api',
  'ingest',
  'live',
  'migrate',
  'healthcheck',
  'refetch',
  'backfill',
  'archive',
  'fill',
] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_USAGE = 64;
/** Caddy proxies /api to api:8080 (P1f). */
export const API_PORT = 8080;

type Env = Readonly<Record<string, string | undefined>>;

const USAGE =
  `usage: main.js <${ROLES.join('|')}> (refetch takes a session_key; ` +
  'archive <year 2018-2022> [<session_key>...] [--token-file <path>] [--dir <path>]; ' +
  'fill <session_key>...|--all [--archive-dir <path>] [--live-dir <path>])';

/**
 * Resolves with the exit code. `apiPort` is a test seam only (not configurable in production: Caddy proxies to api:8080).
 */
export async function run(
  argv: readonly string[],
  env: Env,
  log: (line: string) => void = (line) => console.error(line),
  apiPort = API_PORT,
): Promise<number> {
  const [role, ...rest] = argv;
  const usage = () => {
    log(USAGE);
    return EXIT_USAGE;
  };
  if (!isRole(role)) return usage();
  if (role === 'archive') return runArchive(rest, env, log);
  if (role === 'fill') return runFill(rest, env, log);
  if (rest.length !== (role === 'refetch' ? 1 : 0) || (role === 'refetch' && !/^\d{1,9}$/.test(rest[0] ?? ''))) {
    return usage();
  }
  if (role === 'healthcheck') return healthy() ? 0 : 1;
  if (role === 'migrate') return runMigrate(env, log);
  if (role === 'api') return runApi(env, log, apiPort);
  if (role === 'ingest' || role === 'backfill' || role === 'refetch') return runIngest(role, Number(rest[0]), env, log);
  if (role === 'live') return runLive(env, log);
  role satisfies never; // a new role fails to compile until it is dispatched above
  return usage();
}

const isRole = (role: string | undefined): role is Role => (ROLES as readonly string[]).includes(role ?? '');

/** The f1_ingest roles (A§8): the daemon, the backfill job and `refetch <session_key>`. */
async function runIngest(role: 'ingest' | 'backfill' | 'refetch', key: number, env: Env, log: (line: string) => void) {
  const url = dbUrl('f1_ingest', env);
  if (typeof url === 'string') {
    log(`${role}: ${url}`);
    return EXIT_CONFIG;
  }
  const logger = pino({ base: { role } });
  // An idle-connection error must not crash the process; the pool reconnects.
  const db = createDb(url, (err) => logger.error({ cause: codeOf(err) }, 'database pool error'));
  const beat = () => touch();
  // Only the daemon's scheduleSync pings; the backfill and refetch jobs never reach it.
  const ping = (slug: string) => pingHealthchecks(slug, logger);
  const deps = { db, client: createClient({ onAttempt: beat }), now: () => new Date(), log: logger, beat, ping };
  try {
    if (role === 'ingest') {
      // Only the daemon has a rain step (P5c); the backfill and refetch jobs never fetch rain.
      const rain = { client: createRainClient({ onAttempt: beat }), budget: createBudget(systemClock) };
      await startIngest({ ...deps, rainStep: createRainStep({ ...deps, ...rain }) });
      return 0;
    }
    if (role === 'backfill') return (await backfill(deps)) ? 0 : 1;
    return (await processSession(deps, key, true)).ok ? 0 : 1;
  } catch (err) {
    logger.error({ cause: codeOf(err) }, `${role} failed`); // the code only: a message could quote a value
    return 1;
  } finally {
    await db.destroy();
  }
}

/** The archive job (A§6.2, P3a) as f1_ingest: years 2018–2022 only, 2023 on is OpenF1's. */
async function runArchive(argv: readonly string[], env: Env, log: (line: string) => void): Promise<number> {
  let parsed: ReturnType<typeof parseArchive>;
  try {
    parsed = parseArchive(argv);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const url = dbUrl('f1_ingest', env);
  if (typeof url === 'string') {
    log(`archive: ${url}`);
    return EXIT_CONFIG;
  }
  const logger = pino({ base: { role: 'archive' } });
  const db = createDb(url, (err) => logger.error({ cause: codeOf(err) }, 'database pool error'));
  try {
    return (await archive({ db, now: () => new Date(), sleep: (ms) => sleep(ms), log: logger }, parsed)) ? 0 : 1;
  } catch (err) {
    logger.error({ cause: codeOf(err) }, 'archive failed');
    return 1;
  } finally {
    await db.destroy();
  }
}

/** `<year> [<session_key>…] [--token-file <path>] [--dir <path>]`, or undefined; parseArgs throws on an unknown flag. */
function parseArchive(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { 'token-file': { type: 'string', default: TOKEN_FILE }, dir: { type: 'string', default: ARCHIVE_DIR } },
  });
  const [year = '', ...keys] = positionals;
  if (!/^20(1[89]|2[0-2])$/.test(year) || !keys.every((k) => /^\d{1,9}$/.test(k))) return undefined;
  if (!privateDir(values.dir, ARCHIVE_DIR)) return undefined;
  return { year: Number(year), keys: keys.map(Number), tokenFile: values['token-file'], dir: values.dir };
}

/**
 * Real F1 files are read and written only where git never sees them (invariant 3): the VM's own directory (`standard`),
 * or one with a path segment named exactly `fixtures-private` (gitignored).
 */
const privateDir = (dir: string, standard: string) => {
  const path = resolve(dir);
  return path === standard || path.split(sep).includes('fixtures-private');
};

/** The fill job (P3b): the files of the archive and of the recorder into the lap merge, as f1_ingest. No network. */
async function runFill(argv: readonly string[], env: Env, log: (line: string) => void): Promise<number> {
  let parsed: ReturnType<typeof parseFill>;
  try {
    parsed = parseFill(argv);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const url = dbUrl('f1_ingest', env);
  if (typeof url === 'string') {
    log(`fill: ${url}`);
    return EXIT_CONFIG;
  }
  const logger = pino({ base: { role: 'fill' } });
  const db = createDb(url, (err) => logger.error({ cause: codeOf(err) }, 'database pool error'));
  try {
    return (await fill({ db, log: logger }, parsed)) ? 0 : 1;
  } catch (err) {
    logger.error({ cause: codeOf(err) }, 'fill failed');
    return 1;
  } finally {
    await db.destroy();
  }
}

/** `<session_key>… | --all`, then `[--archive-dir <path>] [--live-dir <path>]`, or undefined; parseArgs throws on an unknown flag. */
function parseFill(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      'archive-dir': { type: 'string', default: ARCHIVE_DIR },
      'live-dir': { type: 'string', default: LIVE_DIR },
    },
  });
  const keys = values.all ? positionals.length === 0 : positionals.length > 0; // keys xor --all
  if (!keys || !positionals.every((k) => /^\d{1,9}$/.test(k))) return undefined;
  const [archiveDir, liveDir] = [values['archive-dir'], values['live-dir']];
  if (!privateDir(archiveDir, ARCHIVE_DIR) || !privateDir(liveDir, LIVE_DIR)) return undefined;
  return { keys: values.all ? ('all' as const) : positionals.map(Number), archiveDir, liveDir };
}

/** The recorder daemon (A§11.2), as f1_ingest. Resolves after SIGTERM/SIGINT, with the running recording closed. */
async function runLive(env: Env, log: (line: string) => void): Promise<number> {
  const url = dbUrl('f1_ingest', env);
  if (typeof url === 'string') {
    log(`live: ${url}`);
    return EXIT_CONFIG;
  }
  const logger = pino({ base: { role: 'live' } });
  const db = createDb(url, (err) => logger.error({ cause: codeOf(err) }, 'database pool error'));
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    await startRecorder({
      db,
      now: () => new Date(),
      log: logger,
      beat: () => touch(),
      ping: (slug) => pingHealthchecks(slug, logger),
      signal: stop.signal,
    });
    return 0;
  } catch (err) {
    logger.error({ cause: codeOf(err) }, 'live failed');
    return 1;
  } finally {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    await db.destroy();
  }
}

/** The api daemon (A§10): read-only as f1_api, behind the Access JWT. Resolves after SIGTERM/SIGINT. */
async function runApi(env: Env, log: (line: string) => void, port: number): Promise<number> {
  const config = accessConfig(env);
  if (typeof config === 'string') {
    log(`api: ${config} is missing or malformed`);
    return EXIT_CONFIG;
  }
  const url = dbUrl('f1_api', env);
  if (typeof url === 'string') {
    log(`api: ${url}`);
    return EXIT_CONFIG;
  }
  const logger = pino({ base: { role: 'api' } });
  const db = createDb(url, (err) => logger.error({ cause: codeOf(err) }, 'database pool error'));
  const app = createApp({ db, access: access(config, logger), log: logger, liveDir: LIVE_DIR });
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }) as Server; // plain http: no createServer option
  const listening = await new Promise<boolean>((resolve) => {
    server.once('listening', () => resolve(true));
    server.once('error', (err) => {
      logger.error({ cause: codeOf(err) }, 'api failed to listen');
      resolve(false);
    });
  });
  if (!listening) {
    await db.destroy();
    return 1;
  }
  const stopHeartbeat = startHeartbeat();
  logger.info({ port }, 'listening');
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  logger.info({}, 'stopping');
  stopHeartbeat();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections(); // an open SSE stream would hold close() for good
  await closed;
  await db.destroy();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
