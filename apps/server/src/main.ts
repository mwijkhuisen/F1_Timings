import { serve } from '@hono/node-server';
import pino from 'pino';
import { access, accessConfig } from './api/access.ts';
import { createApp } from './api/app.ts';
import { createDb } from './db/db.ts';
import { dbUrl, EXIT_CONFIG, runMigrate } from './db/migrate.ts';
import { healthy, startHeartbeat, touch } from './heartbeat.ts';
import { backfill, codeOf, processSession, startIngest } from './ingest/ingest.ts';
import { createClient } from './openf1/client.ts';

/** Roles of the single server image (A§4); the first argument picks one. */
export const ROLES = ['api', 'ingest', 'live', 'migrate', 'healthcheck', 'refetch', 'backfill', 'archive'] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_USAGE = 64;
/** Caddy proxies /api to api:8080 (P1f). */
export const API_PORT = 8080;

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = `usage: main.js <${ROLES.join('|')}> (refetch takes a session_key)`;

/** Resolves with the exit code. Roles without a phase yet exit EXIT_NOT_IMPLEMENTED. */
export async function run(
  argv: readonly string[],
  env: Env,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const [role, ...rest] = argv;
  const args = role === 'refetch' ? 1 : 0;
  if (
    role === undefined ||
    !(ROLES as readonly string[]).includes(role) ||
    rest.length !== args ||
    (role === 'refetch' && !/^\d{1,9}$/.test(rest[0] ?? ''))
  ) {
    log(USAGE);
    return EXIT_USAGE;
  }
  if (role === 'healthcheck') return healthy() ? 0 : 1;
  if (role === 'migrate') return runMigrate(env, log);
  if (role === 'api') return runApi(env, log);
  if (role === 'ingest' || role === 'backfill' || role === 'refetch') return runIngest(role, Number(rest[0]), env, log);
  log(`role ${role} is not implemented yet`);
  return EXIT_NOT_IMPLEMENTED;
}

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
  const deps = { db, client: createClient({ onAttempt: beat }), now: () => new Date(), log: logger, beat };
  try {
    if (role === 'ingest') {
      await startIngest(deps);
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

/** The api daemon (A§10): read-only as f1_api, behind the Access JWT. Resolves after SIGTERM/SIGINT. */
async function runApi(env: Env, log: (line: string) => void): Promise<number> {
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
  const app = createApp({ db, access: access(config, logger), log: logger });
  const server = serve({ fetch: app.fetch, port: API_PORT, hostname: '0.0.0.0' });
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
  logger.info({ port: API_PORT }, 'listening');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  logger.info({}, 'stopping');
  stopHeartbeat();
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
