import { Standings, Status } from '@f1/contracts';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access } from '../src/api/access.ts';
import { createApp } from '../src/api/app.ts';
import { createDb, type DB } from '../src/db/db.ts';
import { run } from '../src/main.ts';
import { createTestDb, type TestDb } from './db.ts';
import { AUD, jwt, rsaKey, serveCerts, TEAM } from './jwt.ts';

// P8: GET /sessions/:key/standings and /status `standings_mismatch` (A§9, A§10) on a seeded 2025-like season, 2024 and
// 2022: the contract, the fixed errors, the cache rule, and that no session after S (or after the next one) is read.

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const QUALI = 100;
const R1 = 101; // a race
const SPRINT = 102; // a sprint, between R1 and R3
const R3 = 103;
const R4 = 104; // R3's next counted session: its points_start is the standing after R3
const R5 = 105; // no championship rows to begin with: R4's standing is a fallback
const OLD = 200; // 2022
const R300 = 300; // 2024, two mismatches
const R301 = 301;

const FINAL = 'private, max-age=86400';
const NO_STORE = 'no-store';
const ANN = 'Ann Alpha';
const BOB = 'Bob Beta';

let testDb: TestDb;
let admin: Kysely<DB>;
let apiDb: Kysely<DB>;
let app: Hono;
let token: string;
let key: Awaited<ReturnType<typeof rsaKey>>;
const lines: string[] = [];
const log = pino({ base: null }, { write: (line: string) => void lines.push(line) });

const get = (path: string) => app.request(path, { headers: { 'cf-access-jwt-assertion': token } });
const std = async (session: number, query = '') => {
  const res = await get(`/api/v1/sessions/${session}/standings${query}`);
  const text = await res.text();
  return { status: res.status, cache: res.headers.get('cache-control'), text, json: JSON.parse(text) as unknown };
};
const parsed = async (session: number, query = '') => {
  const res = await std(session, query);
  expect(res.status).toBe(200);
  return { ...res, body: Standings.parse(res.json) };
};
const setState = (session: number, state: string) =>
  admin.updateTable('session').set({ ingest_state: state }).where('session_key', '=', session).execute();

describe('standings route and /status (f1_api login, Access JWT)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    expect(await run(['migrate'], { PATH: process.env.PATH, DATABASE_URL: testDb.urls.f1_migrator }, () => {})).toBe(0);
    admin = createDb(testDb.urls.admin);
    const meeting = (meeting_key: number, year: number, name: string) => ({
      meeting_key,
      source: 'openf1',
      year,
      name,
    });
    await admin
      .insertInto('meeting')
      .values([
        meeting(1, 2025, 'Alpha Grand Prix'),
        meeting(2, 2025, 'Beta Grand Prix'),
        meeting(3, 2025, 'Gamma Grand Prix'),
        meeting(4, 2022, 'Old Grand Prix'),
        meeting(5, 2024, 'Delta Grand Prix'),
        meeting(6, 2024, 'Epsilon Grand Prix'),
      ])
      .execute();
    const session = (session_key: number, meeting_key: number, type: string, name: string, day: string) => ({
      session_key,
      meeting_key,
      source: 'openf1',
      type,
      name,
      date_start: new Date(`${day}T13:00:00Z`),
      date_end: new Date(`${day}T15:00:00Z`),
      ingest_state: 'final',
    });
    await admin
      .insertInto('session')
      .values([
        session(QUALI, 1, 'Qualifying', 'Qualifying', '2025-03-15'),
        session(R1, 1, 'Race', 'Race', '2025-03-16'),
        session(SPRINT, 2, 'Race', 'Sprint', '2025-04-05'),
        session(R3, 2, 'Race', 'Race', '2025-04-06'),
        session(R4, 3, 'Race', 'Race', '2025-05-04'),
        session(R5, 3, 'Race', 'Race', '2025-05-18'),
        session(OLD, 4, 'Race', 'Race', '2022-03-20'),
        session(R300, 5, 'Race', 'Race', '2024-03-10'),
        session(R301, 6, 'Race', 'Race', '2024-03-24'),
      ])
      .execute();
    // Two people in every session of the seasons, Ann in the Red car and Bob in the Blue one.
    const all = [QUALI, R1, SPRINT, R3, R4, R5, OLD, R300, R301];
    await admin
      .insertInto('driver')
      .values(
        all.flatMap((session_key) => [
          {
            session_key,
            source: 'openf1',
            driver_number: 1,
            full_name: ANN,
            acronym: 'ANN',
            team_name: 'Red',
            team_colour: 'E10600',
          },
          {
            session_key,
            source: 'openf1',
            driver_number: 2,
            full_name: BOB,
            acronym: 'BOB',
            team_name: 'Blue',
            team_colour: '0000EE',
          },
        ]),
      )
      .execute();
    // Points per session as (Ann, Bob): R1 25/18, the sprint 7/8 (Bob won it), R3 25/18.
    const result = (session_key: number, ann: [number, number], bob: [number, number]) => [
      { session_key, source: 'openf1', driver_number: 1, position: ann[0], points: ann[1] },
      { session_key, source: 'openf1', driver_number: 2, position: bob[0], points: bob[1] },
    ];
    await admin
      .insertInto('result')
      .values([
        ...result(QUALI, [1, 0], [2, 0]),
        ...result(R1, [1, 25], [2, 18]),
        ...result(SPRINT, [2, 7], [1, 8]),
        ...result(R3, [1, 25], [2, 18]),
        ...result(R300, [1, 25], [2, 18]),
        ...result(R301, [1, 25], [2, 18]),
      ])
      .execute();
    // points_start per session (Ann, Bob). 2025: R2's Ann start is 1 more than R1's points give, R4's Bob start 1 more
    // than R3's (the two mismatches); the rest agree. points_current is bogus everywhere: it must never show.
    const standing = (session_key: number, ann: number, bob: number) => [
      { session_key, source: 'openf1', driver_number: 1, points_start: ann, points_current: 999 },
      { session_key, source: 'openf1', driver_number: 2, points_start: bob, points_current: 999 },
    ];
    const teams = (session_key: number, red: number, blue: number) => [
      { session_key, source: 'openf1', team_name: 'Red', points_start: red, points_current: 999 },
      { session_key, source: 'openf1', team_name: 'Blue', points_start: blue, points_current: 999 },
    ];
    await admin
      .insertInto('championship_driver')
      .values([
        ...standing(R1, 0, 0),
        ...standing(SPRINT, 26, 18),
        ...standing(R3, 33, 26),
        ...standing(R4, 58, 45),
        ...standing(R300, 0, 0),
        ...standing(R301, 24, 17), // 24/17 against 25/18 in R300's result: 2 rows
      ])
      .execute();
    await admin
      .insertInto('championship_team')
      .values([...teams(R1, 0, 0), ...teams(SPRINT, 26, 18), ...teams(R3, 33, 26), ...teams(R4, 58, 45)])
      .execute();
    apiDb = createDb(testDb.urls.f1_api);
    app = createApp({
      db: apiDb,
      access: access({ team: TEAM, aud: AUD }, log),
      log,
      liveDir: '/nonexistent',
      revision: SHA,
    });
    key = await rsaKey('test-kid');
    token = await jwt(key.priv);
  });
  beforeEach(() => {
    serveCerts([key.pub]);
  });
  afterAll(async () => {
    await apiDb?.destroy();
    await admin?.destroy();
    await testDb?.drop();
  });

  it('answers the standing after a race from the next session, strict-contract valid, with this session, the place change and the rounds', async () => {
    const { body } = await parsed(R3);
    expect(body.provisional).toBe(false);
    // R4's points_start, never points_current (999) and never the sum (33 + 25 = 58 would agree, 26 + 18 = 44 would not).
    expect(body.drivers.map((d) => [d.position, d.full_name, d.points, d.session_points, d.change])).toEqual([
      [1, ANN, 58, 25, 0],
      [2, BOB, 45, 19, 0],
    ]);
    expect(body.drivers[0]).toMatchObject({ acronym: 'ANN', team_names: ['Red'], team_colour: 'E10600' });
    expect(body.teams.map((t) => [t.position, t.team_name, t.points, t.session_points])).toEqual([
      [1, 'Red', 58, 25],
      [2, 'Blue', 45, 19],
    ]);
    // The rounds: every counted session up to S (the sprint included), none after it.
    expect(body.rounds.map((r) => [r.session_key, r.session_name, r.meeting_name])).toEqual([
      [R1, 'Race', 'Alpha Grand Prix'],
      [SPRINT, 'Sprint', 'Beta Grand Prix'],
      [R3, 'Race', 'Beta Grand Prix'],
    ]);
    expect(body.rounds[1]?.drivers).toEqual([
      { full_name: ANN, points: 33 },
      { full_name: BOB, points: 26 },
    ]);
  });

  it('a sprint is a counted session of its own', async () => {
    const { body } = await parsed(SPRINT);
    expect(body.rounds.map((r) => r.session_key)).toEqual([R1, SPRINT]);
    expect(body.drivers.map((d) => [d.full_name, d.points])).toEqual([
      [ANN, 33],
      [BOB, 26],
    ]);
  });

  it('400 on a bad key, a bad or repeated v; 404 on an unknown key, both with the fixed bodies and no-store', async () => {
    for (const path of ['abc', '1234567890', '1e3', '-1']) {
      const res = await get(`/api/v1/sessions/${path}/standings`);
      expect([res.status, await res.json(), res.headers.get('cache-control')]).toEqual([
        400,
        { error: 'bad request' },
        NO_STORE,
      ]);
    }
    for (const query of ['?v=nonsense', `?v=${SHA}&v=${SHA}`]) expect((await std(R3, query)).status).toBe(400);
    const res = await get('/api/v1/sessions/999999/standings');
    expect([res.status, await res.json(), res.headers.get('cache-control')]).toEqual([
      404,
      { error: 'not found' },
      NO_STORE,
    ]);
  });

  it('a qualifying and a pre-2023 race answer empty arrays, not provisional, with their own session cache rule', async () => {
    for (const session of [QUALI, OLD]) {
      const res = await std(session);
      expect(res.status).toBe(200);
      expect(Standings.parse(res.json)).toEqual({ drivers: [], teams: [], rounds: [], provisional: false });
      expect(res.cache).toBe(FINAL);
    }
    await setState(QUALI, 'fetched');
    expect((await std(QUALI)).cache).toBe(NO_STORE);
    await setState(QUALI, 'final');
  });

  it('a cancelled race is no counted session either', async () => {
    await admin.updateTable('session').set({ is_cancelled: true }).where('session_key', '=', R3).execute();
    expect((await parsed(R3)).body).toEqual({ drivers: [], teams: [], rounds: [], provisional: false });
    await admin.updateTable('session').set({ is_cancelled: false }).where('session_key', '=', R3).execute();
  });

  it('the cache rule: private max-age only when every counted session up to S is final, the standing is no fallback and v allows it', async () => {
    expect((await parsed(R3)).cache).toBe(FINAL); // v absent
    expect((await parsed(R3, `?v=${SHA}`)).cache).toBe(FINAL); // v equal to the api's revision
    expect((await parsed(R3, `?v=${OTHER}`)).cache).toBe(NO_STORE); // another revision
    expect((await parsed(R3, '?v=dev')).cache).toBe(NO_STORE);
    // R4's standing has no next session's rows (R5 has none): provisional, whatever the states.
    const provisional = await parsed(R4);
    expect(provisional.body.provisional).toBe(true);
    expect(provisional.cache).toBe(NO_STORE);
    // One counted session up to S that is not final.
    await setState(SPRINT, 'fetched');
    expect((await parsed(R3)).cache).toBe(NO_STORE);
    expect((await parsed(R1)).cache).toBe(FINAL); // S itself and the ones before it are final
    await setState(SPRINT, 'final');
    // S itself not final.
    await setState(R3, 'fetched');
    expect((await parsed(R3)).cache).toBe(NO_STORE);
    await setState(R3, 'final');
    expect((await parsed(R3)).cache).toBe(FINAL);
  });

  it("a standing without the next session's rows is the previous standing plus its own points, and provisional", async () => {
    const { body } = await parsed(R4);
    expect(body.drivers.map((d) => [d.full_name, d.points])).toEqual([
      [ANN, 58],
      [BOB, 45],
    ]); // R4 has no result rows yet: R3's standing (R4's points_start) plus nothing
    expect(body.provisional).toBe(true);
  });

  it('/status standings_mismatch lists the sessions whose next points_start differs from their own points, newest first', async () => {
    const res = await get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const status = Status.parse(await res.json());
    // 2025 first (R3: Bob's 45 − 26 = 19 against 18; R1: Ann's 26 − 0 = 26 against 25), then 2024's two rows. The sprint
    // agrees (33 − 26 = 7 and 26 − 18 = 8), R4 and R5 have no next rows, the qualifying and 2022 are no counted session.
    expect(status.standings_mismatch).toEqual([
      { session_key: R3, year: 2025, meeting_name: 'Beta Grand Prix', session_name: 'Race', rows: 1 },
      { session_key: R1, year: 2025, meeting_name: 'Alpha Grand Prix', session_name: 'Race', rows: 1 },
      { session_key: R300, year: 2024, meeting_name: 'Delta Grand Prix', session_name: 'Race', rows: 2 },
    ]);
  });

  it('never counts a session after S: rows added after S and after its next session leave the answer byte-identical', async () => {
    const before = await std(R3);
    const beforeSprint = await std(SPRINT);
    // After S: R4's results and points_current, a later team for the same cars, and everything of R5 (after N).
    await admin
      .insertInto('result')
      .values([
        { session_key: R4, source: 'openf1', driver_number: 1, position: 1, points: 25 },
        { session_key: R4, source: 'openf1', driver_number: 2, position: 2, points: 18 },
        { session_key: R5, source: 'openf1', driver_number: 1, position: 2, points: 18 },
        { session_key: R5, source: 'openf1', driver_number: 2, position: 1, points: 25 },
      ])
      .execute();
    await admin
      .insertInto('championship_driver')
      .values([
        { session_key: R5, source: 'openf1', driver_number: 1, points_start: 1000, points_current: 2000 },
        { session_key: R5, source: 'openf1', driver_number: 2, points_start: 1000, points_current: 2000 },
      ])
      .execute();
    await admin
      .insertInto('championship_team')
      .values([{ session_key: R5, source: 'openf1', team_name: 'Red', points_start: 1000, points_current: 2000 }])
      .execute();
    await admin.updateTable('championship_driver').set({ points_current: 5000 }).execute();
    await admin.updateTable('championship_team').set({ points_current: 5000 }).execute();
    await admin
      .updateTable('driver')
      .set({ team_name: 'Green', team_colour: '00FF00', acronym: 'ZZZ' })
      .where('session_key', 'in', [R4, R5])
      .execute();
    const after = await std(R3);
    expect(after.text).toBe(before.text);
    expect(after.cache).toBe(before.cache);
    // The sprint's next session is R3 and nothing after R3 shows either.
    expect((await std(SPRINT)).text).toBe(beforeSprint.text);
    // What N's points_start legitimately gives: R3's standing follows R4's row.
    await admin
      .updateTable('championship_driver')
      .set({ points_start: 60 })
      .where('session_key', '=', R4)
      .where('driver_number', '=', 1)
      .execute();
    const changed = Standings.parse((await std(R3)).json);
    expect(changed.drivers[0]).toMatchObject({ full_name: ANN, points: 60 });
    await admin
      .updateTable('championship_driver')
      .set({ points_start: 58 })
      .where('session_key', '=', R4)
      .where('driver_number', '=', 1)
      .execute();
    // With R5's rows in, R4's standing is no fallback any more (R5's points_start) and is not provisional.
    const r4 = await parsed(R4);
    expect(r4.body.provisional).toBe(false);
    expect(r4.cache).toBe(FINAL);
  });
});
