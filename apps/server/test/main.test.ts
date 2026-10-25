import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, migratorUrl } from '../src/db/migrate.ts';
import { HEARTBEAT_MAX_AGE_MS, healthy, startHeartbeat, touch } from '../src/heartbeat.ts';
import { EXIT_NOT_IMPLEMENTED, EXIT_USAGE, run } from '../src/main.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'f1-test-'));

describe('run', () => {
  it.each([[[]], [['nope']], [['ingest', 'extra']]])('%j is a usage error', async (argv) => {
    const lines: string[] = [];
    expect(await run(argv, {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines[0]).toMatch(/^usage: main\.js <api\|ingest\|/);
  });

  it.each(['api', 'ingest', 'live', 'refetch', 'backfill', 'archive'])('%s is not implemented yet', async (role) => {
    expect(await run([role], {}, () => {})).toBe(EXIT_NOT_IMPLEMENTED);
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

  it('otherwise logs in as f1_migrator on db with the file secret, encoded', () => {
    const dir = tmp();
    expect(migratorUrl({}, dir)).toBe('the file secret db_f1_migrator is missing');
    writeFileSync(join(dir, 'db_f1_migrator'), 'p@ss/w:rd\n');
    const url = migratorUrl({}, dir);
    expect(String(url)).toBe('postgres://f1_migrator:p%40ss%2Fw%3Ard@db:5432/f1?sslmode=disable');
    writeFileSync(join(dir, 'db_f1_migrator'), 'two\nlines');
    expect(migratorUrl({}, dir)).toBe('the file secret db_f1_migrator is missing');
  });
});
