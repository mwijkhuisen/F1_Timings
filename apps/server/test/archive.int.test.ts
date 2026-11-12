import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kysely, sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../test/msw.setup.ts';
import { MAX_SESSION_BYTES, ORIGIN } from '../src/archive/files.ts';
import { type ArchiveArgs, type ArchiveDeps, archive, GAP_MS, LOCK_KEY } from '../src/archive/job.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// The archive job against a real PostgreSQL 18, logged in as f1_ingest, with the F1 archive replaced by the synthetic
// fixtures in fixtures/archive/ (msw). Expected counts are literals read off the fixture files.

const FIXTURES = join(import.meta.dirname, 'fixtures/archive');
const MEETING = '2019-03-17_Synthetic_Grand_Prix';
const DIRS: Record<string, string> = {
  [`${MEETING}/2019-03-17_Race`]: 'race',
  [`${MEETING}/2019-03-16_Qualifying`]: 'quali',
  '2019-04-14_Old_Grand_Prix/2019-04-13_Qualifying': 'old-quali', // 2019-style: no SessionData
};
const TABLES = ['driver', 'lap', 'lap_source', 'stint', 'race_control', 'result', 'weather'] as const;

let clock = Date.parse('2026-11-10T12:00:00Z');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SIGNATURE = 'c3ludGhldGljLXNpZ25hdHVyZS0wMTIz';
const TOKEN = `${b64({ alg: 'none' })}.${b64({ exp: clock / 1000 + 86_400 })}.${SIGNATURE}`;

/** Every request: its path below static/, the clock at its start, its Authorization header. */
const requests: { path: string; at: number; auth: string | null }[] = [];
const lines: string[] = [];
const logged = (msg: string) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

/**
 * Serves the Index and the fixture files; a topic a fixture lacks, and every file of another session, is a 403.
 * `status` can force a status or a whole response.
 */
const f1 = (status?: (path: string) => number | Response | undefined) =>
  server.use(
    http.get(`${ORIGIN}/static/*`, ({ request }) => {
      const path = new URL(request.url).pathname.slice('/static/'.length);
      requests.push({ path, at: clock, auth: request.headers.get('authorization') });
      const forced = status?.(path);
      if (typeof forced === 'number') return new HttpResponse(null, { status: forced });
      if (forced !== undefined) return forced;
      if (path === '2019/Index.json') return new HttpResponse(readFileSync(join(FIXTURES, 'index-2019.json')));
      const m = /^2019\/(.+)\/([A-Za-z]+\.jsonStream)$/.exec(path);
      const dir = m && DIRS[m[1] ?? ''];
      const file = dir && join(FIXTURES, dir, m[2] ?? '');
      return file && existsSync(file) ? new HttpResponse(readFileSync(file)) : new HttpResponse(null, { status: 403 });
    }),
  );

let testDb: TestDb;
let db: Kysely<DB>;
let admin: Kysely<DB>;
let deps: ArchiveDeps;
let args: ArchiveArgs;

const count = async (table: string, where = 'true') => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(admin);
  return Number(rows[0]?.n);
};
/** Per table: md5 over every row, minus the identity. */
const hashes = async () => {
  const out: Record<string, string> = {};
  for (const table of ['meeting', 'session', ...TABLES]) {
    const { rows } = await sql<{ h: string }>`
      SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) AS h
      FROM (SELECT to_jsonb(t) - 'id' AS x FROM ${sql.table(table)} t) s`.execute(admin);
    out[table] = rows[0]?.h ?? '';
  }
  return out;
};
const tokenFile = (token: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'f1-archive-token-')), 'token');
  writeFileSync(path, `${token}\n`);
  chmodSync(path, 0o600);
  return path;
};

describe('archive (fixtures through msw, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    db = createDb(testDb.urls.f1_ingest);
    admin = createDb(testDb.urls.admin);
    const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });
    const sleep = async (ms: number) => {
      clock += ms;
    };
    deps = { db, now: () => new Date(clock), sleep, log, freeBytes: () => 6 * 1024 ** 3 };
    args = { year: 2019, keys: [], tokenFile: tokenFile(TOKEN), dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it('imports the race and both qualifyings as final f1-archive sessions; the all-403 session gets no rows', async () => {
    f1();
    expect(await archive(deps, args)).toBe(true);

    expect(
      await admin
        .selectFrom('session')
        .select(['session_key', 'source', 'ingest_state', 'next_fetch_at'])
        .orderBy('session_key')
        .execute(),
    ).toEqual([
      { session_key: 9101, source: 'f1-archive', ingest_state: 'final', next_fetch_at: null },
      { session_key: 9102, source: 'f1-archive', ingest_state: 'final', next_fetch_at: null },
      { session_key: 9121, source: 'f1-archive', ingest_state: 'final', next_fetch_at: null },
    ]);
    expect(
      await admin
        .selectFrom('meeting')
        .select(['meeting_key', 'source', 'gmt_offset'])
        .orderBy('meeting_key')
        .execute(),
    ).toEqual([
      { meeting_key: 9100, source: 'f1-archive', gmt_offset: '11:00:00' },
      { meeting_key: 9120, source: 'f1-archive', gmt_offset: '08:00:00' },
    ]);
    const counts = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));
    expect(counts).toEqual({ driver: 6, lap: 26, lap_source: 26, stint: 9, race_control: 9, result: 6, weather: 7 });
    for (const table of TABLES) expect(await count(table, "source <> 'f1-archive'")).toBe(0);
    expect(await count('lap', 'deleted')).toBe(2);
    expect(await count('lap', 'quali_phase = 2')).toBe(6);
    expect(await count('lap', 'session_key = 9121 AND quali_phase IS NULL')).toBe(0);

    // 1 Index + 3 sessions × 10 topics + the all-403 session's SessionInfo, one at a time, 2 s apart, with the token.
    expect(requests.length).toBe(32);
    for (const [i, r] of requests.entries()) {
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
      if (i > 0) expect(r.at - (requests[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(GAP_MS);
    }
    expect(readdirSync(join(args.dir, '9102')).sort()).toEqual([
      'DriverList.jsonStream',
      'ExtrapolatedClock.missing',
      'Heartbeat.jsonStream',
      'RaceControlMessages.jsonStream',
      'SessionData.jsonStream',
      'SessionInfo.jsonStream',
      'SessionStatus.missing',
      'TimingAppData.jsonStream',
      'TimingData.jsonStream',
      'WeatherData.jsonStream',
    ]);
    expect(existsSync(join(args.dir, '9101', 'Heartbeat.missing'))).toBe(true);
    expect(existsSync(join(args.dir, '9121', 'SessionData.missing'))).toBe(true);
    // No marker for SessionInfo or TimingData: a rerun asks again.
    expect(readdirSync(join(args.dir, '9111'))).toEqual([]);
    expect(readFileSync(join(args.dir, 'index-2019.json'))).toEqual(readFileSync(join(FIXTURES, 'index-2019.json')));

    const bySession = Object.fromEntries(logged('archive').map((l) => [l.session_key, l]));
    expect(bySession[9102]).toMatchObject({
      level: 30, // info
      year: 2019,
      type: 'Race',
      files: 8,
      skipped_files: 2,
      t0: 'sessiondata',
      t0_heartbeat_delta_ms: -2000,
      laps: 6,
      stints: 3,
      drivers: 2,
      race_control: 3,
      weather: 3,
      phases: 0,
    });
    expect(bySession[9101]).toMatchObject({ files: 7, skipped_files: 3, t0_heartbeat_delta_ms: null, phases: 2 });
    expect(bySession[9121]).toMatchObject({ files: 8, skipped_files: 2, t0: 'clock', laps: 10, phases: 2 });
    expect(bySession[9111]).toMatchObject({ files: 0, skipped_files: 1, error: 'incomplete' });
    expect(logged('archive_done').at(-1)).toMatchObject({
      imported: 3,
      failed: 0,
      incomplete: 1,
      bad_path: 0,
      t0_heartbeat: 0,
    });
  });

  it('P3b: each lap row is its own lap_source candidate with `filled` {}, and the merge kept the deletions', async () => {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM lap l JOIN lap_source c USING (session_key, driver_number, lap_number, source)
      WHERE l.filled = '{}' AND to_jsonb(l) - 'is_pit_in' - 'deleted' - 'deleted_reason' - 'filled' = to_jsonb(c)`.execute(
      admin,
    );
    expect(Number(rows[0]?.n)).toBe(26);
    const imported = logged('archive').filter((l) => l.error === undefined);
    expect(imported.map((l) => l.session_key).sort()).toEqual([9101, 9102, 9121]);
    for (const l of imported)
      expect(l.merge).toEqual({ rows: l.laps, added: {}, filled: {}, diffs: {}, conflicts: {}, rules: l.rules });
  });

  it('a second run asks for the Index and the missing SessionInfo only, and gives identical rows', async () => {
    f1();
    const before = await hashes();
    const asked = requests.length;
    expect(await archive(deps, args)).toBe(true);
    expect(requests.slice(asked).map((r) => r.path.split('/').at(-1))).toEqual([
      'Index.json',
      'SessionInfo.jsonStream',
    ]);
    expect(await hashes()).toEqual(before);
  });

  it('leaves a session or meeting from another source untouched and fails', async () => {
    f1();
    await admin
      .updateTable('session')
      .set({ source: 'openf1', name: 'Theirs' })
      .where('session_key', '=', 9101)
      .execute();
    await admin
      .updateTable('meeting')
      .set({ source: 'openf1', name: 'Theirs' })
      .where('meeting_key', '=', 9100)
      .execute();
    const before = await hashes();
    expect(await archive(deps, { ...args, keys: [9101, 9102] })).toBe(false);
    expect(await hashes()).toEqual(before);
    expect(
      logged('archive')
        .slice(-2)
        .map((l) => [l.session_key, l.error]),
    ).toEqual([
      [9101, 'not_archive'],
      [9102, 'not_archive'],
    ]);
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 0, failed: 2 });
    await admin.updateTable('meeting').set({ source: 'f1-archive' }).where('meeting_key', '=', 9100).execute();
    await admin.updateTable('session').set({ source: 'f1-archive' }).where('session_key', '=', 9101).execute();
  });

  it('a 401 stops the run', async () => {
    f1((path) => (path.endsWith('/SessionData.jsonStream') ? 401 : undefined));
    const asked = requests.length;
    const fresh = { ...args, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    // Index, then SessionInfo and Heartbeat of the first session, then its SessionData: 401.
    expect(requests.slice(asked).map((r) => r.path.split('/').at(-1))).toEqual([
      'Index.json',
      'SessionInfo.jsonStream',
      'Heartbeat.jsonStream',
      'SessionData.jsonStream',
    ]);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'http_401' });
  });

  it('another failure fails that session only, and the run goes on', async () => {
    f1((path) => (path.includes(`${MEETING}/2019-03-16_Qualifying/TimingData`) ? 500 : undefined));
    const fresh = { ...args, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(
      logged('archive')
        .slice(-4)
        .map((l) => [l.session_key, l.error]),
    ).toEqual([
      [9101, 'http_500'],
      [9102, undefined],
      [9111, 'incomplete'],
      [9121, undefined],
    ]);
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 2, failed: 1, incomplete: 1 });
    // The failed session keeps what it got; the rerun asks for the rest.
    expect(existsSync(join(fresh.dir, '9101', 'TimingData.jsonStream'))).toBe(false);
    expect(existsSync(join(fresh.dir, '9101', 'SessionData.jsonStream'))).toBe(true);
  });

  it('a body cut mid-download leaves no file and no temp file, and the rerun asks for it again', async () => {
    const cut = () => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulls++ === 0) c.enqueue(new TextEncoder().encode('00:00:00.000{"Lines":'));
          else c.error(new Error('cut'));
        },
      });
      return new HttpResponse(body);
    };
    f1((path) => (path.endsWith('_Race/TimingData.jsonStream') ? cut() : undefined));
    const fresh = { ...args, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(logged('archive').findLast((l) => l.session_key === 9102 && l.error)).toMatchObject({ error: 'network' });
    const race = readdirSync(join(fresh.dir, '9102'));
    expect(race).not.toContain('TimingData.jsonStream');
    expect(race.filter((f) => f.endsWith('.tmp'))).toEqual([]);

    f1();
    const asked = requests.length;
    expect(await archive(deps, fresh)).toBe(true);
    expect(requests.slice(asked).map((r) => r.path)).toContain(`2019/${MEETING}/2019-03-17_Race/TimingData.jsonStream`);
    expect(existsSync(join(fresh.dir, '9102', 'TimingData.jsonStream'))).toBe(true);
  });

  it('an empty 200 writes no file and no marker and fails like a failed request; the rerun asks again', async () => {
    f1((path) => (path === '2019/Index.json' ? new HttpResponse('') : undefined));
    const fresh = { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'index_empty' });
    expect(readdirSync(fresh.dir)).toEqual([]);

    f1((path) => (path.endsWith('_Race/TimingData.jsonStream') ? new HttpResponse('') : undefined));
    expect(await archive(deps, fresh)).toBe(false);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, error: 'empty' });
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 0, failed: 1 });
    expect(readdirSync(join(fresh.dir, '9102')).filter((f) => f.startsWith('TimingData'))).toEqual([]);

    f1();
    const asked = requests.length;
    expect(await archive(deps, fresh)).toBe(true);
    expect(requests.slice(asked).map((r) => r.path)).toContain(`2019/${MEETING}/2019-03-17_Race/TimingData.jsonStream`);
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 1, failed: 0 });
  });

  it('a session imported on the Heartbeat t0 logs its line at error level and counts in t0_heartbeat', async () => {
    // The race without SessionData (and it has no ExtrapolatedClock): only the Heartbeat is left for the t0.
    f1((path) => (path.endsWith('_Race/SessionData.jsonStream') ? 403 : undefined));
    const fresh = { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(true);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, level: 50, t0: 'heartbeat' });
    expect(logged('archive').at(-1)).not.toHaveProperty('error');
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 1, failed: 0, t0_heartbeat: 1 });
  });

  it('counts a key not in the Index, a bad Path and a SessionInfo Key that is not the Index Key', async () => {
    const index = JSON.parse(readFileSync(join(FIXTURES, 'index-2019.json'), 'utf8').replace(/^\uFEFF/, ''));
    const race = index.Meetings[0].Sessions[1];
    index.Meetings[0].Sessions.push(
      { ...race, Key: 9131, Path: '2019/../uat/2019-03-17_Race/' },
      { ...race, Key: 9132 }, // the race's Path, so its SessionInfo Key is 9102
    );
    f1((path) => (path === '2019/Index.json' ? HttpResponse.json(index) : undefined));
    const fresh = { ...args, keys: [9131, 9132, 9999], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(
      logged('archive')
        .slice(-3)
        .map((l) => [l.session_key, l.error]),
    ).toEqual([
      [9131, 'bad_path'],
      [9999, 'not_in_index'],
      [9132, 'key_mismatch'],
    ]);
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 0, failed: 2, incomplete: 0, bad_path: 1 });
    expect(await count('session', 'session_key IN (9131, 9132, 9999)')).toBe(0);
  });

  it('a session over MAX_SESSION_BYTES on disk fails as too_large before anything is read', async () => {
    f1();
    const fresh = { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    const big = join(fresh.dir, '9102', 'TimingData.jsonStream');
    mkdirSync(join(fresh.dir, '9102'));
    writeFileSync(big, '');
    truncateSync(big, MAX_SESSION_BYTES + 1); // sparse: no bytes written
    expect(await archive(deps, fresh)).toBe(false);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, error: 'too_large' });
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 0, failed: 1 });
  });

  it('a token that expires mid-run stops it before the next request', async () => {
    f1();
    const asked = requests.length;
    // Valid for 64 s: the Index and one topic, then within 60 s of exp.
    const soon = tokenFile(`${b64({ alg: 'none' })}.${b64({ exp: Math.floor(clock / 1000) + 64 })}.${SIGNATURE}`);
    const fresh = { ...args, tokenFile: soon, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(requests.slice(asked).map((r) => r.path.split('/').at(-1))).toEqual([
      'Index.json',
      'SessionInfo.jsonStream',
    ]);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9101, error: 'token_expired' });
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'token_expired' });
  });

  it('low disk stops the run before a session', async () => {
    f1();
    const asked = requests.length;
    const fresh = { ...args, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive({ ...deps, freeBytes: () => 5 * 1024 ** 3 - 1 }, fresh)).toBe(false);
    expect(requests.slice(asked).map((r) => r.path)).toEqual(['2019/Index.json']);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'disk_low' });
  });

  it('a second run while one holds the lock exits busy, before any request', async () => {
    f1();
    const asked = requests.length;
    await admin.connection().execute(async (conn) => {
      await sql`SELECT pg_advisory_lock(${LOCK_KEY})`.execute(conn);
      try {
        expect(await archive(deps, args)).toBe(false);
      } finally {
        await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
      }
    });
    expect(requests.length).toBe(asked);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'busy' });
  });

  it('a live window stops the run before any request', async () => {
    f1();
    await admin
      .insertInto('meeting')
      .values({ meeting_key: 9900, source: 'openf1', year: 2026, name: 'Live' })
      .execute();
    await admin
      .insertInto('session')
      .values({
        session_key: 9901,
        source: 'openf1',
        meeting_key: 9900,
        date_start: new Date(clock - 3_600_000),
        date_end: new Date(clock + 3_600_000),
      })
      .execute();
    const asked = requests.length;
    expect(await archive(deps, args)).toBe(false);
    expect(requests.length).toBe(asked);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'live_session' });
    await admin.deleteFrom('meeting').where('meeting_key', '=', 9900).execute();
  });

  it('the role exits 1 on an expired token, logged in as f1_ingest, without a request', async () => {
    const asked = requests.length;
    const expired = tokenFile(`${b64({ alg: 'none' })}.${b64({ exp: 1 })}.${SIGNATURE}`);
    const dir = join(mkdtempSync(join(tmpdir(), 'f1-archive-')), 'fixtures-private'); // the CLI takes no other --dir
    const argv = ['archive', '2019', '--token-file', expired, '--dir', dir];
    expect(await run(argv, { DATABASE_URL: testDb.urls.f1_ingest }, () => {})).toBe(1);
    expect(requests.length).toBe(asked);
  });

  it('never logs the token', () => {
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(SIGNATURE);
    expect(all).not.toContain(TOKEN.split('.')[1]);
    expect(all).not.toContain('livetiming');
    expect(all).not.toContain('CHEQUERED FLAG');
  });
});
