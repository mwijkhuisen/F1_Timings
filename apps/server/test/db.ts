import pg from 'pg';
import { applyRoles, LOGINS, type Login } from '../scripts/dev-db.ts';

// Integration-test helper. Needs DATABASE_URL: a superuser of a throw-away
// PostgreSQL 18 server (CI's service container). Creates a database of its own
// with the three logins applied; migrations are the caller's job.

let counter = 0;

export type TestDb = {
  /** Superuser URL of the new database, plus one URL per login. */
  urls: Record<Login | 'admin', string>;
  drop: () => Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const server = process.env.DATABASE_URL ?? '';
  const admin = new URL(server);
  const name = `f1_it_${process.pid}_${counter++}`;
  const maintenance = new pg.Client({ connectionString: server });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${name}`);
  } finally {
    await maintenance.end();
  }
  const drop = async () => {
    const c = new pg.Client({ connectionString: server });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
  try {
    admin.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: admin.href });
    await client.connect();
    let passwords: Record<Login, string>;
    try {
      passwords = await applyRoles(client);
    } finally {
      await client.end();
    }
    const urls = { admin: admin.href } as TestDb['urls'];
    for (const login of LOGINS) {
      const u = new URL(admin.href);
      u.username = login;
      u.password = passwords[login];
      urls[login] = u.href;
    }
    return { urls, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}
