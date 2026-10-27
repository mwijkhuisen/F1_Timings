import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dbUrl, EXIT_CONFIG, migratorUrl } from '../src/db/migrate.ts';
import { HEARTBEAT_MAX_AGE_MS, healthy, startHeartbeat, touch } from '../src/heartbeat.ts';
import { EXIT_NOT_IMPLEMENTED, EXIT_USAGE, run } from '../src/main.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'f1-test-'));

describe('run', () => {
  it.each([
    [[]],
    [['nope']],
    [['ingest', 'extra']],
    [['backfill', 'extra']],
    [['refetch']],
    [['refetch', 'abc']],
    [['refetch', '11388', '11392']],
  ])('%j is a usage error', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines[0]).toMatch(/^usage: main\.js <api\|ingest\|/);
  });

  it.each(['live', 'archive'])('%s is not implemented yet', async (role) => {
    expect(await run([role], {}, () => {})).toBe(EXIT_NOT_IMPLEMENTED);
  });

  it.each([[['ingest']], [['backfill']], [['refetch', '11388']]])(
    '%j without a database setting is a config error',
    async (argv) => {
      const lines: string[] = [];
      expect(await run(argv, { DATABASE_URL: 'mysql://x/y' }, (l) => lines.push(l))).toBe(EXIT_CONFIG);
      expect(lines).toEqual([`${argv[0]}: DATABASE_URL is not a postgres URL`]);
    },
  );

  it.each([
    [{}, 'CF_ACCESS_TEAM'],
    [{ CF_ACCESS_TEAM: 'test-team' }, 'CF_ACCESS_AUD'],
    [{ CF_ACCESS_TEAM: 'test-team.evil.example', CF_ACCESS_AUD: 'a'.repeat(64) }, 'CF_ACCESS_TEAM'],
    [{ CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: 'not-an-aud' }, 'CF_ACCESS_AUD'],
  ])('api with %j is a config error, before any database or listening', async (access, name) => {
    const lines: string[] = [];
    const env = { ...access, DATABASE_URL: 'postgres://u@127.0.0.1:1/x' };
    expect(await run(['api'], env, (l) => lines.push(l))).toBe(EXIT_CONFIG);
    expect(lines).toEqual([`api: ${name} is missing or malformed`]);
  });

  it('api without a database setting is a config error', async () => {
    const lines: string[] = [];
    const env = { CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: 'a'.repeat(64), DATABASE_URL: 'mysql://x/y' };
    expect(await run(['api'], env, (l) => lines.push(l))).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['api: DATABASE_URL is not a postgres URL']);
  });

  it('healthcheck exits 0 while the heartbeat is fresh', async () => {
    const stop = startHeartbeat();
    stop();
    expect(await run(['healthcheck'], {})).toBe(0);
  });

  it('migrate without a database setting is a config error', async () => {
    const lines: string[] = [];
    expect(await run(['migrate'], { DATABASE_URL: 'mysql://x/y' }, (l) => lines.push(l))).toBe(EXIT_CONFIG);
    expect(lines).toEqual(['migrate: DATABASE_URL is not a postgres URL']);
  });
});

describe('heartbeat', () => {
  it('is healthy for 120 s after a touch, and not when missing', () => {
    const path = join(tmp(), 'hb');
    expect(healthy(path)).toBe(false);
    touch(path);
    expect(healthy(path)).toBe(true);
    const old = new Date(Date.now() - HEARTBEAT_MAX_AGE_MS - 1000);
    utimesSync(path, old, old);
    expect(healthy(path)).toBe(false);
  });
});

describe('migratorUrl', () => {
  it('takes DATABASE_URL when set', () => {
    const url = migratorUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/x?sslmode=disable' });
    expect(url).toBeInstanceOf(URL);
    expect(migratorUrl({ DATABASE_URL: 'not a url' })).toBe('DATABASE_URL is not a URL');
  });

  it('otherwise logs in as f1_migrator on db with a URL-safe file secret', () => {
    const dir = tmp();
    expect(migratorUrl({}, dir)).toBe('the file secret db_f1_migrator is missing');
    writeFileSync(join(dir, 'db_f1_migrator'), 'Abc-123_xyz-456_DEF-789_gh\n');
    expect(String(migratorUrl({}, dir))).toBe(
      'postgres://f1_migrator:Abc-123_xyz-456_DEF-789_gh@db:5432/f1?sslmode=disable',
    );
    writeFileSync(join(dir, 'db_f1_migrator'), 'two\nlines');
    expect(migratorUrl({}, dir)).toBe('the file secret db_f1_migrator is missing');
    for (const bad of ['p%41ss-but-long-enough-0123', 'p@ss/w:rd=+but-long-enough-0123', 'short_but_ok_chars']) {
      writeFileSync(join(dir, 'db_f1_migrator'), bad);
      expect(migratorUrl({}, dir)).toMatch(/must be 24 or more/);
    }
  });
});

describe('dbUrl', () => {
  it('logs f1_ingest in with its own file secret, never the migrator one', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'db_f1_migrator'), 'Abc-123_xyz-456_DEF-789_gh');
    expect(dbUrl('f1_ingest', {}, dir)).toBe('the file secret db_f1_ingest is missing');
    writeFileSync(join(dir, 'db_f1_ingest'), 'Ing-123_xyz-456_DEF-789_gh\n');
    expect(String(dbUrl('f1_ingest', {}, dir))).toBe(
      'postgres://f1_ingest:Ing-123_xyz-456_DEF-789_gh@db:5432/f1?sslmode=disable',
    );
  });
});

describe('runMigrate', () => {
  it('never logs the password, even when dbmate prints the URL', async () => {
    const bin = tmp();
    const dbmate = '#!/bin/sh\necho "out $DATABASE_URL"\necho "err $DATABASE_URL" >&2\nexit 1\n';
    writeFileSync(join(bin, 'dbmate'), dbmate, { mode: 0o755 });
    const lines: string[] = [];
    const env = { PATH: bin, DATABASE_URL: 'postgres://u:Pa55-word%25x@localhost:5432/x' };
    expect(await run(['migrate'], env, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).not.toMatch(/Pa55-word/);
    expect(lines).toEqual(['migrate: dbmate failed (exit 1)', 'migrate: out [redacted]', 'migrate: err [redacted]']);
  });
});
