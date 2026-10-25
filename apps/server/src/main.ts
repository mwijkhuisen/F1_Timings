import { runMigrate } from './db/migrate.ts';
import { healthy } from './heartbeat.ts';

/** Roles of the single server image (A§4); the first argument picks one. */
export const ROLES = ['api', 'ingest', 'live', 'migrate', 'healthcheck', 'refetch', 'backfill', 'archive'] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_USAGE = 64;

const USAGE = `usage: main.js <${ROLES.join('|')}>`;

/** Resolves with the exit code. Roles without a phase yet exit EXIT_NOT_IMPLEMENTED. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const [role, ...rest] = argv;
  if (role === undefined || rest.length > 0 || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return EXIT_USAGE;
  }
  if (role === 'healthcheck') return healthy() ? 0 : 1;
  if (role === 'migrate') return runMigrate(env, log);
  log(`role ${role} is not implemented yet`);
  return EXIT_NOT_IMPLEMENTED;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
