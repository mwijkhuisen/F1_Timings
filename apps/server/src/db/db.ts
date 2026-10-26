import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.ts';

export type { DB };

/**
 * A Kysely instance on a pool of at most 2 connections. An idle-connection error
 * must not crash the process: `onPoolError` logs it and the pool reconnects.
 * Every wait is bounded, so a half-open connection cannot hang a job (and its busy
 * guard) for good: connect 10 s, statement 60 s on the server, 70 s on the client.
 */
export function createDb(url: URL | string, onPoolError: (err: Error) => void = () => {}): Kysely<DB> {
  const pool = new pg.Pool({
    connectionString: String(url),
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 70_000,
    keepAlive: true,
  });
  pool.on('error', onPoolError);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
