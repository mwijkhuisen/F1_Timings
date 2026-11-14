import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// #104: deploy/host/recorder-watch.sql, the query f1-tick runs in f1-db-1 every 10 minutes, on the migrated schema.
// It runs here as f1-tick runs it, as f1_api in a READ ONLY transaction (a write would fail it), on synthetic rows
// placed relative to now(). Every time below is in minutes from now.

const WATCH = readFileSync(join(import.meta.dirname, '../../../deploy/host/recorder-watch.sql'), 'utf8');

type Case = {
  /** [session_key, date_start, length, is_cancelled] */
  sessions: [number, number, number?, boolean?][];
  /** [session_key, started_at, ended_at (null: open)] */
  recordings?: [number, number, number | null][];
  /** [updated_at, warning]; no row when absent */
  status?: [number, string?];
};

let testDb: TestDb;
let admin: Kysely<DB>;
let api: Kysely<DB>;
const at = (min: number | null) => sql`now() + ${min}::float8 * interval '1 minute'`;

async function watch(c: Case) {
  // One transaction, so every row shares one now(): two sessions at the same minute get the same date_start.
  await admin.transaction().execute(async (trx) => {
    await sql`TRUNCATE session, recording, recorder_status CASCADE`.execute(trx);
    for (const [key, start, length = 60, cancelled = false] of c.sessions)
      await sql`INSERT INTO session (session_key, source, meeting_key, date_start, date_end, is_cancelled)
        VALUES (${key}, 'openf1', 1, ${at(start)}, ${at(start + length)}, ${cancelled})`.execute(trx);
    for (const [i, [key, started, ended]] of (c.recordings ?? []).entries())
      await sql`INSERT INTO recording (session_key, path, started_at, ended_at)
        VALUES (${key}, ${`${key}-${i}`}, ${at(started)}, ${at(ended)})`.execute(trx);
    if (c.status)
      await sql`INSERT INTO recorder_status (state, updated_at, warning)
        VALUES ('idle', ${at(c.status[0])}, ${c.status[1] ?? null})`.execute(trx);
  });
  return api.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const { rows } = await sql.raw<{ code: string; session_key: number }>(WATCH).execute(trx);
    return rows.map((r) => [r.code, r.session_key]);
  });
}

describe('the recorder watch (deploy/host/recorder-watch.sql)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    api = createDb(testDb.urls.f1_api);
    await sql`INSERT INTO meeting (meeting_key, source, year) VALUES (1, 'openf1', 2026)`.execute(admin);
  });
  afterAll(async () => {
    await api?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it.each<[string, Case, [string, number][]]>([
    [
      'recorder_missing: 30 min before the start, no recording',
      { sessions: [[1, 30]], status: [0] },
      [['recorder_missing', 1]],
    ],
    [
      'recorder_stale: 90 min before the start, the status 10 min old',
      { sessions: [[1, 90]], status: [-10] },
      [['recorder_stale', 1]],
    ],
    [
      'login_failed: 20 h before the start',
      { sessions: [[1, 20 * 60]], status: [0, 'login_failed'] },
      [['login_failed', 1]],
    ],
    [
      'an old recording of the session, started before date_start - 65 min, still counts as missing',
      { sessions: [[1, 10]], recordings: [[1, 10 - 70, -30]], status: [0] },
      [['recorder_missing', 1]],
    ],
    [
      "another session's recording ended 5 min ago: past the handover gap, the next session is missing",
      {
        sessions: [
          [1, -90, 80],
          [2, 10],
        ],
        recordings: [[1, -150, -5]],
        status: [0],
      },
      [['recorder_missing', 2]],
    ],
    [
      'in progress (start -20 min, end +40 min): recorder_missing without a recording',
      { sessions: [[1, -20]], status: [0] },
      [['recorder_missing', 1]],
    ],
    [
      'in progress: recorder_stale, the status 10 min old',
      { sessions: [[1, -20]], recordings: [[1, -75, null]], status: [-10] },
      [['recorder_stale', 1]],
    ],
    [
      'in progress: login_failed',
      { sessions: [[1, -20]], recordings: [[1, -75, null]], status: [0, 'login_failed'] },
      [['login_failed', 1]],
    ],
    [
      'ended 10 min ago (the date_end + 30 min tail): stale and login_failed still fire, missing does not',
      { sessions: [[1, -70]], status: [-10, 'login_failed'] },
      [
        ['login_failed', 1],
        ['recorder_stale', 1],
      ],
    ],
    ['no status row is stale', { sessions: [[1, 60]] }, [['recorder_stale', 1]]],
    ['a status row in the future is stale', { sessions: [[1, 60]], status: [5] }, [['recorder_stale', 1]]],
    [
      'two due sessions: one row per code, the earliest session',
      {
        sessions: [
          [20, 20],
          [10, 40],
        ],
        status: [-10, 'login_failed'],
      },
      [
        ['login_failed', 20],
        ['recorder_missing', 20],
        ['recorder_stale', 20],
      ],
    ],
    [
      'two sessions with the same date_start: the lower session key',
      {
        sessions: [
          [20, 30],
          [10, 30],
        ],
        status: [-10, 'login_failed'],
      },
      [
        ['login_failed', 10],
        ['recorder_missing', 10],
        ['recorder_stale', 10],
      ],
    ],
  ])('fires: %s', async (_name, c, expected) => {
    expect(await watch(c)).toEqual(expected);
  });

  it.each<[string, Case]>([
    ['missing: 70 min before the start', { sessions: [[1, 70]], status: [0] }],
    ['stale: 3 h before the start', { sessions: [[1, 180]], status: [-10] }],
    ['login_failed: 30 h before the start', { sessions: [[1, 30 * 60]], status: [0, 'login_failed'] }],
    ['a cancelled session', { sessions: [[1, -10, 60, true]], status: [-10, 'login_failed'] }],
    ['a session that ended 40 min ago', { sessions: [[1, -100, 60]], status: [-10, 'login_failed'] }],
    ['missing, after date_end', { sessions: [[1, -70, 60]], status: [0] }],
    [
      'a recording of the session since date_start - 60 min',
      { sessions: [[1, 10]], recordings: [[1, -50, -10]], status: [0] },
    ],
    [
      'an open recording of another session',
      {
        sessions: [
          [1, -60, 90],
          [2, 10],
        ],
        recordings: [[1, -120, null]],
        status: [0],
      },
    ],
    [
      "another session's recording ended 1 min ago (the handover gap)",
      {
        sessions: [
          [1, -90, 80],
          [2, 10],
        ],
        recordings: [[1, -150, -1]],
        status: [0],
      },
    ],
    ['a fresh status (4 min old)', { sessions: [[1, 60]], status: [-4] }],
    ['a status 30 s ahead is fresh, not stale', { sessions: [[1, 60]], status: [0.5] }],
    ['a warning other than login_failed', { sessions: [[1, 20 * 60]], status: [0, 'token_expiring'] }],
  ])('silent: %s', async (_name, c) => {
    expect(await watch(c)).toEqual([]);
  });
});
