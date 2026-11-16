import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
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
import { MAX_BYTES, MAX_SESSION_BYTES, ORIGIN, RAW_MAX_BYTES } from '../src/archive/files.ts';
import {
  type ArchiveArgs,
  type ArchiveDeps,
  archive,
  FINAL_AFTER_MS,
  GAP_MS,
  LOCK_KEY,
  OLD_TOPICS,
  TOPICS,
} from '../src/archive/job.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';

// The archive job against a real PostgreSQL 18, logged in as f1_ingest, with the F1 archive replaced by the synthetic
// fixtures in fixtures/archive/ (msw). Expected counts are literals read off the fixture files.

const FIXTURES = join(import.meta.dirname, 'fixtures/archive');
const MEETING = '2019-03-17_Synthetic_Grand_Prix';
const RACE = `2019/${MEETING}/2019-03-17_Race/`;
const QUALI = `2019/${MEETING}/2019-03-16_Qualifying/`;
const FILES_GP = '2023/2023-03-05_Files_Grand_Prix';
/** A session's archive path, without its final `/` → the fixture directory that serves its topics. */
const DIRS: Record<string, string> = {
  [RACE.slice(0, -1)]: 'race',
  [QUALI.slice(0, -1)]: 'quali',
  '2019/2019-04-14_Old_Grand_Prix/2019-04-13_Qualifying': 'old-quali', // 2019-style: no SessionData
  [`2019/${MEETING}/2019-03-15_Sprint`]: 'race', // off-Index (EXTRAS), its own SessionInfo in INFOS
  '2019/2019-05-01_Extra_Test/2019-04-30_Practice_1': 'quali', // off-Index, its SessionInfo Key is not the table's
  [`${FILES_GP}/2023-03-04_Qualifying`]: 'quali', // files-only (H3)
  [`${FILES_GP}/2023-03-05_Race`]: 'race',
};
const TABLES = ['driver', 'lap', 'lap_source', 'stint', 'race_control', 'result', 'weather'] as const;

/** A 2023 Index: files only (H3), so the fixtures' SessionInfo Keys (9101, 9102) never matter. */
const INDEX_2023 = {
  Meetings: [
    {
      Key: 9200,
      Name: 'Files Grand Prix',
      Sessions: [
        ['9201', 'Qualifying', '2023-03-04_Qualifying', '2023-03-04T18:00:00', '2023-03-04T19:00:00'],
        ['9202', 'Race', '2023-03-05_Race', '2023-03-05T18:00:00', '2023-03-05T20:00:00'],
        ['9203', 'Practice', '2023-03-03_Practice_1', '2023-03-03T14:00:00', '2023-03-03T15:00:00'], // no files: 403
      ].map(([key, type, dir, start, end]) => ({
        Key: Number(key),
        Type: type,
        Name: type,
        StartDate: start,
        EndDate: end,
        GmtOffset: '03:00:00',
        Path: `${FILES_GP}/${dir}/`,
      })),
    },
  ],
};
const INDEXES: Record<string, Buffer | string> = {
  2019: readFileSync(join(FIXTURES, 'index-2019.json')),
  2023: JSON.stringify(INDEX_2023),
};

/** The race fixture's SessionInfo with some fields replaced, as one stream line. */
const RACE_INFO = JSON.parse(readFileSync(join(FIXTURES, 'race/SessionInfo.jsonStream'), 'utf8').slice(13));
const info = (patch: Record<string, unknown>) => `\uFEFF23:45:00.000${JSON.stringify({ ...RACE_INFO, ...patch })}\r\n`;
const SPRINT = `2019/${MEETING}/2019-03-15_Sprint/`;
const EXTRA_TEST = '2019/2019-05-01_Extra_Test/2019-04-30_Practice_1/';
const GONE = '2019/2019-06-02_Gone_Grand_Prix/2019-06-01_Practice_1/';
/** Off-Index SessionInfo streams by path; the payload Paths are not the table's. */
const INFOS: Record<string, string> = {
  [`${SPRINT}SessionInfo.jsonStream`]: info({
    Key: 9103,
    Meeting: { Key: 9100, Name: 'Synthetic Grand Prix' }, // fewer fields than the Index's meeting
    Name: 'Sprint',
    StartDate: '2019-03-15T12:00:00',
    EndDate: '2019-03-15T13:00:00',
    Path: '2019/elsewhere/2019-03-15_Sprint/',
  }),
  [`${EXTRA_TEST}SessionInfo.jsonStream`]: info({
    Key: 9142, // the table says 9141
    Meeting: { ...RACE_INFO.Meeting, Key: 9140, Name: 'Extra Test' },
    Type: 'Practice',
    Name: 'Practice 1',
    StartDate: '2019-04-30T10:00:00',
    EndDate: '2019-04-30T18:00:00',
    GmtOffset: '03:00:00',
    Path: EXTRA_TEST,
  }),
};
/** OFF_INDEX for 2019 in the tests (the deps seam): a sprint in meeting 9100, a wrong key, a 403, an Index key. */
const EXTRAS = {
  2019: [
    { key: 9103, path: SPRINT },
    { key: 9141, path: EXTRA_TEST },
    { key: 9151, path: GONE },
    { key: 9101, path: `2019/${MEETING}/2019-03-16_Other/` }, // the Index lists 9101 with a Path: it wins
  ],
};

let clock = Date.parse('2026-11-10T12:00:00Z');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SIGNATURE = 'c3ludGhldGljLXNpZ25hdHVyZS0wMTIz';
const TOKEN = `${b64({ alg: 'none' })}.${b64({ exp: clock / 1000 + 86_400 })}.${SIGNATURE}`;

/** Every request: its path below static/, the clock at its start, its Authorization header. */
const requests: { path: string; at: number; auth: string | null }[] = [];
const lines: string[] = [];
const logged = (msg: string) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);
const since = (from: number) => requests.slice(from).map((r) => r.path);

/** A session Index.json listing these topics, each with a StreamPath the job must never use. */
const feeds = (names: readonly string[]) =>
  HttpResponse.json({
    Feeds: Object.fromEntries(
      names.map((n) => [n, { KeyFramePath: `${n}.json`, StreamPath: `../../${n}.jsonStream` }]),
    ),
  });

/**
 * Serves the year Indexes, the INFOS and the fixture files. A session's own Index.json lists exactly its fixture's
 * topics, so by default the job asks for the TOPICS only. A topic a fixture lacks, and every file of another session,
 * is a 403. `status` can force a status or a whole response.
 */
const f1 = (status?: (path: string) => number | Response | undefined) =>
  server.use(
    http.get(`${ORIGIN}/static/*`, ({ request }) => {
      const path = new URL(request.url).pathname.slice('/static/'.length);
      requests.push({ path, at: clock, auth: request.headers.get('authorization') });
      const forced = status?.(path);
      if (typeof forced === 'number') return new HttpResponse(null, { status: forced });
      if (forced !== undefined) return forced;
      const year = /^(\d{4})\/Index\.json$/.exec(path)?.[1];
      if (year !== undefined)
        return INDEXES[year] ? new HttpResponse(INDEXES[year]) : new HttpResponse(null, { status: 403 });
      if (INFOS[path] !== undefined) return new HttpResponse(INFOS[path]);
      const [, session = '', name = ''] = /^(.+)\/([^/]+)$/.exec(path) ?? [];
      const dir = DIRS[session];
      if (dir === undefined) return new HttpResponse(null, { status: 403 });
      const topics = readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith('.jsonStream'));
      if (name === 'Index.json') return feeds(topics.map((f) => f.slice(0, -'.jsonStream'.length)));
      return topics.includes(name)
        ? new HttpResponse(readFileSync(join(FIXTURES, dir, name)))
        : new HttpResponse(null, { status: 403 });
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

    // The year Index; 3 sessions × their Index + the topics it lists (8 + 7 + 8: an unlisted TOPIC is not asked for,
    // #146); the all-403 session's Index and SessionInfo. One at a time, 2 s apart, with the token.
    expect(requests.length).toBe(29);
    for (const [i, r] of requests.entries()) {
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
      if (i > 0) expect(r.at - (requests[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(GAP_MS);
    }
    expect(readdirSync(join(args.dir, '9102')).sort()).toEqual([
      'DriverList.jsonStream',
      'Heartbeat.jsonStream',
      'Index.json',
      'RaceControlMessages.jsonStream',
      'SessionData.jsonStream',
      'SessionInfo.jsonStream',
      'TimingAppData.jsonStream',
      'TimingData.jsonStream',
      'WeatherData.jsonStream',
    ]);
    // No marker for a topic its Index omits (Heartbeat of 9101, SessionData of 9121), and none for SessionInfo or
    // TimingData either way. The all-403 session's Index was a 403: the marker.
    expect(existsSync(join(args.dir, '9101', 'Heartbeat.missing'))).toBe(false);
    expect(existsSync(join(args.dir, '9121', 'SessionData.missing'))).toBe(false);
    expect(readdirSync(join(args.dir, '9111'))).toEqual(['Index.missing']);
    expect(readFileSync(join(args.dir, 'index-2019.json'))).toEqual(readFileSync(join(FIXTURES, 'index-2019.json')));

    const bySession = Object.fromEntries(logged('archive').map((l) => [l.session_key, l]));
    expect(bySession[9102]).toMatchObject({
      level: 30, // info
      year: 2019,
      type: 'Race',
      files: 8,
      raw_files: 0,
      skipped_files: 0,
      topics: 8,
      topics_from: 'index',
      t0: 'sessiondata',
      t0_heartbeat_delta_ms: -2000,
      laps: 6,
      stints: 3,
      drivers: 2,
      race_control: 3,
      weather: 3,
      phases: 0,
    });
    expect(bySession[9101]).toMatchObject({
      files: 7,
      skipped_files: 0,
      topics: 7,
      t0_heartbeat_delta_ms: null,
      phases: 2,
    });
    expect(bySession[9121]).toMatchObject({ files: 8, skipped_files: 0, topics: 8, t0: 'clock', laps: 10, phases: 2 });
    expect(bySession[9111]).toMatchObject({ files: 0, skipped_files: 1, topics: 30, topics_from: 'fallback' });
    expect(bySession[9111]).toMatchObject({ error: 'incomplete' });
    expect(logged('archive_done').at(-1)).toMatchObject({
      downloaded: 3,
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
      expect(l.merge).toEqual({
        rows: l.laps,
        added: {},
        dup: {},
        filled: {},
        diffs: {},
        conflicts: {},
        rules: l.rules,
      });
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
    // The year Index, the first session's Index, SessionInfo (its Index omits Heartbeat), then its SessionData: 401.
    expect(requests.slice(asked).map((r) => r.path.split('/').at(-1))).toEqual([
      'Index.json',
      'Index.json',
      'SessionInfo.jsonStream',
      'SessionData.jsonStream',
    ]);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9101, error: 'http_401' });
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
      { ...race, Key: 9132, Type: 'Race\u001b[2J' }, // the race's Path, so its SessionInfo Key is 9102
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
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9132, type: 'other' }); // remote text: never logged
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
    // Valid for 64 s: the year Index and the first session's Index, then within 60 s of exp.
    const soon = tokenFile(`${b64({ alg: 'none' })}.${b64({ exp: Math.floor(clock / 1000) + 64 })}.${SIGNATURE}`);
    const fresh = { ...args, tokenFile: soon, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive(deps, fresh)).toBe(false);
    expect(since(asked)).toEqual(['2019/Index.json', `${QUALI}Index.json`]);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9101, error: 'token_expired' });
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'token_expired' });
  });

  it('low disk stops the run before the first request', async () => {
    f1();
    const asked = requests.length;
    const fresh = { ...args, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive({ ...deps, freeBytes: () => 5 * 1024 ** 3 - 1 }, fresh)).toBe(false);
    expect(requests.length).toBe(asked);
    expect(logged('archive_done').at(-1)).toMatchObject({ error: 'disk_low' });
  });

  it('low disk mid-session stops the run before the next request (the floor is checked before each one)', async () => {
    f1();
    const asked = requests.length;
    let checks = 0;
    const freeBytes = () => (checks++ < 3 ? 6 : 5) * 1024 ** 3 - 1; // under 5 GiB from the fourth request on
    const fresh = { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    expect(await archive({ ...deps, freeBytes }, fresh)).toBe(false);
    expect(since(asked)).toEqual(['2019/Index.json', `${RACE}Index.json`, `${RACE}SessionInfo.jsonStream`]);
    expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, error: 'disk_low' });
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

  describe('P3e: every topic of the session Index', () => {
    const fresh = (keys: number[]) => ({ ...args, keys, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) });
    const garbage = () => new HttpResponse('not a stream line\r\n');

    it('asks for its valid topics once each, the parsed TOPICS first; raw files change no row, and a rerun asks nothing', async () => {
      f1();
      const plain = fresh([9102]);
      expect(await archive(deps, plain)).toBe(true);
      const before = await hashes();

      const listed = [...TOPICS, 'CarData.z', 'ContentStreams', '../x', 'A/B', 'Index', 'Position.z'];
      const raw = [`${RACE}CarData.z.jsonStream`, `${RACE}ContentStreams.jsonStream`];
      f1((path) => (path === `${RACE}Index.json` ? feeds(listed) : raw.includes(path) ? garbage() : undefined));
      const all = fresh([9102]);
      const asked = requests.length;
      expect(await archive(deps, all)).toBe(true);
      expect(since(asked)).toEqual([
        '2019/Index.json',
        `${RACE}Index.json`,
        ...TOPICS.map((t) => `${RACE}${t}.jsonStream`),
        ...raw,
        `${RACE}Position.z.jsonStream`, // a 403: a marker
      ]);
      // Written, never read: the rows equal the run without them, and no garbage line is counted.
      expect(await hashes()).toEqual(before);
      expect(logged('archive').at(-1)).toMatchObject({
        session_key: 9102,
        files: 8,
        raw_files: 2,
        skipped_files: 3,
        topics: 13,
        topics_from: 'index',
        skipped_lines: 0,
      });
      expect(readdirSync(join(all.dir, '9102'))).toEqual(
        expect.arrayContaining([
          'Index.json',
          'CarData.z.jsonStream',
          'ContentStreams.jsonStream',
          'Position.z.missing',
        ]),
      );
      expect(logged('archive_done').at(-1)).toMatchObject({ downloaded: 1, imported: 1, failed: 0 });

      const again = requests.length;
      expect(await archive(deps, all)).toBe(true);
      expect(since(again)).toEqual(['2019/Index.json']);
      expect(await hashes()).toEqual(before);
    });

    it('a session Index that omits SessionData and Heartbeat: no request and no marker for either, the same rows as when they answered 403 (#146)', async () => {
      const OLD = '2019/2019-04-14_Old_Grand_Prix/2019-04-13_Qualifying/';
      // Listed and answered 403: the markers, and the rows the omission must reproduce.
      f1((path) => (path === `${OLD}Index.json` ? feeds(TOPICS) : undefined));
      const asked = fresh([9121]);
      expect(await archive(deps, asked)).toBe(true);
      expect(existsSync(join(asked.dir, '9121', 'SessionData.missing'))).toBe(true);
      expect(existsSync(join(asked.dir, '9121', 'Heartbeat.missing'))).toBe(true);
      expect(logged('archive').at(-1)).toMatchObject({ files: 8, skipped_files: 2, topics: 10, t0: 'clock' });
      const before = await hashes();

      f1();
      const omitted = fresh([9121]);
      const start = requests.length;
      expect(await archive(deps, omitted)).toBe(true);
      const fixture = TOPICS.filter((t) => existsSync(join(FIXTURES, 'old-quali', `${t}.jsonStream`)));
      expect(fixture).not.toContain('SessionData');
      expect(fixture).not.toContain('Heartbeat');
      expect(since(start)).toEqual([
        '2019/Index.json',
        `${OLD}Index.json`,
        ...fixture.map((t) => `${OLD}${t}.jsonStream`),
      ]);
      expect(readdirSync(join(omitted.dir, '9121')).filter((f) => f.endsWith('.missing'))).toEqual([]);
      expect(logged('archive').at(-1)).toMatchObject({ files: 8, skipped_files: 0, topics: 8, t0: 'clock', laps: 10 });
      expect(logged('archive').at(-1)).not.toHaveProperty('error');
      expect(await hashes()).toEqual(before);
    });

    it.each(['SessionInfo', 'TimingData'])(
      'a session Index that omits %s: incomplete with no request and no marker, and no other topic downloaded (#146)',
      async (omitted) => {
        f1((path) => (path === `${RACE}Index.json` ? feeds(TOPICS.filter((t) => t !== omitted)) : undefined));
        const dir = fresh([9102]);
        const asked = requests.length;
        expect(await archive(deps, dir)).toBe(true);
        expect(since(asked)).toEqual(['2019/Index.json', `${RACE}Index.json`]);
        expect(readdirSync(join(dir.dir, '9102'))).toEqual(['Index.json']);
        expect(logged('archive').at(-1)).toMatchObject({
          session_key: 9102,
          files: 0,
          skipped_files: 1,
          topics: 9,
          topics_from: 'index',
          error: 'incomplete',
        });
        expect(logged('archive_done').at(-1)).toMatchObject({ downloaded: 0, imported: 0, failed: 0, incomplete: 1 });
      },
    );

    it('a session Index of 65 topics fails the session (too_many_topics), another Index failure fails it too', async () => {
      const many = Array.from({ length: 65 }, (_, i) => `Topic${i}`);
      f1((path) => (path === `${RACE}Index.json` ? feeds(many) : path === `${QUALI}Index.json` ? 500 : undefined));
      const asked = requests.length;
      expect(await archive(deps, fresh([9101, 9102]))).toBe(false);
      expect(since(asked)).toEqual(['2019/Index.json', `${QUALI}Index.json`, `${RACE}Index.json`]);
      expect(
        logged('archive')
          .slice(-2)
          .map((l) => [l.session_key, l.error, l.topics]),
      ).toEqual([
        [9101, 'http_500', undefined],
        [9102, 'too_many_topics', 65],
      ]);
      expect(logged('archive_done').at(-1)).toMatchObject({ downloaded: 0, imported: 0, failed: 2 });
    });

    it('a session Index 403 leaves Index.missing and asks for OLD_TOPICS after the TOPICS; the rerun asks again for neither', async () => {
      f1((path) => (path === `${QUALI}Index.json` ? 403 : undefined));
      const dir = fresh([9101]);
      const asked = requests.length;
      expect(await archive(deps, dir)).toBe(true);
      const list = [...new Set<string>([...TOPICS, ...OLD_TOPICS])];
      expect(list).toHaveLength(30);
      expect(since(asked)).toEqual([
        '2019/Index.json',
        `${QUALI}Index.json`,
        ...list.map((t) => `${QUALI}${t}.jsonStream`),
      ]);
      expect(existsSync(join(dir.dir, '9101', 'Index.missing'))).toBe(true);
      expect(logged('archive').at(-1)).toMatchObject({
        session_key: 9101,
        files: 7,
        raw_files: 0,
        skipped_files: 23,
        topics: 30,
        topics_from: 'fallback',
      });
      f1();
      const again = requests.length;
      expect(await archive(deps, dir)).toBe(true);
      expect(since(again)).toEqual(['2019/Index.json']);
    });

    it('a raw topic failure still writes the rows and fails the session; the rerun asks for the raw topics again', async () => {
      f1((path) =>
        path === `${RACE}Index.json`
          ? feeds([...TOPICS, 'CarData.z', 'TrackStatus'])
          : path === `${RACE}CarData.z.jsonStream`
            ? 500
            : undefined,
      );
      const dir = fresh([9102]);
      expect(await archive(deps, dir)).toBe(false);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, level: 50, laps: 6, error: 'http_500' });
      expect(logged('archive').at(-1)).toHaveProperty('merge'); // written
      expect(logged('archive_done').at(-1)).toMatchObject({ downloaded: 0, imported: 1, failed: 1 });
      f1();
      const asked = requests.length;
      expect(await archive(deps, dir)).toBe(true);
      expect(since(asked)).toEqual(['2019/Index.json', `${RACE}CarData.z.jsonStream`, `${RACE}TrackStatus.jsonStream`]);
    });

    it('a session Index 200 that is no {Feeds} is not kept: this run takes OLD_TOPICS, the rerun asks again', async () => {
      f1((path) => (path === `${RACE}Index.json` ? new HttpResponse('<html>error</html>') : undefined));
      const dir = fresh([9102]);
      expect(await archive(deps, dir)).toBe(true);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, topics: 30, topics_from: 'fallback' });
      expect(existsSync(join(dir.dir, '9102', 'Index.json'))).toBe(false);
      f1();
      const asked = requests.length;
      expect(await archive(deps, dir)).toBe(true);
      expect(since(asked)).toEqual(['2019/Index.json', `${RACE}Index.json`]);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, topics_from: 'index' });
    });

    it('a directory in the P3a layout asks for the session Index and the new topics only; the rows stay identical', async () => {
      f1();
      const p3e = fresh([9102]);
      expect(await archive(deps, p3e)).toBe(true);
      const before = await hashes();
      // P3a: the 10 TOPICS files and markers, no session Index.
      const p3a = fresh([9102]);
      mkdirSync(join(p3a.dir, '9102'));
      for (const f of readdirSync(join(p3e.dir, '9102')).filter((f) => f !== 'Index.json'))
        writeFileSync(join(p3a.dir, '9102', f), readFileSync(join(p3e.dir, '9102', f)));
      for (const t of ['ExtrapolatedClock', 'SessionStatus']) writeFileSync(join(p3a.dir, '9102', `${t}.missing`), '');
      expect(readdirSync(join(p3a.dir, '9102'))).toHaveLength(TOPICS.length);
      const raw = [`${RACE}CarData.z.jsonStream`, `${RACE}TeamRadio.jsonStream`];
      f1((path) =>
        path === `${RACE}Index.json`
          ? feeds([...TOPICS, 'CarData.z', 'TeamRadio'])
          : raw.includes(path)
            ? garbage()
            : undefined,
      );
      const asked = requests.length;
      expect(await archive(deps, p3a)).toBe(true);
      expect(since(asked)).toEqual(['2019/Index.json', `${RACE}Index.json`, ...raw]);
      expect(await hashes()).toEqual(before);
    });

    it('a raw file over RAW_MAX_BYTES fails the session as too_large; a parsed topic keeps MAX_BYTES', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      const big = () => {
        let pulls = 0;
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulls++ <= RAW_MAX_BYTES / chunk.length) c.enqueue(chunk);
              else c.close();
            },
          }),
        );
      };
      expect(RAW_MAX_BYTES + chunk.length).toBeLessThan(MAX_BYTES);
      f1((path) =>
        path === `${RACE}Index.json`
          ? feeds([...TOPICS, 'CarData.z'])
          : path === `${RACE}CarData.z.jsonStream`
            ? big()
            : undefined,
      );
      const dir = fresh([9102]);
      expect(await archive(deps, dir)).toBe(false);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, error: 'too_large' });
      expect(readdirSync(join(dir.dir, '9102')).filter((f) => f.startsWith('CarData'))).toEqual([]);
      // The same size as a parsed topic (WeatherData) is no failure: MAX_BYTES.
      f1((path) => (path === `${RACE}WeatherData.jsonStream` ? big() : undefined));
      const parsed = fresh([9102]);
      await archive(deps, parsed);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, error: 'too_large' }); // MAX_SESSION_BYTES
      expect(statSync(join(parsed.dir, '9102', 'WeatherData.jsonStream')).size).toBe(RAW_MAX_BYTES + chunk.length);
    });

    it('a raw file over MAX_SESSION_BYTES on disk is never counted: the session imports', async () => {
      f1((path) => (path === `${RACE}Index.json` ? feeds([...TOPICS, 'CarData.z']) : undefined));
      const dir = fresh([9102]);
      mkdirSync(join(dir.dir, '9102'));
      const big = join(dir.dir, '9102', 'CarData.z.jsonStream');
      writeFileSync(big, '');
      truncateSync(big, MAX_SESSION_BYTES + 1); // sparse: no bytes written
      expect(await archive(deps, dir)).toBe(true);
      expect(logged('archive').at(-1)).toMatchObject({ session_key: 9102, files: 8, raw_files: 1 });
      expect(logged('archive').at(-1)).not.toHaveProperty('error');
    });
  });

  it('2023 on (H3): downloads every file and writes no row, even from a garbage TimingData; downloaded, not imported', async () => {
    const race = `${FILES_GP}/2023-03-05_Race/`;
    const quali = `${FILES_GP}/2023-03-04_Qualifying/`;
    f1((path) =>
      path === `${race}Index.json`
        ? feeds([...TOPICS, 'CarData.z'])
        : path === `${race}CarData.z.jsonStream` || path === `${quali}TimingData.jsonStream`
          ? new HttpResponse('not a stream line\r\n')
          : undefined,
    );
    const dir = { ...args, year: 2023, dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    const asked = requests.length;
    expect(await archive(deps, dir)).toBe(true);
    expect(since(asked)).toContain(`${race}CarData.z.jsonStream`);
    expect(readFileSync(join(dir.dir, '9201', 'TimingData.jsonStream'), 'utf8')).toBe('not a stream line\r\n');
    expect(existsSync(join(dir.dir, '9202', 'CarData.z.jsonStream'))).toBe(true);
    expect(existsSync(join(dir.dir, 'index-2023.json'))).toBe(true);
    expect(await count('meeting', 'meeting_key = 9200')).toBe(0);
    expect(await count('session', 'session_key IN (9201, 9202, 9203)')).toBe(0);
    const bySession = Object.fromEntries(
      logged('archive')
        .filter((l) => l.year === 2023)
        .map((l) => [l.session_key, l]),
    );
    expect(bySession[9201]).toMatchObject({ level: 30, files: 7, raw_files: 0, topics: 7 });
    expect(bySession[9202]).toMatchObject({ level: 30, files: 8, raw_files: 1, topics: 11, topics_from: 'index' });
    for (const key of [9201, 9202]) {
      expect(bySession[key]).not.toHaveProperty('error');
      expect(bySession[key]).not.toHaveProperty('t0');
    }
    expect(bySession[9203]).toMatchObject({ files: 0, skipped_files: 1, error: 'incomplete' });
    expect(logged('archive_done').at(-1)).toMatchObject({
      year: 2023,
      downloaded: 2,
      imported: 0,
      failed: 0,
      incomplete: 1,
    });
  });

  it('off-Index sessions (D1): SessionInfo first, by the table path; the meeting spans them; a wrong key and a 403', async () => {
    f1();
    const off = { ...deps, offIndex: EXTRAS };
    const dir = { ...args, keys: [9102, 9103, 9141, 9151], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    const asked = requests.length;
    expect(await archive(off, dir)).toBe(false);
    const paths = since(asked);
    // The SessionInfo of each extra before the sessions, in table order; none for 9101 (the Index's Path wins).
    expect(paths.slice(0, 4)).toEqual([
      '2019/Index.json',
      `${SPRINT}SessionInfo.jsonStream`,
      `${EXTRA_TEST}SessionInfo.jsonStream`,
      `${GONE}SessionInfo.jsonStream`,
    ]);
    // Then the race, the sprint (its SessionInfo already on disk) and the test day, every request by the table path, for
    // the TOPICS their Index lists (the race fixture's 8, the quali fixture's 7).
    const inRace = TOPICS.filter((t) => t !== 'ExtrapolatedClock' && t !== 'SessionStatus');
    const inQuali = inRace.filter((t) => t !== 'Heartbeat');
    expect(paths.slice(4)).toEqual([
      `${RACE}Index.json`,
      ...inRace.map((t) => `${RACE}${t}.jsonStream`),
      `${SPRINT}Index.json`,
      ...inRace.filter((t) => t !== 'SessionInfo').map((t) => `${SPRINT}${t}.jsonStream`),
      `${EXTRA_TEST}Index.json`,
      ...inQuali.filter((t) => t !== 'SessionInfo').map((t) => `${EXTRA_TEST}${t}.jsonStream`),
    ]);
    expect(paths.some((p) => p.startsWith('2019/elsewhere/') || p.includes('2019-03-16_Other'))).toBe(false);

    expect(
      await admin
        .selectFrom('session')
        .select(['session_key', 'meeting_key', 'type', 'name', 'date_start', 'date_end'])
        .where('session_key', 'in', [9103, 9141, 9142, 9151])
        .execute(),
    ).toEqual([
      {
        session_key: 9103,
        meeting_key: 9100,
        type: 'Race',
        name: 'Sprint',
        date_start: new Date('2019-03-15T01:00:00Z'),
        date_end: new Date('2019-03-15T02:00:00Z'),
      },
    ]);
    const span = async () =>
      admin.selectFrom('meeting').select(['date_start', 'date_end']).where('meeting_key', '=', 9100).executeTakeFirst();
    expect(await span()).toEqual({
      date_start: new Date('2019-03-15T01:00:00Z'),
      date_end: new Date('2019-03-17T07:10:00Z'),
    });
    expect(await count('lap', 'session_key = 9103')).toBe(await count('lap', 'session_key = 9102'));
    expect(
      logged('archive')
        .filter((l) => [9141, 9151].includes(l.session_key))
        .map((l) => [l.session_key, l.error]),
    ).toEqual([
      [9151, 'incomplete'],
      [9141, 'key_mismatch'],
    ]);
    expect(existsSync(join(dir.dir, '9151'))).toBe(false); // a 403 there leaves no marker
    expect(logged('archive_done').at(-1)).toMatchObject({ downloaded: 3, imported: 2, failed: 1, incomplete: 1 });

    // A keyed rerun: the same span, the 403 asked again (a 500 now, so it fails), and no key is not_in_index.
    f1((path) => (path === `${GONE}SessionInfo.jsonStream` ? 500 : undefined));
    const again = requests.length;
    expect(await archive(off, { ...dir, keys: [9102, 9151] })).toBe(false);
    expect(since(again)).toEqual(['2019/Index.json', `${GONE}SessionInfo.jsonStream`]);
    expect(await span()).toEqual({
      date_start: new Date('2019-03-15T01:00:00Z'),
      date_end: new Date('2019-03-17T07:10:00Z'),
    });
    expect(logged('archive').at(-2)).toMatchObject({ session_key: 9151, error: 'http_500' });
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 1, failed: 1 });
    expect(logged('archive').some((l) => l.error === 'not_in_index' && l.session_key === 9151)).toBe(false);
  });

  it('one meeting row per meeting_key, the Index meeting first: a full and a keyed run write the same row', async () => {
    f1();
    const off = { ...deps, offIndex: EXTRAS };
    const dir = { ...args, keys: [9102, 9103], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) };
    const row = async () =>
      admin.selectFrom('meeting').selectAll().where('meeting_key', '=', 9100).executeTakeFirstOrThrow();
    expect(await archive(off, dir)).toBe(true); // the sprint (its SessionInfo meeting) is written last
    const full = await row();
    expect(full).toMatchObject({ official_name: 'FORMULA 1 SYNTHETIC GRAND PRIX 2019', location: 'Nowhere' });
    expect(await archive(off, { ...dir, keys: [9102] })).toBe(true);
    expect(await row()).toEqual(full);
  });

  it("an unwanted off-Index entry's failure counts nothing in a keyed run", async () => {
    f1((path) => (path === `${GONE}SessionInfo.jsonStream` ? 500 : undefined));
    const off = { ...deps, offIndex: EXTRAS };
    const from = logged('archive').length;
    expect(await archive(off, { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) })).toBe(true);
    expect(
      logged('archive')
        .slice(from)
        .map((l) => l.session_key),
    ).toEqual([9102]);
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 1, failed: 0, incomplete: 0 });
  });

  it('an off-Index entry planSessions drops (no StartDate) is bad_index for its key, and failed', async () => {
    f1((path) =>
      path === `${GONE}SessionInfo.jsonStream` ? new HttpResponse(info({ StartDate: undefined })) : undefined,
    );
    const off = { ...deps, offIndex: EXTRAS };
    expect(await archive(off, { ...args, keys: [9151], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) })).toBe(false);
    expect(logged('archive').at(-1)).toMatchObject({ level: 50, session_key: 9151, error: 'bad_index' });
    expect(logged('archive_done').at(-1)).toMatchObject({ imported: 0, failed: 1 });
  });

  it('skips a session that ended under FINAL_AFTER_MS ago (recent): no request, no failure', async () => {
    f1();
    const raceEnd = Date.parse('2019-03-17T07:10:00Z');
    const soon = { ...deps, now: () => new Date(raceEnd + FINAL_AFTER_MS - 60_000) };
    const asked = requests.length;
    expect(await archive(soon, { ...args, keys: [9102], dir: mkdtempSync(join(tmpdir(), 'f1-archive-')) })).toBe(true);
    expect(since(asked)).toEqual(['2019/Index.json']);
    expect(logged('archive').at(-1)).toMatchObject({ level: 30, session_key: 9102, type: 'Race', state: 'recent' });
    expect(logged('archive_done').at(-1)).toMatchObject({ recent: 1, downloaded: 0, imported: 0, failed: 0 });
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
    // Topic names come from untrusted Index text: never logged.
    for (const name of ['CarData', 'ContentStreams', 'TimingData', '../x']) expect(all).not.toContain(name);
  });
});
