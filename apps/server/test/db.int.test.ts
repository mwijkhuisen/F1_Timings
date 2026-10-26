import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// Roles and grants (security): who may do what, proven against a real server.

const TABLES = ['meeting', 'session', 'driver', 'lap', 'stint', 'pit', 'race_control', 'result', 'raw_response'];

let db: TestDb;
const clients: pg.Client[] = [];
const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

beforeAll(async () => {
  db = await createTestDb();
  expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: db.urls.f1_migrator }, () => {})).toBe(0);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
  await db.drop();
});

it('every table is owned by f1_migrator', async () => {
  const c = await connect(db.urls.admin);
  const { rows } = await c.query(
    "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  expect(rows.map((r) => r.tablename).sort()).toEqual([...TABLES].sort());
  expect(new Set(rows.map((r) => r.tableowner))).toEqual(new Set(['f1_migrator']));
});

it('f1_ingest writes data but cannot create tables', async () => {
  const c = await connect(db.urls.f1_ingest);
  await c.query("INSERT INTO meeting (meeting_key, source, year) VALUES (1, 'openf1', 2026)");
  await c.query("INSERT INTO session (session_key, source, meeting_key) VALUES (10, 'openf1', 1)");
  await c.query("INSERT INTO race_control (session_key, source, message) VALUES (10, 'openf1', 'x')");
  await c.query("INSERT INTO raw_response VALUES (10, 'openf1', 'laps', now(), 200, '[]')");
  expect(await code(c.query('CREATE TABLE nope (a int)'))).toBe('42501');
});

it('f1_api reads but cannot write, and cannot read raw_response', async () => {
  const c = await connect(db.urls.f1_api);
  expect((await c.query('SELECT * FROM race_control')).rowCount).toBe(1);
  expect(await code(c.query("INSERT INTO meeting (meeting_key, source, year) VALUES (2, 'openf1', 2026)"))).toBe(
    '42501',
  );
  expect(await code(c.query('SELECT * FROM raw_response'))).toBe('42501');
});

it('the committed Kysely types match the migrated schema (kysely-codegen --verify)', async () => {
  // The URL goes in the child's environment, never on argv.
  const verify = promisify(execFile)('pnpm', ['run', 'db:types', '--verify'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, DATABASE_URL: db.urls.admin },
  });
  await expect(verify).resolves.toBeDefined();
});

it('no login reaches another database', async () => {
  const u = new URL(db.urls.f1_api);
  u.pathname = '/postgres';
  expect(await code(connect(u.href))).toBe('42501');
});
