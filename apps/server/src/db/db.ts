import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.ts';

export type { DB };

/**
 * A Kysely instance on a pool of at most 2 connections. An idle-connection error
 * must not crash the process: `onPoolError` logs it and the pool reconnects.
 */
export function createDb(url: URL | string, onPoolError: (err: Error) => void = () => {}): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: String(url), max: 2 });
  pool.on('error', onPoolError);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
