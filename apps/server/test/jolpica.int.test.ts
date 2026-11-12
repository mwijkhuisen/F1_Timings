import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Laps, SessionDetail } from '@f1/contracts';
import { type Kysely, sql } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../src/api/access.ts';
import { createApp } from '../src/api/app.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { type JolpicaDeps, jolpica, LOCK_KEY } from '../src/jolpica/job.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';
import { AUD, jwt, rsaKey, serveCerts, TEAM } from './jwt.ts';

// The jolpica job against a real PostgreSQL 18, logged in as f1_ingest, on the synthetic dump in fixtures/jolpica/.
// Expected counts are literals read off the fixture files.

const FIXTURES = join(import.meta.dirname, 'fixtures/jolpica');
const TABLES = ['meeting', 'session', 'driver', 'result', 'pit', 'lap', 'lap_source'] as const;
const RACE_2014 = 120_140_505;
const QUALI_2010 = 120_100_404;

const lines: string[] = [];
const logged = (msg: string) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

let testDb: TestDb;
let db: Kysely<DB>;
let admin: Kysely<DB>;
let deps: JolpicaDeps;
const args = { years: [], dir: FIXTURES };

const count = async (table: string, where = 'true') => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(admin);
  return Number(rows[0]?.n);
};
/** Per table: md5 over every row. */
const hashes = async () => {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const { rows } = await sql<{ h: string }>`
      SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) AS h
      FROM (SELECT to_jsonb(t) AS x FROM ${sql.table(table)} t) s`.execute(admin);
    out[table] = rows[0]?.h ?? '';
  }
  return out;
};

describe('jolpica (synthetic dump, f1_ingest login)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    db = createDb(testDb.urls.f1_ingest);
    admin = createDb(testDb.urls.admin);
    deps = { db, log: pino({ base: null }, { write: (line: string) => void lines.push(line) }) };
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it('imports the 1950–2017 races and qualifyings with the expected rows; 2018 waits for the 2018+ tier', async () => {
    expect(await jolpica(deps, args)).toBe(true);
    const counts = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));
    expect(counts).toEqual({ meeting: 6, session: 10, driver: 27, result: 27, pit: 1, lap: 17, lap_source: 17 });
    for (const table of TABLES) expect(await count(table, "source <> 'jolpica'")).toBe(0);
    expect(await admin.selectFrom('session').select('session_key').orderBy('session_key').execute()).toEqual(
      [
        119_500_105, 119_940_304, 119_940_305, 119_960_204, 119_960_205, 120_050_104, 120_050_105, 120_100_404,
        120_100_405, 120_140_505,
      ].map((session_key) => ({ session_key })),
    );
    expect(await count('session', "ingest_state = 'final' AND next_fetch_at IS NULL AND fetch_count = 1")).toBe(10);
    expect(await count('lap', `session_key = ${RACE_2014} AND is_pit_out`)).toBe(1);
    expect(await count('lap', `session_key = ${RACE_2014} AND is_pit_in`)).toBe(1); // the merge marks the in-lap
    expect(await count('lap', "filled <> '{}'")).toBe(0);
    expect(await count('result', 'grid IS NOT NULL')).toBe(15); // race rows only
    expect(await count('driver', 'driver_number >= 1000')).toBe(2); // E3

    expect(logged('jolpica_start')).toEqual([expect.objectContaining({ years: [] })]);
    expect(logged('jolpica_done').at(-1)).toMatchObject({
      rounds: 6,
      imported: 10,
      failed: 0,
      bad_key: 0,
      no_date: 0,
      bad_time: 1,
      later: 1,
    });
    const race = logged('jolpica').find((l) => l.session_key === RACE_2014);
    expect(race).toMatchObject({
      year: 2014,
      round: 5,
      type: 'Race',
      drivers: 2,
      results: 2,
      laps: 6,
      pits: 1,
      renumbered: 0,
      skipped: { dnq: 0, no_number: 1, lap_dup: 0, bad_pit: 0, pit_dup: 1 },
      merge: expect.objectContaining({ rows: 6 }),
    });
  });

  it('a rerun leaves every table unchanged', async () => {
    const before = await hashes();
    expect(await jolpica(deps, args)).toBe(true);
    expect(await hashes()).toEqual(before);
  });

  it('the years argument limits the run', async () => {
    const before = await hashes();
    const at = lines.length;
    expect(await jolpica(deps, { ...args, years: [2010] })).toBe(true);
    expect(await hashes()).toEqual(before);
    const own = lines.slice(at).map((l) => JSON.parse(l));
    expect(own.filter((l) => l.msg === 'jolpica').map((l) => l.session_key)).toEqual([QUALI_2010, 120_100_405]);
  });

  it('leaves a session of another source untouched and fails it (not_jolpica), and the role exits 1', async () => {
    await admin
      .updateTable('session')
      .set({ source: 'openf1', name: 'Theirs' })
      .where('session_key', '=', RACE_2014)
      .execute();
    const before = await hashes();
    const dir = join(mkdtempSync(join(tmpdir(), 'f1-jolpica-')), 'fixtures-private'); // the CLI takes no other --dir
    mkdirSync(dir);
    cpSync(FIXTURES, dir, { recursive: true });
    expect(await run(['jolpica', '2014', '--dir', dir], { DATABASE_URL: testDb.urls.f1_ingest }, () => {})).toBe(1);
    expect(await hashes()).toEqual(before);

    const at = lines.length;
    expect(await jolpica(deps, { ...args, years: [2014] })).toBe(false);
    const own = lines.slice(at).map((l) => JSON.parse(l));
    expect(own.filter((l) => l.msg === 'jolpica').map((l) => [l.session_key, l.error])).toEqual([
      [RACE_2014, 'not_jolpica'],
    ]);
    expect(own.at(-1)).toMatchObject({ msg: 'jolpica_done', imported: 0, failed: 1 });
    expect(await hashes()).toEqual(before);
    await admin
      .updateTable('session')
      .set({ source: 'jolpica', name: 'Race' })
      .where('session_key', '=', RACE_2014)
      .execute();
  });

  it('a dump with a missing file stops with bad_dump, its code and the file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1-jolpica-'));
    expect(await jolpica(deps, { years: [], dir })).toBe(false);
    expect(logged('jolpica_done').at(-1)).toMatchObject({
      error: 'bad_dump',
      code: 'missing',
      file: 'formula_one_season.csv',
    });
  });

  it('a second run while one holds the lock exits busy', async () => {
    await sql`SELECT pg_advisory_lock(${LOCK_KEY})`.execute(admin);
    try {
      expect(await jolpica(deps, args)).toBe(false);
      expect(logged('jolpica_done').at(-1)).toMatchObject({ error: 'busy' });
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(admin);
    }
  });

  it("a jolpica session's API answers parse with the SessionDetail and Laps contracts", async () => {
    const apiDb = createDb(testDb.urls.f1_api);
    try {
      const log = pino({ level: 'silent' });
      const app = createApp({ db: apiDb, access: access({ team: TEAM, aud: AUD }, log), log, liveDir: '/nonexistent' });
      const key = await rsaKey('test-kid');
      serveCerts([key.pub]);
      const token = await jwt(key.priv);
      const get = async (path: string) => {
        const res = await app.request(path, { headers: { 'cf-access-jwt-assertion': token } });
        expect(res.status, path).toBe(200);
        return res.json();
      };
      for (const session of [RACE_2014, QUALI_2010, 119_500_105]) {
        const detail = SessionDetail.parse(await get(`/api/v1/sessions/${session}`));
        expect(detail.session.session_key).toBe(session);
        Laps.parse(await get(`/api/v1/sessions/${session}/laps`));
      }
      const detail = SessionDetail.parse(await get(`/api/v1/sessions/${QUALI_2010}`));
      expect(detail.results.map((r) => r.position)).toEqual([1, 2, 3, 4]);
      expect(detail.meeting.gmt_offset).toBe('08:00:00');
      expect(Laps.parse(await get(`/api/v1/sessions/${RACE_2014}/laps`)).length).toBe(6);
    } finally {
      await apiDb.destroy();
    }
  });

  it('never logs a name, a time or a path', () => {
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(10);
    for (const text of ['Driver', 'Team One', 'Test Ring', 'Testville', 'Grand Prix', FIXTURES, '01:45', 'Madrid'])
      expect(all).not.toContain(text);
  });
});
