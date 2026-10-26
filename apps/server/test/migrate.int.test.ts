import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// Needs DATABASE_URL (a superuser of a throw-away PostgreSQL 18 server: CI's
// service container) and dbmate on PATH. The test creates its own database and
// applies the logins first (the grants migration needs them).

const exec = promisify(execFile);
const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

let db: TestDb;
let env: { PATH: string | undefined; DATABASE_URL: string };
const dbmate = async (...args: string[]) =>
  (await exec('dbmate', ['--no-dump-schema', '--migrations-dir', MIGRATIONS, ...args], { env })).stdout;

beforeAll(async () => {
  db = await createTestDb();
  env = { PATH: process.env.PATH, DATABASE_URL: db.urls.f1_migrator };
});
afterAll(() => db.drop());

it('migrate applies every migration, dbmate rolls each back, migrate applies them again', async () => {
  const count = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).length;
  expect(count).toBeGreaterThan(0);

  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await dbmate('status')).toMatch(/^Pending: 0$/m);

  for (let i = 0; i < count; i++) await dbmate('rollback');
  expect(await dbmate('status')).toMatch(/^Applied: 0$/m);

  expect(await run(['migrate'], env, () => {})).toBe(0);
  expect(await dbmate('status')).toMatch(new RegExp(`^Applied: ${count}$`, 'm'));
});
