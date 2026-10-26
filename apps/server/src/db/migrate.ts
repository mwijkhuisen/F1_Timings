import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The one-shot `migrate` role (A§4): dbmate applies db/migrations as f1_migrator.
// The database URL is built here, in the process, from the file secret: it is
// never in the container's environment, a command line or a log (A§12.1).

type Env = Readonly<Record<string, string | undefined>>;

export const EXIT_CONFIG = 78;
export const SECRETS_DIR = '/run/secrets';

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
// URL-safe as is: the URL setter would leave a `%` unencoded, and dbmate would decode it.
const PASSWORD = /^[A-Za-z0-9_-]{24,}$/;

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A Compose file secret: one line, trimmed; undefined when missing, empty or multi-line. */
export function readSecret(name: string, dir = SECRETS_DIR): string | undefined {
  if (!/^[a-z0-9_]+$/.test(name)) return undefined;
  try {
    const v = readFileSync(`${dir}/${name}`, 'utf8').trim();
    return v === '' || /[\r\n]/.test(v) ? undefined : v;
  } catch {
    return undefined;
  }
}

export type DbLogin = 'f1_migrator' | 'f1_ingest' | 'f1_api';

/**
 * The URL of a database login on the `db` service (A§14.2), or an error text.
 * `DATABASE_URL` is the development and test switch; Compose never sets it, so
 * production always takes the login's file secret `db_<login>`.
 */
export function dbUrl(login: DbLogin, env: Env, secretsDir = SECRETS_DIR): URL | string {
  if (env.DATABASE_URL) {
    let url: URL;
    try {
      url = new URL(env.DATABASE_URL);
    } catch {
      return 'DATABASE_URL is not a URL';
    }
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? url : 'DATABASE_URL is not a postgres URL';
  }
  const secret = `db_${login}`;
  const password = readSecret(secret, secretsDir);
  if (password === undefined) return `the file secret ${secret} is missing`;
  if (!PASSWORD.test(password)) return `the file secret ${secret} must be 24 or more characters of A-Z a-z 0-9 _ -`;
  const url = new URL('postgres://db:5432/f1?sslmode=disable');
  url.username = login;
  url.password = password;
  return url;
}

export const migratorUrl = (env: Env, secretsDir = SECRETS_DIR) => dbUrl('f1_migrator', env, secretsDir);

export async function runMigrate(env: Env, log: (line: string) => void): Promise<number> {
  const url = migratorUrl(env);
  if (typeof url === 'string') {
    log(`migrate: ${url}`);
    return EXIT_CONFIG;
  }
  // dbmate's output can quote the URL; everything it prints passes through this.
  const secrets = [url.href, url.password, decoded(url.password)].filter((s) => s !== '');
  const scrub = (text: string) => secrets.reduce((out, s) => out.split(s).join('[redacted]'), text).slice(0, 4000);
  const print = (text: unknown) => {
    if (typeof text === 'string') for (const line of scrub(text).split('\n')) if (line.trim()) log(`migrate: ${line}`);
  };
  try {
    // `migrate`, not `up`: the database exists and f1_migrator may not create one.
    // No schema dump: there is no pg_dump in the image and the file system is read-only.
    const { stdout } = await exec(
      'dbmate',
      ['--no-dump-schema', '--migrations-dir', MIGRATIONS, '--wait', '--wait-timeout', '60s', 'migrate'],
      { env: { PATH: env.PATH, DATABASE_URL: url.href }, timeout: 600_000, maxBuffer: 1024 * 1024 },
    );
    print(stdout);
    return 0;
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; code?: unknown };
    log(`migrate: dbmate failed (${typeof e.code === 'number' ? `exit ${e.code}` : String(e.code ?? 'error')})`);
    print(e.stdout);
    print(e.stderr);
    return 1;
  }
}
