import pino from 'pino';
import { createDb } from './db/db.ts';
import { dbUrl, EXIT_CONFIG, runMigrate } from './db/migrate.ts';
import { healthy, touch } from './heartbeat.ts';
import { backfill, codeOf, processSession, startIngest } from './ingest/ingest.ts';
import { createClient } from './openf1/client.ts';

/** Roles of the single server image (A§4); the first argument picks one. */
export const ROLES = ['api', 'ingest', 'live', 'migrate', 'healthcheck', 'refetch', 'backfill', 'archive'] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_USAGE = 64;

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

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
