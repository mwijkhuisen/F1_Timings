# Architecture: F1 Timings

Status: approved by the owner (2026-10-25). Cited as A§x. Decisions are recorded in `docs/adr/`; this file is the overview. Facts marked **[U]** are unverified and are checked by the first phase that depends on them.

## 1. Product

- **What:** a personal website showing lap times, sector times, mini-sectors, speed traps and tyre stints for F1 sessions (FP1–3, sprint qualifying, sprint, qualifying, race). Phase 2 adds **live timing and replay**: you watch the video in the F1 TV app and follow the timing on this site, with an adjustable delay.
- **Who:** the owner only. The whole site is behind Cloudflare Access for one email address. Nothing is public.
- **Seasons:** 2023 to now in v1 (OpenF1). 2018–2022 in phase 3 (official F1 archive with the owner's F1 TV Pro). No source has sector times before 2018.
- **Non-goals:** video (F1 TV streams are DRM-protected and the ToS forbids re-serving them), telemetry traces, a car-position track map, championship standings, other users or accounts, public access, a native app, Dutch UI.

## 2. Principles

1. **Small and boring.** One user, one VM. Reuse Waterheight's stack and patterns, and drop the ops machinery that exists for a public site under load (ADR-0002).
2. **Isolated from Waterheight.** A separate compose project, database, tunnel, networks, firewall table, secrets and GIDs. Nothing in the F1 stack can break Waterheight (ADR-0003).
3. **Store raw, derive later.** Every fetched OpenF1 response and every live message is kept raw, so a parser fix can re-derive without fetching again.
4. **Honest gaps.** Missing values render as `—` with a reason in the tooltip. Nothing is invented or interpolated.
5. **One parser, one playback path.** The live feed and the F1 archive share the same SignalR topic format and one TS parser (ADR-0006). Live and replay are both "state at session time T" (ADR-0007).
6. **Never call F1 or OpenF1 from CI.** Tests use recorded fixtures. GitHub's runners are blocked by F1 anyway (FastF1 #988).

## 3. Tech stack

Same versions as Waterheight at P0 time. Re-check each pin against the 7-day release-age rule when installing.

| Area | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript 6.0.3 strict, Node 26.10.0 | TS 7 forbidden. Erasable syntax only (no enums or namespaces). `.ts` imports with extension. |
| Package manager | pnpm 12.5.1 workspace | `minimumReleaseAge: 10080`, `strictDepBuilds`, `blockExoticSubdeps`, `--frozen-lockfile` |
| Lint/format | Biome 2.5.15 | `"preset": "recommended"` (not `"none"`; see the Waterheight gotcha) |
| Tests | Vitest 5.0.4 (`unit` + `integration` projects), msw 3.0.3, fast-check 4.10.2 | Integration tests run on real PostgreSQL 18, not testcontainers |
| Server | Hono 4.13.13 + @hono/node-server 2.1.5, undici 8.12.2, pino 10.4.0, croner 10.0.1, zod 4.6.7 | One image with roles (A§4) |
| Database | PostgreSQL 18.6 (own container), Kysely 0.29.6 + pg 8.23.1, kysely-codegen 0.20.0, dbmate 2.36.0 | Immutable migrations |
| Web | React 19.3.0, Vite 8.3.4, TanStack Query 5.104.2, ECharts 6.1.0 (lazy chunk), temporal-polyfill 1.0.6 | English only, no i18n library |
| Live feed (P2) | SignalR Core client: `@microsoft/signalr` or a ~150-line native client on undici's WebSocket | P2a decides, with an ADR-lite line either way |
| Edge | Caddy 2.11.7, cloudflared 2026.10.x, Cloudflare Access (free plan) | Own tunnel |
| Images | Build: `node:26.11.1-trixie-slim`. Runtime: `gcr.io/distroless/nodejs26-debian13:nonroot`. All pinned by digest | |

### Reused from Waterheight / dropped

| Waterheight piece | Here | Why |
|---|---|---|
| TS-only, pnpm policy, Biome, Vitest unit+integration, msw, fast-check | **reuse** | Same toolchain, same agents, same gotchas |
| Hono API, Kysely + pg, dbmate, croner with own busy guard, pino, heartbeat healthcheck | **reuse** | Proven patterns |
| `packages/contracts` (zod, shared server↔web) | **reuse** | The web parses every API answer |
| `packages/core` | drop | Nothing to share beyond contracts |
| Adapter fixture standard (`.raw` / `.meta.json` / `.golden.json`) | **reuse, lighter** | ≥ 1 normal + 1 edge + 1 empty per endpoint. No coverage gate per file, one property test per parser |
| Hardened compose anchor, file secrets, fixed bridge names + own nftables table, tick timer | **reuse** | Same host, same safety |
| Strict CSP, no third-party browser requests, lazy ECharts | **reuse** | Cheap, and it removes a whole class of bugs |
| Signed pull-based releases (cosign, promote gate, manifest) | drop | One user, private site. GHCR digests + a pull timer are enough (ADR-0002). Revisit if anyone else commits |
| Static-first publisher (ADR-0005), brownout, k6 load tests, chaos, benches | drop | No traffic spikes; one reader |
| Owner-audience machinery (ADR-0017), WireGuard owner site | drop | The whole site is owner-only behind Access |
| Paraglide i18n | drop | English only |
| MapLibre/PMTiles/basemap | drop | No map |
| restic backups, restore drill (ADR-0011) | drop | All DB data can be re-fetched. Accepted risk: raw live recordings |
| Watchdog role, public status page | drop | A status panel in the UI plus 2 healthchecks.io checks |
| BOM table + `check-bom.ts`, `check-boundaries`, OpenAPI generators, CodeQL, 3-browser Playwright matrix, Lighthouse | drop | Exact pins + Dependabot cooldown cover the supply-chain part; the rest guards a public product |
| dbmate built from source in the image | lighter | Official static release binary, sha256-pinned in the Dockerfile |
| `harden-runner` in every CI job | drop | In audit mode it blocks nothing, and it is one less third-party action with access to every job (owner, 2026-10-25) |
| Separate `dbmate` CI job with a round-trip script | lighter | The `integration` test creates a database and runs the real `migrate` role up → down → up (owner, 2026-10-25) |

## 4. Components

One server image (`ghcr.io/mwijkhuisen/f1-server`) whose first argument picks the role, and one web image (`f1-web`: Caddy plus the built SPA).

| Role | Kind | Does |
|---|---|---|
| `api` | daemon | Hono: REST `/api/v1/*` and SSE playback streams. Verifies the Cloudflare Access JWT on `/api` |
| `ingest` | daemon | croner scheduler: OpenF1 schedule sync, per-session fetch pipeline, first backfill (A§8) |
| `live` (P2) | daemon | Logs in to F1 TV, connects to the SignalR feed around each scheduled session, appends raw messages to disk and writes snapshots (A§11) |
| `migrate` | job | dbmate up as the `f1_migrator` role |
| `healthcheck` | probe | Exits 0 if `/tmp/f1-heartbeat` is under 120 s old |
| `refetch <session_key>` / `backfill` | job | Manual tools for OpenF1 corrections |
| `archive` (P3) | job | Imports 2018–2022 sessions from the F1 archive through the P2 parser |

```
Cloudflare Access ─► cloudflared ─► caddy (SPA + reverse proxy /api) ─► api ──┐
                                                                            ├─► postgres
OpenF1 (HTTPS) ◄─ ingest ───────────────────────────────────────────────────┤
F1 live feed / archive (HTTPS, WSS, F1 TV token) ◄─ live / archive ─────────┘
                                         └─► /srv/f1/live/<recording>/ (raw + snapshots, read by api)
```

## 5. Repository layout

```
apps/server/src/{main.ts, api/, ingest/, openf1/, live/, timing/, db/}
apps/server/test/
apps/web/{index.html, src/, vite.config.ts}
packages/contracts/src/        # zod schemas for every API answer
db/migrations/                 # dbmate, YYYYMMDDHHMMSS_name.sql, never edited once applied
deploy/{compose.yaml, server/Dockerfile, web/Dockerfile, web/Caddyfile, host/, bin/, systemd/}
docs/{plan/, adr/, runbooks/}
scripts/                       # record-fixture.ts (refuses under CI), smoke tools
```

## 6. Data sources and data map

Checked against the live APIs on 2026-10-25 (Austin quali `11392`, Marina Bay race `11388`, Marina Bay sprint `11383`, Bahrain 2023 race `7953`).

### 6.1 OpenF1 (`https://api.openf1.org/v1`), v1 source

- Free, no auth, 2023+. Paid only within "live", which runs from 30 min before a session starts until 30 min after it ends. Free limit: 3 req/s and 30 req/min. `meetings`/`sessions` refresh daily at 00:00 UTC.
- Sessions per year: 2023: 118, 2024: 123, 2025: 123, 2026: 131 (including testing days and future sessions). Session names: `Practice 1–3`, `Sprint Qualifying`, `Sprint`, `Qualifying`, `Race`, `Day 1–3`.
- **Cancelled sessions stay listed** with `is_cancelled: true` (`sessions-year` fixture: 10 of the 131 sessions of 2026, those of the cancelled Bahrain `1282` and Saudi Arabia `1283` meetings, 10–19 April). Their data endpoints answer "No results found.". P1b stores the flag on `meeting` and `session` and never fetches a cancelled session, so it stays `scheduled` without `next_fetch_at` and P1c can tell "cancelled" from "no data".
- Known issues (open on `br-g/openf1`): null pit `stop_duration` (#484), sessions needing re-ingest (#483), wrong `tyre_age_at_start` for used sets (#473), slowness right after a session becomes free (#474).
- **During a live session every free request fails, past sessions included** (P1a, 2026-10-25 20:03 UTC, Austin race): HTTP 401 `{"detail":"Live F1 session in progress. Global API access (including past sessions) is restricted to authenticated users until the session ends. …"}`, with a link to buy a paid API key (the plan uses none). It lifted between 22:26:45 and 22:31:46 UTC, at the end of the live window (scheduled end 22:00 + 30 min), not at the chequered flag. The client reports it as `http 401` without retrying. P1b: nothing calls OpenF1 while a session in `session` is inside its window (`date_start − 30 min` … `date_end + 30 min`; a cancelled session or a row longer than 12 h opens none). The tick waits it out, the daemon's sync retries 15 min later, the backfill stops (exit 1) and a `refetch` fails with exit 1 and writes nothing (A§8). The very first sync has no schedule to check yet: a 401 there fails with `http_401` and is retried the same way.
- **A query without rows answers 404 `{"detail":"No results found."}`**, not `[]` (P1a). The client turns exactly that answer into an empty list; any other 404 is an error. Bahrain 2023 race `7953` has no `pit` rows at all.
- **Nulls** (P1a scan, 2026-10-25: the full responses of 11388, 11392, 11383 and 7953, plus `meetings`/`sessions` 2023–2026; the zod schemas in `apps/server/src/openf1/schemas.ts` follow it):
  - `laps` (2,898 rows): `date_start` 2, `lap_duration` 42, S1 102, S2 11, S3 20, `i1_speed` 618, `i2_speed` 11, `st_speed` 502, each `segments_sector_n` array 6–8, and single `null` elements inside the arrays.
  - `pit` (169): `pit_duration` and `lane_duration` 22, `stop_duration` all 169.
  - `race_control` (428): `driver_number` 336, `flag` and `scope` 191, `sector` 298, `lap_number` 39, `qualifying_phase` 408.
  - `session_result` (86): `position` 14, `duration` 30, `gap_to_leader` 16 (a number, a string such as `+1 LAP`, or Q1–Q3 in qualifying). `points` is missing from qualifying results.
  - Never null in the scan: `meetings`, `sessions`, `stints`, and the `drivers` fields A§7 stores (`country_code`, not stored, is null in 66 of 86).

| View | Endpoints → fields | Known gaps → UI |
|---|---|---|
| Session header | `meetings` (name, circuit, `gmt_offset`), `sessions` (type, name, start/end), `session_result` (position, laps, dnf/dns/dsq, `duration` (an array of Q1/Q2/Q3 in qualifying), `gap_to_leader`) | — |
| Lap table | `laps`: `lap_number`, `lap_duration`, `duration_sector_1..3`, `is_pit_out_lap`, `date_start` (approximate). `drivers`: `name_acronym`, `team_name`, `team_colour`. In-lap = the lap before an out-lap (A§9); `pit.lap_number` is the in-lap only in races and sprints. `race_control` → deleted laps (A§9) | Null `lap_duration` or sectors on out-laps and some flying laps (11392: 84 of 280 S1 null, 25 laps without a time) → `—` with "not timed" |
| Comparison | Same as the lap table | Gaps break the line, never interpolated |
| Mini-sectors | `laps.segments_sector_1..3` codes: 0 = n/a, 2048 = yellow, 2049 = green, 2051 = purple, 2064 = pit lane. 2050/2052/2068 meaning unknown → grey | OpenF1 says segments are "not available during races" and race data is mostly 2048 → race tab shows a banner: "mini-sector colours unreliable in races" |
| Speed traps | `laps.i1_speed`, `i2_speed`, `st_speed` (km/h) | `i1_speed` null on ~25% and `st_speed` on ~20% of race laps → `—` |
| Tyres/stints | `stints`: `stint_number`, `lap_start`, `lap_end`, `compound`, `tyre_age_at_start`. `pit`: `pit_duration`, `lane_duration`, `stop_duration` | Tyre age may be wrong for used sets (#473), `stop_duration` often null (#484) → caveat icon |
| Qualifying phase per lap | No field. Derive from `race_control.qualifying_phase` timestamps against `laps.date_start` **[U]** | Unknown phase → lap shown without a Q badge |

### 6.2 Official F1 archive (`livetiming.formula1.com/static`), P3 source

- Since ~15 Oct 2026 it returns 401 without a token. It needs F1 TV Access/Pro/Premium (the owner has Pro). Seasons 2018+.
- Structure: `static/<year>/Index.json` → meetings → sessions (`Path`) → `<Path><Topic>.jsonStream` (and `.json`). The topics are the same as the live feed (A§11.1), with a session-relative timestamp on each line.
- Requests carry `Authorization: Bearer <subscriptionToken>` (A§12.3). It works from home IPs; datacenter ranges such as GitHub Actions get a CloudFront 403.

### 6.3 Others

- **Jolpica-F1** (`api.jolpi.ca/ergast`): results and lap times since 1996, **no sectors**. Optional in P3 for pre-2018 lap times.
- **FastF1** (MIT, Python): not a dependency. It is the reference for the archive/feed format, lap reconstruction and the F1 TV login flow. Any ported logic keeps its MIT notice.

## 7. Data model (PostgreSQL 18)

All times are `timestamptz` in UTC, durations are integer milliseconds, and speeds are smallint km/h. Every row carries `source` (`openf1` | `f1-archive` | `f1-live`).

| Table | Key | Columns (outline) |
|---|---|---|
| `meeting` | `meeting_key` | year, name, official_name, location, country_code, circuit_short_name, gmt_offset, date_start, date_end, is_cancelled |
| `session` | `session_key` | meeting_key, type, name, date_start, date_end (both NOT NULL), is_cancelled, `ingest_state` (scheduled · due · fetched · final · failed), `next_fetch_at`, `fetch_count` (successes), `fail_count` (consecutive failures), `last_error` (a fixed code, CHECK: `http_NNN` · `rate_limited` · `timeout` · `network` · `schema` · `empty` · `db` · `unknown`; never OpenF1 or PostgreSQL text) |
| `driver` | (session_key, driver_number) | acronym, full_name, team_name, team_colour |
| `lap` | (session_key, driver_number, lap_number) | date_start, lap_ms, s1_ms, s2_ms, s3_ms, i1_kph, i2_kph, st_kph, is_pit_out, is_pit_in, seg1/seg2/seg3 `smallint[]`, deleted, deleted_reason, quali_phase |
| `stint` | (session_key, driver_number, stint_number) | lap_start, lap_end, compound, tyre_age_at_start |
| `pit` | (session_key, driver_number, lap_number) | date, pit_ms, lane_ms, stop_ms |
| `race_control` | id | session_key, date, category, flag, scope, sector, driver_number, lap_number, qualifying_phase, message |
| `result` | (session_key, driver_number) | position, laps, dnf, dns, dsq, durations_ms `int[]`, gaps_ms `int[]` (a race's single value as a 1-element array, Q1–Q3 in qualifying; a string gap such as `+1 LAP` is stored as `{NULL}`: 8 of 22 rows in `session_result-normal`) |
| `raw_response` | (session_key, endpoint) | fetched_at, http_status (OpenF1's 404 "No results found." is stored as 404 with body `[]`), body `jsonb` (latest only) |
| `recording` (P2) | id | session_key, path, started_at, ended_at, bytes, complete |

Size: 2023–2026 is about 470 sessions, under 2 GB including raw JSON **[U]** (measured after the backfill).

Built in P1b: `db/migrations/20261026000001_timing_tables.sql`. Every child table references `session` and `session` references `meeting` (`ON DELETE CASCADE`); nothing references `driver`, because OpenF1 can list a lap for a driver missing from `drivers`. `deleted`, `deleted_reason` and `quali_phase` exist but stay default/null until P1c (A§8).

Roles (owner, 2026-10-25; built in P1b): `deploy/postgres/roles.sql`, a PostgreSQL init script that runs once when the volume is created, makes the logins `f1_migrator` (owns every object), `f1_ingest` (writes) and `f1_api` (reads). Each login's password is a file secret `db_<login>`.

- It is plain SQL: a `DO` block reads each password on the server with `pg_read_file(prefix || login)`, where the prefix is the setting `f1.secret_prefix` or else `/run/secrets/db_`. In production the password never appears in SQL text or a statement log, and an error names only the login and the SQLSTATE. It is idempotent (create if missing, then `ALTER ROLE … NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`), makes `f1_migrator` the database owner, revokes every database privilege from `PUBLIC` (and `CONNECT` on `postgres` and `template1`) and grants `CONNECT` to `f1_ingest` and `f1_api`. No `CONNECTION LIMIT`: each process's pool is capped in code (2 connections).
- **One database per cluster** is a premise: roles and the `CONNECT` revokes are cluster-wide, and a database created later keeps `PUBLIC` `CONNECT`, so "no login reaches another database" holds only while `f1` is the only one (P1f can add a `pg_hba` guard).
- The `db` container must be able to read `/run/secrets/db_f1_*`: it needs the secrets' GID (`group_add`, P1f). After rotating a `db_*` secret, run `roles.sql` again by hand; it runs by itself only on a new volume.
- Grants live in `20261026000002_grants.sql`: `f1_ingest` gets `SELECT, INSERT, UPDATE` on `meeting` and `session` and also `DELETE` on the seven child tables it replaces (a `DELETE` on `meeting` or `session` would cascade through every timing table); `f1_api` gets `SELECT` on all but `raw_response`. Later phases grant their own tables (no default privileges).
- Development and tests: `apps/server/scripts/dev-db.ts` writes a random password per login on the server with `COPY … TO` (so in development the password does appear in that statement's text), sets `f1.secret_prefix`, runs `roles.sql` and empties the files again. `apps/server/test/db.ts` (`createTestDb()`) does this for each integration test file.

## 8. Ingestion (OpenF1)

- **Schedule sync:** daily at 00:30 UTC, plus at start: `meetings` and `sessions` for the current year and every year from 2023 that has no `meeting` row yet (all of them on the first run). Upserts `meeting`/`session`, metadata only. A new session is `scheduled` with `next_fetch_at = date_end + 35 min` (none when cancelled); a changed `date_end` moves `next_fetch_at` only while the session is still `scheduled`. A session whose meeting is missing from `meetings` is skipped and counted. The raw schedule responses are not stored.
  - The daemon skips the sync during a live window (A§6.1). A skipped or failed sync is tried again from the minute job at most every 15 min until it succeeds.
  - One response is one parse and one transaction: a single bad row (a missing date, a value the schema rejects) fails that year's sync, which keeps the previous schedule and shows up as `schema` or `db` in the log.
- **Per-session pipeline** (P1b, `apps/server/src/ingest/`; the rules are pure functions in `state.ts`):
  - Every minute the tick marks `scheduled`/`fetched` sessions with `next_fetch_at ≤ now` as `due`, then processes the due ones one at a time, newest `date_end` first. Cancelled sessions are never due. It waits while any session is live (A§6.1) and logs the wait when it starts and when it ends.
  - **Success at t** (after the 35 min wait, i.e. after the paid window): `fetch_count + 1`, `fail_count = 0`, `last_error = null`, then the first of `date_end + 3 h` and `date_end + 24 h` that is later than t → `fetched` with that `next_fetch_at`, or else `final`. A session older than 24 h is fetched once, so the backfill costs 6 requests per session. A success before `date_end + 35 min` (only a `refetch` gets there) leaves the session `scheduled` for its first fetch.
  - **Failure n** (consecutive): `due` again at t + min(5 min · 2^(n−1), 6 h), that is 5, 10, 20, 40, 80, 160, 320 and 360 min; the 9th → `failed` (shown in the status panel, P1c). `last_error` holds the code: HTTP 429 → `rate_limited`, any other status → `http_<status>`, `timeout`, `network`, a body that is not JSON or does not match the zod schema → `schema`, a PostgreSQL error → `db`, anything else (a bug in the normaliser) → `unknown`.
  - **One transaction:** all six endpoints (`drivers`, `laps`, `stints`, `pit`, `race_control`, `session_result`) are fetched first, and any fetch or schema error writes nothing but the failure. Then one transaction locks the session row (`FOR UPDATE`), decides the transition from that locked row, replaces the six `raw_response` rows and all the session's child rows (delete, then insert in chunks of 1,000 rows), and sets the state. Replace-per-session is idempotent and drops rows OpenF1 removed; the lock serialises a `refetch` against the daemon.
  - **Raw is stored in that same transaction, not first** (a P1b decision, against the PHASES wording "store raw → normalise"): the empty guard compares a new reply with the stored raw, so storing a transient `[]` first would replace the good raw and the next normalise would wipe good rows. The cost: a reply that fails the schema is not kept (only its `schema` code is).
  - **Empty guard:** an endpoint that answers `[]` where its stored `raw_response` had rows is a failure with code `empty`, and the stored data stays.
  - **Contract for P1c:** the timing rules (deleted laps, `quali_phase`) run inside that transaction, after the insert, so replace-per-session never wipes them.
  - The app clock is injected: no state decision uses SQL `now()`, so unit and integration tests run on a fake clock.
  - **In/out laps:** `is_pit_out` is OpenF1's `is_pit_out_lap`; `is_pit_in` is derived (A§9). Seconds become integer ms (rounded), and nulls stay null.
  - One log line per session: key, new state, rows per table, skipped rows (another session's rows, or duplicate keys: the last wins), duration and `last_error`. Never a URL, a password or a response body.
- **Rate budget:** at most 25 requests in any 60 s and 2 in any 1 s (sliding windows, shared by every call of the client), below the 30/3 limit. On a 429, honour `Retry-After` or wait 60 s. Each attempt refuses redirects, ends after 120 s in all (headers and body: `timeout`) and stops reading past 64 MiB (`schema`, not retried); a race's `laps` is about 1 MB. 6 requests per session. Free requests fail with 401 during any live session (A§6.1), so the sync, the tick, the backfill and a refetch wait for the live window to end.
- **First backfill** (`backfill` role): syncs every year from 2023, then processes every session that is neither `final` nor cancelled and ended more than 35 min ago, newest first, each once per run, with the same transitions as the tick. Exit 0 when nothing failed, else 1. A live window stops it (exit 1); run it again later. ~470 × 6 ≈ 2,800 requests ≈ **1 h 55 min** **[U]** (measured after the [box] backfill). It's resumable, because state lives in the DB. Don't run it next to a running `ingest` daemon: each process has its own rate limiter.
- **[box] backfill** (WSL, home IP, a throw-away PostgreSQL 18). The superuser login is used because the grants are proven in CI (handoff §12):

  ```
  export DATABASE_URL='postgres://postgres@127.0.0.1:5439/f1?sslmode=disable'
  dbmate create
  node apps/server/scripts/dev-db.ts
  node apps/server/src/main.ts migrate
  date -u; time node apps/server/src/main.ts backfill > backfill.log 2>&1; echo "exit $?"; date -u
  psql -h 127.0.0.1 -p 5439 -U postgres -d f1 \
    -c "SELECT pg_size_pretty(pg_database_size('f1')), pg_size_pretty(pg_total_relation_size('raw_response'))" \
    -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC" \
    -c "SELECT ingest_state, count(*) FROM session GROUP BY 1"
  ```

  Duration **[U]** and database size **[U]**: filled in from that run.
- **Manual:** `refetch <session_key>` (digits only, else exit 64; unknown key → exit 1) for OpenF1 re-ingests (as in #483). It processes the session now: a success makes the normal transition, a failure changes nothing (a `final` session stays `final`) and exits 1. During a live window it writes nothing and exits 1 (it does not wait: a manual command should not hang for hours).
- **Scheduling pattern:** in-process croner (UTC). One job runs every minute inside a busy guard: it syncs the schedule when due (at start, after `30 0 * * *` asks for it, or 15 min after a failed try), then ticks. A minute that fires while the job runs is remembered, and the job runs once more when it ends (missed ticks run once, the Waterheight pattern). SIGTERM/SIGINT stops the cron, lets the current session finish, closes the pool and exits 0.
- **Heartbeat:** the work touches it at start, after each session and at the end of each tick (a waiting one too), so it stays under the 120 s limit (A§4) while the job progresses: an idle tick every minute, a session in about 15 s, up to about 75 s behind a 429. A session stuck longer (network trouble across all five 120 s attempts) lets it go stale, and `f1-tick` restarts the container.
- **Database waits are bounded:** connect 10 s, a statement 60 s on the server and 70 s on the client, TCP keepalive on, so a half-open connection cannot hang the job and its busy guard.

## 9. Timing rules (pure TS in `apps/server/src/timing/`, unit- and property-tested)

- **Deleted laps:** parse `race_control.message`. The car is taken from the text, because `driver_number` is null in the data. Two known forms: `CAR 87 (BEA) TIME 1:40.294 DELETED - TRACK LIMITS AT TURN 2 LAP 3 20:07:17` and `CAR 11 (PER) LAP DELETED - DOUBLE YELLOW AT TURN 12 LAP 2 21:32:22`. Also handle `… REINSTATED` (format **[U]**: none in the sample). The `LAP n` in the text is the driver's lap. A deleted lap keeps its values and is excluded from all bests.
- **Colours in the historical view (final semantics):** purple = the fastest valid value of that sector or lap in the session; green = the driver's own fastest valid value; yellow = the rest. Out-laps and in-laps are never purple or green. Live (P2) uses progressive semantics: purple/green at that moment, as on the F1 tower.
- **In/out laps** (owner, 2026-10-25): out = `is_pit_out_lap`; in = lap n when the same driver's lap n+1 is an out-lap. A last lap that ends in the pits (a retirement, a qualifying in-lap after the flag) has no out-lap after it and is not marked.
  - `pit.lap_number` is not used for this. The **[U]** "`pit.lap_number` = in-lap" held only in races and sprints. P1a checked every pit row against the out-laps of 7 full sessions:
    - The out-lap is `pit.lap_number + 1` in race 11388 (25 of 25 rows) and sprint 11383 (54 of 54).
    - A pit row is not always a stop. In sprint 11383, race control sent "ALL CARS THROUGH THE PIT LANE" under the safety car (laps 2–4). Each pass is a pit row (`lane_duration` ≈ 18–19 s), and the next lap is an out-lap, so the rule above still holds.
    - The out-lap is `pit.lap_number` itself in qualifying 11392 (90/90) and 11384 (103/103), sprint qualifying 11379 (74/74) and practice 11378 (76/76) and 11391 (92/92). Lap-1 rows with null durations there are garage exits.
  - The test `[U] pit.lap_number against the out-laps` in `apps/server/test/openf1-schemas.test.ts` pins both meanings on the fixtures.
- **Sector deltas (comparison):** per lap, `driverB − driverA` per sector. Shown only when both values exist and neither lap is deleted.

## 10. API surface (`/api/v1`, JSON, zod contracts in `packages/contracts`)

| Route | Returns |
|---|---|
| `GET /seasons` | years with counts |
| `GET /seasons/:year` | meetings with their sessions and `ingest_state` |
| `GET /sessions/:key` | session, meeting, drivers, results |
| `GET /sessions/:key/laps` | all laps with colours, deleted flags and stint compound, computed server-side (a race is ~1,240 rows, ~20 KB gzipped) |
| `GET /sessions/:key/stints` · `/pits` · `/race-control` | as named |
| `GET /status` | ingest progress, failed sessions, F1 TV token expiry, recorder state |
| `GET /live` (P2) | current or next session and its recording id |
| `GET /playback/:recording/stream?at=<ms>\|live&delay=<s>&speed=1` (P2) | SSE: one `snapshot` event, then `delta` events (A§11.3) |

- `Cache-Control: private, max-age=86400` for `final` sessions and `no-store` otherwise. TanStack Query caches on the client.
- An Access JWT middleware (`hono/jwk` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) checks `aud` and `iss` on every `/api` request (ADR-0004). `/healthz` is the only route without the JWT check. The local update smoke test uses it, and through the tunnel it still sits behind Access.

## 11. Live and replay (phase 2)

### 11.1 Feed

- SignalR Core at `wss://livetiming.formula1.com/signalrcore` (negotiate at `/signalrcore/negotiate`, preceded by an OPTIONS request for the `AWSALBCORS` cookie), hub `Streaming`, `Subscribe([topics])`, messages arrive on the `feed` method. The token goes in through the access-token factory. (Source: FastF1 3.9.0 `livetiming/client.py`.)
- Topics: `Heartbeat, DriverList, ExtrapolatedClock, RaceControlMessages, SessionInfo, SessionStatus, SessionData, TimingAppData, TimingStats, TimingData, TrackStatus, WeatherData, TopThree, LapCount, TeamRadio, RcmSeries, AudioStreams, ContentStreams, CarData.z, Position.z`. Record all of them; parse only those the views need (CarData/Position are recorded for later, not parsed).
- Since the 2025 Dutch GP some topics need an F1 TV token, and the October 2026 change may have added more **[U]**. The P2a spike lists what arrives with and without a token.

### 11.2 Recorder (`live` role)

- Starts 60 min before each scheduled session start (FastF1: "recording may need to start up to one hour before") and stops 30 min after the end or at `SessionStatus: Ends` + 30 min.
- Appends `[receivedAtMs, topic, payload]` lines to `/srv/f1/live/<session_key>-<startedAt>/feed.jsonl` (gzip rotated hourly). Writes a full-state snapshot every 30 s to `snapshots/<ms>.json.gz`.
- Reconnects with backoff. On every (re)connect it subscribes again, which gives a full state. FastF1 notes disconnects after ~2 h, so the plan is to reconnect without losing messages and to let the merge logic tolerate duplicates.
- Token: makes sure the token is valid for the session length + 1 h before connecting, and logs in again if not (A§12.3).

### 11.3 Parser and playback

- **One parser** (`apps/server/src/live/`) merges topic deltas into a typed state. F1 deltas are partial objects; arrays arrive as index-keyed objects (`"Lines": {"1": {...}}`). The same code reads archive `.jsonStream` files in P3 (ADR-0006).
- **Lap reconstruction** from `TimingData`/`TimingAppData` (lap times, sectors, segments, pit in/out, stints) produces the same `lap` rows as OpenF1. It's the hardest part. FastF1's `api.py` is the reference.
- **Playback (ADR-0007):** the client asks for "state at session time T". The server loads the nearest snapshot ≤ T, applies deltas up to T, sends one `snapshot` SSE event, then streams `delta` events at `speed`.
  - Live: T = now − delay.
  - Moving the slider, pausing or seeking = a new SSE request.
  - Recordings stay replayable forever, in sync with the F1 TV replay.
- **Delay slider:** 0–120 s in 1 s steps (plus ±5 s / ±30 s buttons), remembered per device in `localStorage`. Default 0 (the owner sets it).

## 12. Security

### 12.1 Invariants

1. No secret in git, environment variables, image layers, logs or error messages. Secrets are files under `/etc/f1/secrets`, `root:<gid> 0440`, and only the consuming container has that GID.
2. Nothing is reachable without Cloudflare Access. The origin publishes only `127.0.0.1:8180` for the update smoke test, and `/api` checks the Access JWT itself.
3. Data from the F1 TV feed or the archive is never committed. Public fixtures for those parsers are synthetic, and real recordings stay in the gitignored `fixtures-private/` folder and on the VM.
4. CI never calls OpenF1, F1 or Jolpica.
5. The F1 stack shares nothing with Waterheight: networks, volumes, secrets, GIDs, ports, subnets, the nftables table, timers and the healthchecks group are all separate. Nothing touches `/etc/rws`, `/srv/rws` or the `rws` project.
6. Strict CSP as in Waterheight: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; …`. The browser makes no third-party requests (no driver headshots from formula1.com).
7. Containers are hardened: `read_only`, `cap_drop: ALL`, `no-new-privileges`, non-root UID in its own range, memory/CPU/PID limits.

### 12.2 Cloudflare

- Its own tunnel, with its own `cloudflared` reaching only `caddy:80` (ADR-0004).
- An Access application on `<F1 hostname>`: an allow policy for the owner's email only, a session of 24 h–7 days, and email one-time PIN login.

### 12.3 F1 TV credentials and token (ADR-0005)

- `f1tv_username` and `f1tv_password` are file secrets. The account has no 2FA, so automatic login works.
- The login is a TS port of FastF1's OAuth2 Authorization Code + PKCE flow against `id.formula1.com` (PingOne DaVinci, `response_mode=pi.flow`, all JSON calls). The access token's `subscriptionToken` claim is the Bearer token. It expires in ~4 days and has no refresh token.
- The token is cached at `/srv/f1/state/f1tv-token` (0600, live UID). The token itself is never logged; only its expiry is.
- Fallback if the login breaks (bot protection, a flow change): the owner pastes the `login-session` cookie value from formula1.com into the token file (as undercut-f1 does). The status panel warns 24 h before expiry and when a login fails.

### 12.4 Agents and CI (P0 security review, 2026-10-25)

- **Trust anchors:** the lockfile, the hand-maintained sha256 pins of the CI binaries (Dependabot does not bump them), and the required checks, which the PR itself defines. A diff under `.github/`, `scripts/`, `pnpm-workspace.yaml` or `.claude/` gets a line-by-line owner read.
- **`main`:** branch protection requires `ci` and `security`, enforced for admins, with no force-push or deletion, and a pull request before merging (0 approvals). Merge commits only.
- **Agent identity:** agents use the owner's admin OAuth token until P1f, when they move to their own fine-grained token without the Administration permission (A8). Until then "agents never merge" rests on the deny rules in `.claude/settings.json` and on the branch protection.
- **Secrets:** `db_f1_migrator` is the first one. It lives in the `migrate` process and in the dbmate child's environment (readable through `/proc/<pid>/environ` by the same UID in the one-shot container). `DATABASE_URL` overrides it in dev and test; P1f checks that Compose never sets it.
- **CI egress (CI only):** GitHub release assets, registry.npmjs.org, Docker Hub, nodejs.org (setup-node), api.github.com (zizmor). Production gains no host.
- **Accepted risks (owner, 2026-10-25):**
  - The `git diff *`, `git log *` and `git show *` allow rules stay, although `--output=<path>` lets them write a file without a prompt.
  - `npm`, `yarn` and `bunx`, `git push --prune` and `git -c … push` are not denied.
  - GitHub does not itself enforce SHA-pinned or allow-listed actions; `scripts/check-workflows.sh` and zizmor do, in files a PR can change.

## 13. Frontend

- **Routes** (no router library; `routeOf(location.pathname)` plus `history.pushState`, as in Waterheight): `/` (latest session) · `/:year` · `/:year/:meeting/:session/{laps|compare|minisectors|stints}` · `/live` · `/replay/:recording`.
- **Views:**
  - **Lap table:** drivers as rows or columns (toggle), sticky driver column, S1/S2/S3/lap with purple/green/yellow, struck-through deleted laps with the reason in a tooltip, PIT IN/OUT badges, compound dot.
  - **Comparison:** pick 2+ drivers → ECharts lap-time lines plus a sector-delta table.
  - **Mini-sectors + speed traps:** a grid of coloured cells per lap, with the speed trap columns.
  - **Stints:** horizontal compound bars per driver.
  - **Live/replay** (P2): a timing tower (position, gap, interval, last/best lap, live sectors and mini-sectors, tyre, pits), the delay slider, play/pause/seek, and session-clock markers (start, red flags, chequered flag).
- **Look:** dark F1 timing-screen style by default, plus a light theme following `prefers-color-scheme`. Team colours come from `drivers.team_colour`. Purple/green/yellow are chosen to pass contrast checks on both themes.
- **Mobile:** must work on a phone. Tables scroll horizontally inside their container (never the page), tap targets are ≥ 44 px, and charts are full width.
- **Times:** shown in Europe/Amsterdam (`Temporal`, with the polyfill where the browser lacks it).

## 14. Deployment

### 14.1 Host

- The Waterheight Hyper-V VM (Debian 13 amd64) goes from 4 vCPU / 8 GB to **6 vCPU / 12 GB** (owner action). Disk: 1 TB, 960 GB free.
- Under a separate compose project `f1`. Paths: `/etc/f1/{f1.env, secrets/}`, `/srv/f1/{state, live}`, a named volume `f1_pgdata`.

### 14.2 Services (limits **[U]**, tuned after the backfill and the first live weekend)

| Service | Image | mem / cpus | Networks |
|---|---|---|---|
| `db` | postgres:18.6-trixie | 1g / 1.0 (`shared_buffers=256MB`, `max_connections=20`) | `f1-db` (internal) |
| `api` | f1-server `api` | 384m / 1.0 | `f1-edge` (internal), `f1-db` |
| `ingest` | f1-server `ingest` | 256m / 0.5 | `f1-egress`, `f1-db` |
| `live` (P2) | f1-server `live` | 384m / 1.0 | `f1-egress`, `f1-db` |
| `caddy` | f1-web | 128m / 0.5 | `f1-edge`, `f1-tunnel-edge` |
| `cloudflared` | cloudflare/cloudflared | 256m / 0.5 | `f1-tunnel`, `f1-tunnel-edge` |
| `migrate` | f1-server `migrate` (profile `jobs`) | 128m | `f1-db` |

- Total limits are ~2.7 GB. Expected steady state is ~0.9 GB.
- Bridges are named `f1-*`, with fixed subnets that must not overlap Waterheight's 172.30.0.0/16 or the LAN (P1f picks them after inspecting the host). `enable_icc: false`.
- UIDs/GIDs: containers run as 62532 (not Waterheight's 65532/65533). Secret GIDs start at 62001 (Waterheight uses 61001–61012).
- The `migrate` contract (built in P0, owner 2026-10-25): host `db:5432`, database `f1`, login `f1_migrator`, and the password from the file secret `db_f1_migrator` (`/etc/f1/secrets/db_f1_migrator` on the host, `/run/secrets/db_f1_migrator` in the container). `DATABASE_URL` is a dev/test switch that Compose never sets. The server image has dbmate on its `PATH`.

### 14.3 Firewall

- A separate `table inet f1`, loaded by `f1-firewall.service` (oneshot, `nft -c` then `nft -f`, never `flush ruleset`).
- Forward hook on `f1-*` interfaces only:
  - DNS to the host resolvers
  - tcp/443 from `f1-egress`
  - tcp+udp/7844 from `f1-tunnel` to Cloudflare's tunnel ranges
  - drop everything else, plus host-input drops for `f1-*`
- Without this table a second project's egress is unrestricted, because Waterheight's table only matches `rws-*` and `docker0`.

### 14.4 Updates

- CI on `main` builds both images, pushes `:main` and `:sha-<git>` to GHCR (public, no secrets inside), and records the digests.
- `f1-update.timer` (every 10 min) runs `deploy/bin/f1-update`:
  1. take a flock
  2. `docker pull` `:main` and stop if the digest is unchanged
  3. run `migrate`
  4. `up -d`
  5. smoke-test `http://127.0.0.1:8180/healthz`
  6. on failure, roll back to the previous digests in `/srv/f1/state/current.env`
- GitHub has no server credentials.
- Compose, Caddyfile, nftables and units change rarely. The owner applies them with `deploy/bin/f1-install` from a checkout on the VM.

### 14.5 Operations

- **`f1-tick.timer`** (10 min): restarts unhealthy `f1` containers (Docker doesn't) and records disk usage.
- **healthchecks.io:** uses the 2 free checks left on the account: `f1-ingest` (daily success) and `f1-live` (each scheduled recording completed, from P2).
- **Logs:** pino JSON to Docker's `local` driver (host daemon defaults). Fixed codes only, never URLs with tokens.

## 15. Testing

- **Unit:** parsers, timing rules, the rate limiter (fake timers), and live delta merging (a fast-check property: merging snapshot + deltas equals merging the deltas from empty).
- **Integration:** real PostgreSQL 18 as a CI service container. Each file creates its own DB, applies `roles.sql` (`apps/server/test/db.ts`) and runs dbmate up → tests; the ingest tests log in as `f1_ingest`, never as the superuser. `db-check` is P0's up → down → up test (`apps/server/test/migrate.int.test.ts`) plus `kysely-codegen --verify` against a freshly migrated database (`apps/server/test/db.int.test.ts`: the committed `types.ts` matches the migrations). A unit test pins the sha256 of every migration (`test/migrations.test.ts`).
- **Fixtures:** `apps/server/src/openf1/fixtures/` holds trimmed real OpenF1 responses (public, no auth). Live/archive parser fixtures are synthetic in the repo. Real recordings stay in `fixtures-private/` (gitignored) and are used locally only. `scripts/record-fixture.ts` refuses to run when `CI` is set.
- **Web:** component tests for the lap table colouring and deleted rendering. No browser matrix in CI.

## 16. Risks

| Risk | Mitigation |
|---|---|
| F1 changes access again (as in Oct 2026) | OpenF1 is the v1 source. Raw responses and recordings are kept. Spikes run before each build phase |
| OpenF1 gaps, slowness, re-ingests | Refetch at +3 h/+24 h, `refetch` command, honest gaps in the UI |
| F1 TV login flow changes / bot protection | Manual token-paste fallback. Expiry warnings |
| Token expires mid-session | Pre-check before connecting. Logs in again on 401 and reconnects |
| GitHub/cloud IPs blocked by F1 | All F1 traffic from the home VM. CI uses fixtures only |
| F1 TV ToS (personal use) | Single-identity Access, no public data, no commits of F1 TV-derived data |
| Resource contention with Waterheight | Strict container limits, VM resize, measurement after backfill and the first live weekend |
| Only 6 race weekends left in 2026 | Record all of them early (P2-rec), then build P2 over the winter on those recordings |
| Lap reconstruction from the feed is hard | Port FastF1's logic deliberately and compare against OpenF1 laps for the same session as a test oracle |

## 17. ADRs

| ADR | Decision |
|---|---|
| [0001](../adr/0001-openf1-primary-source.md) | OpenF1 is the v1 data source |
| [0002](../adr/0002-waterheight-stack-lighter-ops.md) | Waterheight's stack with lighter ops |
| [0003](../adr/0003-own-compose-project-and-postgres.md) | Own compose project and Postgres on the Waterheight VM |
| [0004](../adr/0004-own-tunnel-and-cloudflare-access.md) | Own Cloudflare Tunnel + Access, JWT checked at the origin |
| [0005](../adr/0005-f1tv-credentials-and-token.md) | F1 TV credentials and token handling |
| [0006](../adr/0006-one-ts-parser-for-feed-and-archive.md) | One TS parser for the live feed and the archive; no Python |
| [0007](../adr/0007-server-side-playback.md) | Live and replay as server-side playback over SSE |
