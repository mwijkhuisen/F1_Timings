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
| Web | React 19.3.0, Vite 8.3.4 + @vitejs/plugin-react 6.1.2, TanStack Query 5.104.2, ECharts 6.1.0 (lazy chunk) | English only, no i18n library. Times through `Intl.DateTimeFormat` in Europe/Amsterdam, no Temporal polyfill (owner, 2026-10-28) |
| Live feed (P2) | SignalR Core client: `@microsoft/signalr` or a ~150-line native client on undici's WebSocket | P2a decides, with an ADR-lite line either way |
| Edge | Caddy 2.11.7, cloudflared 2026.10.3, Cloudflare Access (free plan) | Own tunnel |
| Images | Build: `node:26.11.1-trixie-slim`. Runtime: `gcr.io/distroless/nodejs26-debian13:nonroot`. Web: `caddy:2.11.7-alpine`. Also `postgres:18.6-trixie`, `cloudflare/cloudflared:2026.10.3`, dbmate 2.36.0 (release binary, sha256-checked) and, in the CI nft check only, `debian:trixie-slim`. All pinned by digest | |

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
| `api` | daemon | Hono on `:8080`: REST `/api/v1/*` (P1c) and SSE playback streams (P2d). Verifies the Cloudflare Access JWT on `/api`; reads as `f1_api` |
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
  - **Deleted and reinstated laps in `race_control`** (P1c, 2026-10-27: the 454 final sessions 2023–2026 of the dev backfill). These numbers and the Q-phase check below come from a one-off, read-only run of the real `markLaps` over the dev backfill database; that script is not in the repository, so they cannot be reproduced from it. The committed fixtures and `apps/server/test/timing.test.ts` pin the rules: 3,677 DELETED messages, 3,672 in a known form (A§9), and 3,555 of those name a lap of the session: 2,983 by a unique time within 1 ms, 42 by the one exact time among several laps within 1 ms (never a different lap than `LAP n` names), 19 by `LAP n` among several, 8 by `LAP n` when no lap has the time, 503 in the LAP form. 117 name no lap: 80 carry neither a time nor `LAP n` (`… (NEXT LAP PIT)`), 29 name a car without laps in the session (support-series messages in 9223), 5 a `LAP n` OpenF1 does not have, 3 a time no lap has. 5 are in no known form (`CAR 243 TIME 0:00.000 DELETED - DOUBLE YELLOW`, `CAR LEC TIME 1:36.518 DELETED - … (Q1)`). All 26 REINSTATED messages parse and each restores the lap a DELETED message had deleted.
  - **The scan was too small** (P1b [box] backfill, 2026-10-26): about 5% of real sessions failed the P1a schemas with `schema`. Seen: a string `session_result.position` (11384), a null `stints.compound` (11246, 11342), a null `session_result.number_of_laps` (11275). Since then every field outside a row key, `meeting.year` and the session dates may be null or missing (it parses to null), a position string is kept only when it is a number ("DQ" → null; `dnf`/`dns`/`dsq` say why), and each field is bounded by its column (integers that fit smallint/int, seconds that fit int ms, text without NUL), so a value the schema accepts never fails an INSERT.
  - **Where lap values are missing** (P1d probe, 2026-10-28: the 128,497 laps of every session since 2025-01-01 in the dev backfill, a one-off read-only query, grouped by race (`session.type = 'Race'`, sprints included), lap 1, out-lap and in-lap). The rates are nulls per lap of that kind; the lap table's reasons (A§13, `missingReason` in `apps/web/src/views/LapTable.tsx`) keep only these four cases:
    - **Out-lap, S1:** null on 7,965 of 11,839 out-laps after lap 1 outside races (67 %), 65 of 1,531 in races (4 %), against 145 of 49,261 (0.3 %) and 285 of 47,424 (0.6 %) on laps that are neither out nor in. **Lap 1 out of the garage** (outside races, 3,111 laps, `is_pit_out` set) also lacks its lap time on 2,691 (86 %) and S1 on 2,704; a pit-lane start in a race lacks both on 19 of 19. Outside races, out-laps after lap 1 do not lack S2, S3 or the lap time more than other laps (lap time 75 of 11,839).
    - **In-lap:** outside races, 11,574 in-laps lack S3 on 1,663 (14 %, against 2.3 %), S2 on 571 (4.9 %, against 0.5 %), the lap time on 560 (4.8 %, against 2.1 %) and S1 on 256 (2.2 %, against 0.3 %). In races, S3 on 20 of 1,500 (1.3 %, against 0.4 %).
    - **Race lap 1 from the grid** (not an out-lap): 1,075 laps lack the lap time on 31, S1 on 41, S2 on 32, S3 on 29 (3–4 %), about ten times the other race laps (0.3–0.6 %).
    - Everything else gets "No time in the OpenF1 data".

| View | Endpoints → fields | Known gaps → UI |
|---|---|---|
| Session header | `meetings` (name, circuit, `gmt_offset`), `sessions` (type, name, start/end), `session_result` (position, laps, dnf/dns/dsq, `duration` (an array of Q1/Q2/Q3 in qualifying), `gap_to_leader`) | — |
| Lap table | `laps`: `lap_number`, `lap_duration`, `duration_sector_1..3`, `is_pit_out_lap`, `date_start` (approximate). `drivers`: `name_acronym`, `team_name`, `team_colour`. In-lap = the lap before an out-lap (A§9); `pit.lap_number` is the in-lap only in races and sprints. `race_control` → deleted laps (A§9) | Null `lap_duration` or sectors on out-laps and some flying laps (11392: 84 of 280 S1 null, 25 laps without a time; the P1d rates are listed above) → `—` with a reason behind a tap: "Out-lap", "In-lap" or "Lap 1 from the grid" followed by ": no time in the OpenF1 data", else "No time in the OpenF1 data" (A§13) |
| Comparison | Same as the lap table | Gaps break the line, never interpolated (P1e: a lap missing or without a time is a null point, A§13) |
| Mini-sectors | `laps.segments_sector_1..3` codes: 0 = n/a, 2048 = yellow, 2049 = green, 2051 = purple, 2064 = pit lane. 2050/2052/2068 meaning unknown → grey. P1e count over every lap since 2025 in the dev backfill (2026-10-28, one-off read-only query; non-race / race): 2048 1,294,827 / 955,758; 2049 376,548 / 185,557; 2064 69,476 / 8,243; 2051 35,359 / 10,621; a null element 33,272 / 40,039; 0 7,655 / 1,030; 2050 578 / 7; 2052 28 / 28; 2068 7 / 0; 2065 1 / 0 (seen once, so grey like every other unknown code). Array lengths vary within a session: in Austin quali 11392, S1 6, S2 8, S3 1–8 | OpenF1 says segments are "not available during races" and race data is mostly 2048 → race tab shows a banner: "Mini-sector colours unreliable in races". 0 and a null element → an empty "no data" box; a shorter or null array is padded with those to the session's longest (A§13) |
| Speed traps | `laps.i1_speed`, `i2_speed`, `st_speed` (km/h) | `i1_speed` null on ~25% and `st_speed` on ~20% of race laps → `—` (11392: none null) |
| Tyres/stints | `stints`: `stint_number`, `lap_start`, `lap_end`, `compound`, `tyre_age_at_start`. `pit`: `pit_duration`, `lane_duration`, `stop_duration` | Tyre age may be wrong for used sets (#473), `stop_duration` often null (#484) → caveat icon |
| Qualifying phase per lap | No field. P1c derives it (A§9): the phase of the last `race_control` row with a `qualifying_phase` dated at or before the lap's `date_start`. Checked against `session_result.duration[p]` over the 112 qualifying sessions of the dev backfill (the same one-off run): per driver and phase, the fastest valid lap (not deleted, out or in) equals the official time in 4,972 cases and differs in 7; 41 official times have no lap at all (OpenF1 has no laps for 9900). The 7 are documented exceptions, not rule errors: two last laps that end in the pits after the flag (not in-laps, A§9; 9112, 9298; owner 2026-10-27: no rule change), two deletions race control never sent as DELETED (9983: only `LAP TIME OF CAR 87 (BEA) - UNDER REVIEW`; 11271 car 23 in SQ1: only a stewards' track-limits investigation after the session), three laps missing from OpenF1 (11379). In five 2026 sessions (11230, 11271, 11276, 11282, 11287) Q1's race-control rows carry no `qualifying_phase`; the Q1 inference (A§9) recovers their 103 Q1 times | Unknown phase → lap shown without a Q badge |

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

Size (measured 2026-10-26, the [box] backfill of 2023 up to the 2026 Mexican GP): 495 sessions (455 past and processed, 25 future, 15 cancelled) take **102 MB** including raw JSON: `raw_response` 21 MB (21 %, 2,730 rows), `lap` 59 MB (258,639 rows), every other table under 6 MB.

Built in P1b: `db/migrations/20261026000001_timing_tables.sql`. Every child table references `session` and `session` references `meeting` (`ON DELETE CASCADE`); nothing references `driver`, because OpenF1 can list a lap for a driver missing from `drivers`. The ingest fills `deleted`, `deleted_reason` and `quali_phase` since P1c (A§8, A§9); a session ingested before P1c keeps the defaults until it is fetched again.

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
  - **Timing rules (P1c):** the normaliser applies them (deleted laps, `quali_phase`, A§9) to the lap rows before the insert, so the same transaction writes them with the rows and replace-per-session never wipes them. It takes the session's `type` from the `session` row.
  - The app clock is injected: no state decision uses SQL `now()`, so unit and integration tests run on a fake clock.
  - **In/out laps:** `is_pit_out` is OpenF1's `is_pit_out_lap`; `is_pit_in` is derived (A§9). Seconds become integer ms (rounded), and nulls stay null.
  - One log line per session: key, new state, rows per table, skipped rows (another session's rows, or duplicate keys: the last wins), the timing rules' message counts (`rules`: `deleted`, `reinstated`, `unmatched`, `unparsed`), duration and `last_error`; a failure adds the endpoint and, for `schema`, zod's paths and codes (at most 10). Never a value, a URL, a password or a response body.
- **Rate budget:** at most 25 requests in any 60 s and 2 in any 1 s (sliding windows, shared by every call of the client), below the 30/3 limit. On a 429, honour `Retry-After` or wait 60 s. Each attempt refuses redirects, ends after 120 s in all (headers and body: `timeout`) and stops reading past 64 MiB (`schema`, not retried); a race's `laps` is about 1 MB. 6 requests per session. Free requests fail with 401 during any live session (A§6.1), so the sync, the tick, the backfill and a refetch wait for the live window to end.
- **First backfill** (`backfill` role): syncs every year from 2023, then processes every session that is neither `final` nor cancelled and ended more than 35 min ago, newest first, each once per run, with the same transitions as the tick. Exit 0 when nothing failed, else 1. A live window stops it (exit 1); run it again later. ~470 × 6 ≈ 2,800 requests ≈ **1 h 55 min** (measured 2026-10-26: 1 h 54 min 44 s over two runs, see the [box] backfill below). It's resumable, because state lives in the DB. Don't run it next to a running `ingest` daemon: each process has its own rate limiter.
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

  Measured 2026-10-26: run 1 (8ade505, before the real-data schema fix) 1 h 45 min 41 s, 455 sessions, 36 `schema` failures, exit 1; run 2 on the merged code (6770997) 9 min 3 s, the 37 remaining sessions, 0 failures, exit 0. Together 1 h 54 min 44 s. End state: 454 `final`, 1 `fetched` (the latest race, waiting for end + 24 h), 40 `scheduled` (25 future, 15 cancelled). Database 102 MB (A§7).
- **Manual:** `refetch <session_key>` (digits only, else exit 64; unknown key → exit 1) for OpenF1 re-ingests (as in #483). It processes the session now: a success makes the normal transition, a failure changes nothing (a `final` session stays `final`) and exits 1. During a live window it writes nothing and exits 1 (it does not wait: a manual command should not hang for hours).
- **Scheduling pattern:** in-process croner (UTC). One job runs every minute inside a busy guard: it syncs the schedule when due (at start, after `30 0 * * *` asks for it, or 15 min after a failed try), then ticks. A minute that fires while the job runs is remembered, and the job runs once more when it ends (missed ticks run once, the Waterheight pattern). SIGTERM/SIGINT stops the cron, lets the current session finish, closes the pool and exits 0.
- **Heartbeat:** the work touches it at start, as each OpenF1 attempt starts (after the rate limiter), after each call, after each session and at the end of each tick (a waiting one too). One attempt lasts at most 120 s (the client's deadline), within the 120 s limit (A§4), so slow but progressing work never goes stale. Staleness means an attempt that ran into its deadline, a 429 `Retry-After` over 2 min, or a database wait past its timeouts; then `f1-tick` restarts the container.
- **Database waits are bounded:** connect 10 s, a statement 60 s on the server and 70 s on the client, TCP keepalive on, so a half-open connection cannot hang the job and its busy guard.

## 9. Timing rules (pure TS in `apps/server/src/timing/`, unit- and property-tested)

- **Deleted laps** (`rules.ts`; the lap rule amended by the owner 2026-10-26 after the full-data check, A§6.1): parse `race_control.message` after collapsing whitespace. The car is taken from the text, because `driver_number` is null in the data. `CAR n (ABC)`, then `TIME m:ss.mmm` or `LAP`, then `DELETED - <reason>`, then optionally `LAP n hh:mm:ss` and ` (PIT)`:
  - `CAR 87 (BEA) TIME 1:40.294 DELETED - TRACK LIMITS AT TURN 2 LAP 3 20:07:17`
  - `CAR 11 (PER) LAP DELETED - DOUBLE YELLOW AT TURN 12 LAP 2 21:32:22`, `CAR 5 (BOR) LAP DELETED - TRACK LIMITS AT TURN 11 LAP 9 16:29:31 (PIT)`
  - without `LAP n`: `CAR 87 (BEA) TIME 1:15.197 DELETED - TRACK LIMITS AT TURN 8 (NEXT LAP)`, `CAR 12 (ANT) LAP DELETED - TRACK LIMITS AT TURN 20 (NEXT LAP PIT)`
  - The reason is the text after ` - `, without the `LAP n …` part.
  - **Which lap:** a TIME matches the car's laps within 1 ms: one → that lap; several → the one lap with exactly that time (owner 2026-10-27), else the expected lap if it is one of them, else none; none → `LAP n`. **`LAP n` is the driver's lap n in a `Race`-type session (race, sprint) and lap n − 1 everywhere else** (practice, qualifying, sprint qualifying): of the 2,784 TIME + `LAP n` messages whose time one lap has, 2,773 sit there; the 11 others are OpenF1 numbering gaps that the time already resolves. A message that names no lap is counted, never applied.
  - **REINSTATED** (26 in 2023–2026): `CAR 63 (RUS) TIME 1:27.168 WILL BE REINSTATED` and `CAR 43 (COL) LAP 13 WILL BE REINSTATED`. The same rule, among the car's laps deleted at that moment, clears the lap.
  - **Order:** the messages in date order (dates compared parsed: they mix `+00:00` and `.095000+00:00`; ties keep their order). A lap deleted twice keeps the first reason; a REINSTATED before its DELETED clears nothing.
  - A message containing DELETED or REINSTATED in no known form is counted as `unparsed`. The per-session log line carries the counts, never a message (A§8).
  - A deleted lap keeps its values and is excluded from all bests.
- **Qualifying phase** (`rules.ts`): the phase of the last `race_control` row with a non-null `qualifying_phase` dated at or before the lap's `date_start` (a lap starting exactly on a row takes the new phase; same dates keep their order). Null without such a row or without a `date_start`. Sessions without phase rows (practice, races) get null; a lap started after the chequered flag keeps that phase. **Q1 inference** (owner 2026-10-27): in a session of type `Qualifying` (sprint qualifying included) whose first phase row is phase 2, a lap that starts before that row is Q1, because OpenF1 sent that session's Q1 rows without a phase (five 2026 sessions). Checked in A§6.1.
- **Colours in the historical view (final semantics)** (`colours.ts`, per request in the `api`; no column stores them): purple = the fastest valid value of that sector or lap in the session; green = the driver's own fastest valid value; yellow = the rest; null = no value. Out-laps and in-laps are never purple or green. Live (P2) uses progressive semantics: purple/green at that moment, as on the F1 tower.
  - Valid = not deleted, not an out-lap (`is_pit_out` null counts as false) and not an in-lap. A non-valid value is yellow.
  - Each driver's own best is one lap: the minimum valid value; on a tie the earlier `date_start` (nulls last), then the lower lap number. Purple is the best own best by value, `date_start`, lap number, then driver number: the first to set it holds it. Exactly one purple per field per session, or none without a valid value (a fast-check property).
- **In/out laps** (owner, 2026-10-25): out = `is_pit_out_lap`; in = lap n when the same driver's lap n+1 is an out-lap. A last lap that ends in the pits (a retirement, a qualifying in-lap after the flag) has no out-lap after it and is not marked.
  - `pit.lap_number` is not used for this. The **[U]** "`pit.lap_number` = in-lap" held only in races and sprints. P1a checked every pit row against the out-laps of 7 full sessions:
    - The out-lap is `pit.lap_number + 1` in race 11388 (25 of 25 rows) and sprint 11383 (54 of 54).
    - A pit row is not always a stop. In sprint 11383, race control sent "ALL CARS THROUGH THE PIT LANE" under the safety car (laps 2–4). Each pass is a pit row (`lane_duration` ≈ 18–19 s), and the next lap is an out-lap, so the rule above still holds.
    - The out-lap is `pit.lap_number` itself in qualifying 11392 (90/90) and 11384 (103/103), sprint qualifying 11379 (74/74) and practice 11378 (76/76) and 11391 (92/92). Lap-1 rows with null durations there are garage exits.
  - The test `[U] pit.lap_number against the out-laps` in `apps/server/test/openf1-schemas.test.ts` pins both meanings on the fixtures.
- **Sector deltas (comparison):** per lap, `driverB − driverA` per sector. Shown only when both values exist and neither lap is deleted. `sectorDeltas(a, b)` lives in `packages/contracts` (owner, P1c), where the web (P1e) imports it. **Best-lap row** (owner, 2026-10-28): the table opens with each driver's own best lap, the lap the server colours purple or green (exactly the own best above), paired whatever their lap numbers by giving both lap number 0 in `sectorDeltas`; it is labelled with both numbers ("Best lap", then "L12 vs L15" on a second line) and is always shown: a driver without a best lap gets "L—" and `—` cells.

## 10. API surface (`/api/v1`, JSON, zod contracts in `packages/contracts`)

| Route | Returns |
|---|---|
| `GET /seasons` | years with counts of meetings and sessions (not cancelled), newest first |
| `GET /seasons/:year` | meetings with their sessions, `ingest_state` and `is_cancelled`, by `date_start` |
| `GET /sessions/:key` | session, meeting, drivers, results |
| `GET /sessions/:key/laps` | all laps with colours, deleted flags, `quali_phase` and stint compound, computed server-side (a race is ~1,240 rows, ~20 KB gzipped; two queries: the session lookup, then the laps with their compound) |
| `GET /sessions/:key/stints` · `/pits` · `/race-control` | as named |
| `GET /status` | session counts per `ingest_state` (not cancelled), the cancelled count, and every session whose last fetch failed (`fail_count` > 0: retrying or `failed`). F1 TV token expiry and recorder state arrive in P2c |
| `GET /live` (P2) | current or next session and its recording id |
| `GET /playback/:recording/stream?at=<ms>\|live&delay=<s>&speed=1` (P2) | SSE: one `snapshot` event, then `delta` events (A§11.3) |

- JSON uses the A§7 column names (snake_case, no mapping layer), times as ISO-8601 UTC strings and durations as integer ms. Every answer has a strict zod contract in `packages/contracts` (P1c); an integration test parses each route against it.
- `Cache-Control: private, max-age=86400` on a per-session route of a `final` session and `no-store` on everything else under `/api`: a session that is not final, `/seasons*`, `/status`, and every 4xx/5xx. TanStack Query caches on the client. So a final session stays cached privately in the browser for 24 h: a later rules change or a `refetch` shows only after that, or after a hard reload.
- Errors are fixed: a bad `key` (`^\d{1,9}$`) or `year` (`^\d{4}$`) → 400 `{"error":"bad request"}`, an unknown one → 404 `{"error":"not found"}`, anything else → 500 `{"error":"internal"}`, logged as a code. No answer or log echoes input, a header, the token or a database message.
- **The Access JWT** (P1c, `apps/server/src/api/access.ts`; ADR-0004 amended) is checked on every `/api` request, every method and unknown paths included, by our own middleware on hono's `verifyWithJwks`, not the `hono/jwk` middleware (that one wants `Bearer <token>`, and Cloudflare sends the bare JWT):
  - The token is the `Cf-Access-Jwt-Assertion` header; `Authorization` and cookies are ignored. A header with whitespace, or a token whose header is not RS256 with a `kid`, is refused before any certs fetch.
  - Then the signature against the team's certs, the `kid`, `iss` = `https://<team>.cloudflareaccess.com`, `aud` (a string or an array holding the AUD tag), `exp` (required; hono skips an absent one) and `nbf` (≤ now + 60 s). `iat` is not checked: hono has no leeway for it, and `exp`/`nbf` cover freshness. The keys are passed in, so a token's `jku`/`x5u` is never followed.
  - Every refusal is the same 401 `{"error":"unauthorized"}`, with no reason in the answer or the log.
  - The certs (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, 5 s timeout, no redirects, parsed non-strictly) are kept per process for 5 min; concurrent requests share one fetch. Only RSA keys with a `kid` are used, any other entry is skipped, and a list without one is a failure. When a refresh after the 5 min fails, the last keys serve for up to 1 h after they were fetched (each such request logs `access_certs` with `stale: true`), then 503 `{"error":"unavailable"}`. A cold start without keys answers 503 at once, logged as `access_certs`, and the next request fetches again (no negative cache). An unknown `kid` is a 401 without a refetch, so a key rotation can refuse logins for up to 5 min. A `ponytail:` note in the code names both fixes: a refetch on an unknown `kid` at most once a minute, and a 30 s negative cache.
  - Config: `CF_ACCESS_TEAM` (`^[a-z0-9][a-z0-9-]{0,62}$`, which keeps the certs URL on `cloudflareaccess.com`) and `CF_ACCESS_AUD` (`^[0-9a-f]{64}$`) from `/etc/f1/f1.env`, a Compose `env_file` (P1f). They are not secrets. Missing or malformed → the `api` role logs the variable's name and exits 78 before listening.
- `/healthz` (`select 1` → 200 `{"ok":true}`, else 503 `{"ok":false}`, `no-store`) is the only route without the JWT check. The local update smoke test uses it, and through the tunnel it still sits behind Access.

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
- The `api` (`:8080`, inside the compose network only) checks the Access JWT itself (A§10). For that it makes outbound HTTPS to `<team>.cloudflareaccess.com` (Cloudflare's published ranges, A§14.3) for the team's certs, and reads the non-secret `CF_ACCESS_TEAM`/`CF_ACCESS_AUD` from `/etc/f1/f1.env`.

### 12.3 F1 TV credentials and token (ADR-0005)

- `f1tv_username` and `f1tv_password` are file secrets. The account has no 2FA, so automatic login works.
- The login is a TS port of FastF1's OAuth2 Authorization Code + PKCE flow against `id.formula1.com` (PingOne DaVinci, `response_mode=pi.flow`, all JSON calls). The access token's `subscriptionToken` claim is the Bearer token. It expires in ~4 days and has no refresh token.
- The token is cached at `/srv/f1/state/f1tv-token` (0600, live UID). The token itself is never logged; only its expiry is.
- Fallback if the login breaks (bot protection, a flow change): the owner pastes the `login-session` cookie value from formula1.com into the token file (as undercut-f1 does). The status panel warns 24 h before expiry and when a login fails.

### 12.4 Agents and CI (P0 security review, 2026-10-25)

- **Trust anchors:** the lockfile, the hand-maintained sha256 pins of the CI binaries (Dependabot does not bump them), and the required checks, which the PR itself defines. A diff under `.github/`, `scripts/`, `pnpm-workspace.yaml` or `.claude/` gets a line-by-line owner read.
- **`main`:** branch protection requires `ci` and `security`, enforced for admins, with no force-push or deletion, and a pull request before merging (0 approvals). Merge commits only.
- **Agent identity:** agents use the owner's admin OAuth token until P1f, when they move to their own fine-grained token without the Administration permission (A8). Until then "agents never merge" rests on the deny rules in `.claude/settings.json` and on the branch protection. The A8 token has contents, pull requests and issues read/write and no Workflows permission, so the owner pushes any diff under `.github/workflows` (owner, 2026-10-28). Agents switch to it before the first deploy from `main`.
- **Secrets:** `db_f1_migrator` is the first one. It lives in the `migrate` process and in the dbmate child's environment (readable through `/proc/<pid>/environ` by the same UID in the one-shot container). `DATABASE_URL` overrides it in dev and test; Compose never sets it, which the `hardening` check in `ci / deploy` enforces.
- **CI egress (CI only):** GitHub release assets, registry.npmjs.org, Docker Hub, nodejs.org (setup-node), api.github.com (zizmor), gcr.io (distroless base image), ghcr.io (the `release` job pushes there), deb.debian.org and the Ubuntu archive (nftables in the nft-check container and on the runner). Production gains no host.
- **CI deploy test (`ci / deploy`, e2e):** the runner has Docker 28.0.4 (client and server) and the nft-check container has nftables 1.1.3 (Debian trixie); the VM runs Docker 29, so the [box] commands in `docs/runbooks/install.md` confirm there. The run proved: a second `f1-install` makes `0 change(s)`, `systemd-analyze verify` passes on the units, local tags (`f1-server:ci`) work as image refs through `current.env`, `api` → `https://www.google.com` is blocked (`TimeoutError`) with the f1 table loaded, a broken image rolls back and the known-bad pair is skipped, and `f1-tick` reloads a deleted table.
- **Accepted risks (owner, 2026-10-25):**
  - The `git diff *`, `git log *` and `git show *` allow rules stay, although `--output=<path>` lets them write a file without a prompt.
  - `npm`, `yarn` and `bunx`, `git push --prune` and `git -c … push` are not denied.
  - GitHub does not itself enforce SHA-pinned or allow-listed actions; `scripts/check-workflows.sh` and zizmor do, in files a PR can change.

### 12.5 Deploy path (P1f security review, 2026-10-29)

- **GHCR write access is code execution on the box:** `f1-update` runs whatever `:main` is, as containers with the db and its secrets. Hence the `production` environment on the `release` job (required reviewer: the owner; deployment branches: `main`), and the A8 agent token without Workflows. The `release` job holds `packages: write` behind that gate. Agents cannot merge: branch protection, the deny rules in `.claude/settings.json` (`gh api …/merge`, `gh api graphql`, `gh auth token`) and the environment approval.
- **`cf4`** lets the `api` reach any Cloudflare-fronted host on 443. Accepted: the api only fetches the team's certs.
- **`127.0.0.1:8180`** is reachable by local VM users: it serves the static site and `/healthz`; the api still checks the Access JWT.
- **New secrets:** `cf_tunnel_token` and `hc_ping_key`. **New egress:** hc-ping.com (`ingest`, tcp/443) and tcp+udp/7844 to the tunnel ranges (`cloudflared`).
- **Root:** three systemd units drive Docker as root: `f1-firewall`, `f1-update` and `f1-tick`. Their scripts are root-owned copies in `/usr/local/bin`; the timers never run a file of the checkout.

## 13. Frontend

- **Routes** (no router library; `routeOf(location.pathname)` plus `history.pushState`, as in Waterheight; `apps/web/src/lib/routes.ts`): `/` (latest session) · `/:year` · `/:year/:meeting/:session/{laps|compare|minisectors|stints}` · `/status` · `/live` · `/replay/:recording`.
  - A meeting or session segment is `<key>-<name>`, such as `/2026/1290-singapore/9965-race/laps`, and parses as `^(\d{1,9})(?:-[a-z0-9-]*)?$`. The key decides; the name is decoration (lower case, diacritics stripped, other runs → `-`; meetings drop a trailing ` Grand Prix`). Once the session is loaded, a wrong or missing name, year or meeting key is replaced by the canonical URL (`history.replaceState`). `/:year/:meeting/:session` goes to `…/laps`.
  - `/` walks the seasons newest first and goes to the last session that has started and is not cancelled in the first season that has one (a new season can be listed before its first session), else to `/:year` of the newest. The header holds a season `<select>` and a link to `/status`.
  - Since P1e the `compare` and `minisectors` views exist; only `/live` and `/replay/*` stay not found until P2. The session tabs read Laps · Compare · Mini-sectors · Stints.
  - Links are real `<a href>`s; only a plain left click navigates in place, so a modified or middle click opens a new tab.
- **Views:**
  - **Season** (`/:year`): the meetings with their sessions and start times; a cancelled session is struck through and not linked.
  - **Lap table** (owner, 2026-10-28): a drivers × laps matrix with one time per cell. A segmented control `Lap | S1 | S2 | S3` picks the metric, and a toggle puts the drivers in rows (default: a sticky driver column with a 4 px team-colour bar, lap numbers as the header row) or in columns (a sticky lap column, drivers as the sticky header row). Both are component state, not URL state.
    - The colour is the cell's text colour. Colour is never the only cue: purple is also bold and boxed (a 2 px inset outline), green is also bold, yellow is plain, and a legend under the metric switch shows the three styles ("overall best", "personal best", "other"). On a ranked lap the cell's `title` names its colour (overall best, personal best, slower than personal best); a deleted lap, an in-lap or an out-lap has no such title, because the server colours all its values yellow without ranking them (A§9). The table has an accessible name per metric ("Lap times", "S1 times", …).
    - A deleted lap is struck through in every metric; a missing value shows `—`. The reason sits behind the cell in a tap popover (`ui/Note.tsx`: a `<button popovertarget aria-describedby>` plus a native `popover`, so a tap works on a phone with no JS state; the `title` serves a hover). It is the deletion reason, or why the value is missing: an out-lap (S1, and the lap time on lap 1), an in-lap, race lap 1 from the grid, else "No time in the OpenF1 data". These are the cases the P1d null probe over every session since 2025 shows to be real.
    - PIT IN/OUT badges. The compound dot (S/M/H/I/W) marks the first lap of each run per driver (a new compound, or new tyres out of the pits), not every cell.
    - Drivers by result position (nulls last), then number; drivers without laps are left out. A session without laps says "No laps yet".
  - **Driver picker** (owner, 2026-10-28): Compare and Mini-sectors share one selection, held by the session view (`views/Session.tsx`) in pick order and passed to both, so it survives a tab change. It is not in the URL: it defaults to the first two drivers of the lap-table order (fewer when the session has fewer) and resets on a session change (`App.tsx` keys the session view by its key) and on a reload. The picker (`views/DriverPicker.tsx`) is a `Drivers` fieldset of toggle chips (`aria-pressed`), one per driver in the lap-table order, each with its acronym and team bar and at least 44 px. Compare with fewer than 2 drivers says "Pick at least 2 drivers."; Mini-sectors with none says "Pick a driver.".
  - **Comparison** (owner, 2026-10-28): the lap-time chart, then the sector deltas.
    - **Chart:** ECharts in a lazy chunk (`lib/echarts.ts`, the only runtime import of it; `views/LapChart.tsx` loads it with `import()` and shows "Loading…" meanwhile, or "Chart failed to load: reload the page."), the canvas renderer, full width with its height from CSS (`.chart`). The option is a pure function (`views/lap-chart-option.ts`): one dense series per driver over a category axis of laps 1…last, a lap missing or without a time is null and breaks the line (`connectNulls: false`). Every lap with a time is plotted on a 107 % window: from the fastest valid (purple or green) lap of the selected drivers − 1 s, floored to a whole second, to 107 % of it, ceiled; slower laps (in, out, safety car) run off the top (`clip: true`) and stay in the tooltip; without a valid lap the axis scales by itself. A deleted lap is a hollow point (`emptyCircle`). The line has the team colour (else `--muted`); each repeat of a colour (a teammate, or drivers without a team colour) takes the next line type, solid, dashed, dotted, then round again. A deleted lap's hollow point is 8 px, twice the default. The tooltip is rich text, not HTML (`renderMode: 'richText'`): "Lap 12", then per driver "VER 1:33.456", "… deleted" or "VER —", with `{`, `|` and `}` stripped from data strings (rich-text markup). The theme colours are read once when the chart starts: a live theme switch needs a reload.
    - **Delta table** (`views/DeltaTable.tsx`): the first selected driver is the reference; every other driver gets a Δ S1/S2/S3 column group, that driver − the reference, headed "NOR Δ vs VER" (to change the reference, deselect and reselect). A Best-lap row always comes first (A§9; `—` where a driver has no best lap), then one row per lap both drivers have; a reference without laps gets a note above the table. Two drivers fit 390 px without scrolling (the Best-lap label on two lines, 6 px cell padding); more groups scroll inside `.scroll`. Values are signed seconds (`+0.123`, `−0.045`, `fmtDelta` in `lib/time.ts`); a delta `sectorDeltas` leaves null (a missing value or a deleted lap) shows `—`. It scrolls in `.scroll` and is named "Sector deltas".
  - **Mini-sectors + speed traps** (owner, 2026-10-28; `views/MiniSectors.tsx`): one table in `.scroll`, per selected driver in pick order a header row with the team bar, then one row per lap: the lap number (struck through when deleted, with the IN/OUT badge), one box per segment in S1, S2 and S3, then I1, I2 and ST in km/h (`—` when null). Each sector has as many boxes as the longest array of the session; a shorter or null array is padded with "no data" boxes. Codes (A§6.1, `segClass`): 2048 yellow "other", 2049 green "personal best", 2051 purple "overall best", 2064 blue "pit lane" (`--pit`), 0 and a null element an empty outlined box "no data", and every other code grey (`--muted`) "unknown code <n>". Each box has that `title` for a hover, purple is also boxed, and a legend sits above the grid, so colour is never the only cue. For a screen reader the boxes are hidden (`aria-hidden`) and each sector cell has one `aria-label` with the counts in legend order, such as "S1: 4 personal best, 2 other", so a race is not tens of thousands of images. A `Race`-type session (sprints included) shows a banner: "Mini-sector colours unreliable in races".
  - **Stints:** horizontal compound bars per driver, in the lap-table order, fitted to the full width (a stint is its laps over the session's highest lap number wide). A stint shows its compound letter, its lap range where it fits, and a `title` with the compound, the laps and the tyre age, marked "may be wrong for a used set" (A§6.1, #473). Compound letters are black on the compound fill (an unknown compound gets a grey fill), 4.5:1 or more in both themes.
  - **Status** (`/status`): session counts per `ingest_state` plus the cancelled count, and a table of the sessions whose last fetch failed.
  - **Live/replay** (P2): a timing tower (position, gap, interval, last/best lap, live sectors and mini-sectors, tyre, pits), the delay slider, play/pause/seek, and session-clock markers (start, red flags, chequered flag).
- **Look:** dark F1 timing-screen style by default, plus a light theme following `prefers-color-scheme` (tokens on `:root` in `apps/web/src/styles.css`). Team colours come from `drivers.team_colour`, used only when it is six hex digits (else `--muted`). Purple, green, yellow, the text and the muted text are text on the background and reach WCAG AA 4.5:1 in both themes (a unit test, which also checks the compound letters on their fills); the mini-sector fills are those tokens plus `--pit`, held to the same 4.5:1. Colour is never the only cue (the lap table's styles and legend above). A render exception shows "Something went wrong: reload the page." from an error boundary instead of a blank page. No font or icon files: the system font stack with tabular numbers.
- **CSP** (A§12.1 invariant 6): the build has no inline script or style and no `data:`/`blob:` URL (`build.assetsInlineLimit: 0`, plain CSS imported from the entry). React `style` props carry only custom properties (`--team`, `--x`, `--w`): a client render sets them through CSSOM, which `style-src 'self'` does not block; only `style=` attributes in markup and `<style>` elements are blocked. **The ECharts chunk** (P1e, a grep of the built chunk): no `setAttribute("style"`, `insertRule`, `createElement("style")`, `eval(` or `new Function`, and no `blob:`, `createObjectURL` or `data:` URL (its 9 `data:` hits are object keys), so the dist scan passes with no allowance. Its 3 `cssText` writes are CSSOM (zrender's canvas root and a measuring helper on our path, the HTML tooltip off it). Its 9 `innerHTML` hits are the SVG export paths (never called), the HTML tooltip (bundled but never instantiated: `renderMode: 'richText'` builds the rich-text tooltip instead; the only `innerHTML` that parses HTML is there) and zrender's canvas painter clearing its root with an empty string.
- **Mobile:** must work on a phone (`width=device-width` viewport). Tables scroll inside their container (`.scroll`, never the page; it also bounds the height, so the sticky header row holds), links, buttons, selects and table rows are ≥ 44 px, and charts are full width.
- **Times** (owner, 2026-10-28): shown in Europe/Amsterdam through `Intl.DateTimeFormat`, not Temporal, with no polyfill. All formatting lives in `apps/web/src/lib/time.ts`: instants as "Sun 11 Oct 2026, 14:00", lap times as `m:ss.SSS`, sectors as `ss.SSS` (`m:ss.SSS` from 60 s).

## 14. Deployment

### 14.1 Host

- The Waterheight Hyper-V VM (Debian 13 amd64) goes from 4 vCPU / 8 GB to **6 vCPU / 12 GB** (owner action). Disk: 1 TB, 960 GB free.
- Under a separate compose project `f1`. Paths: `/etc/f1/{f1.env, secrets/}`, `/srv/f1/{state, live}`, a named volume `f1_pgdata`.

### 14.2 Services (limits **[U]**, tuned after the backfill and the first live weekend)
| Service | Image | mem / cpus | Networks |
|---|---|---|---|
| `db` | postgres:18.6-trixie | 1g / 1.0 (`shared_buffers=256MB`, `max_connections=20`) | `f1-db` (internal) |
| `api` | f1-server `api` | 384m / 1.0 | `f1-edge` (internal), `f1-db`, `f1-api-egress` (api only) |
| `ingest` | f1-server `ingest` | 256m / 0.5 | `f1-egress`, `f1-db` |
| `live` (P2) | f1-server `live` | 384m / 1.0 | `f1-egress`, `f1-db` |
| `caddy` | f1-web | 128m / 0.5 | `f1-edge`, `f1-tunnel-edge`, `f1-publish` (caddy only) |
| `cloudflared` | cloudflare/cloudflared | 256m / 0.5 | `f1-tunnel`, `f1-tunnel-edge` |
| `migrate` | f1-server `migrate` (profile `jobs`) | 128m | `f1-db` |

- Total limits are ~2.7 GB. Expected steady state is ~0.9 GB.
- Bridges are named `f1-*`, IPv4 only, with fixed subnets 10.62.1–7.0/24 (owner, 2026-10-28) in this order: `f1-db`, `f1-edge`, `f1-egress`, `f1-api-egress`, `f1-tunnel`, `f1-tunnel-edge`, `f1-publish`. `f1-install` refuses to install when one overlaps a host route or a non-`f1` Docker network (Waterheight's 172.30.0.0/16, the LAN). `enable_icc: false` on the four non-internal networks. Every container has at most one non-internal network, so its default route is unambiguous.
- `f1-publish` carries `caddy` only, for the `127.0.0.1:8180` publish (the f1-update smoke test): Docker does not publish a port for a container that is only on internal networks. The firewall drops all its egress. Proven in CI (`ci / deploy`, e2e): the only port binding is `/f1-caddy-1 80/tcp → 127.0.0.1:8180`.
- `db` runs as 62532 on the volume `f1_pgdata`: the postgres image's `/var/lib/postgresql` is mode 1777, so a new volume lets an arbitrary UID run initdb. Proven in CI: initdb as 62532 on a fresh `f1_pgdata`, `roles.sql` through initdb, `migrate` as `f1_migrator`. The healthcheck is `pg_isready -U postgres` (62532 has no passwd entry). The local socket is `trust` inside the container only; TCP is `scram-sha-256`. `roles.sql` runs once, through `docker-entrypoint-initdb.d`, on a new volume. `migrate`, `api` and `ingest` start with `depends_on: db: service_healthy`.
- `cloudflared` (2026.10.3, by digest) reads its token with `--token-file` (never `TUNNEL_TOKEN`), binds its metrics to `127.0.0.1:20241` and has the image's `tunnel ready` healthcheck. `caddy` sets the sysctl `net.ipv4.ip_unprivileged_port_start=80` and has tmpfs `/data` and `/config`. `migrate` is a `jobs`-profile job that `f1-update` runs before `up`.
- UIDs/GIDs: containers run as 62532 (not Waterheight's 65532/65533). Secret GIDs start at 62001 (Waterheight uses 61001–61012). A consumer gets its secrets' GIDs through `group_add`; the files are `root:<gid> 0440`:

  | Secret | GID | Consumers |
  |---|---|---|
  | `db_postgres` | 62001 | `db` |
  | `db_f1_migrator` | 62002 | `db`, `migrate` |
  | `db_f1_ingest` | 62003 | `db`, `ingest` |
  | `db_f1_api` | 62004 | `db`, `api` |
  | `cf_tunnel_token` | 62005 | `cloudflared` |
  | `hc_ping_key` | 62006 | `ingest` |

  62007 and up are reserved for P2c (`f1tv_*`). `db` holds the three login GIDs because `roles.sql` sets the passwords with `pg_read_file`.
- The `migrate` contract (built in P0, owner 2026-10-25): host `db:5432`, database `f1`, login `f1_migrator`, and the password from the file secret `db_f1_migrator` (`/etc/f1/secrets/db_f1_migrator` on the host, `/run/secrets/db_f1_migrator` in the container). `DATABASE_URL` is a dev/test switch that Compose never sets. The server image has dbmate on its `PATH`.

### 14.3 Firewall

- A separate `table inet f1`, loaded by `f1-firewall.service` (oneshot, `nft -c` then `nft -f`, never `flush ruleset`).
- Forward hook on `f1-*` interfaces only:
  - DNS to the host resolvers
  - tcp/443 from `f1-egress`
  - tcp+udp/7844 from `f1-tunnel` to Cloudflare's tunnel ranges
  - tcp/443 from the `api` (`f1-api-egress`, shared with no other service) to Cloudflare's published IP ranges only, for the Access certs (owner, 2026-10-26, P1c). Port 8080 is never published, and Caddy↔api stays on the internal `f1-edge`
  - drop everything else (all of `f1-publish`'s egress included), plus host-input drops for `f1-*` (only established/related replies pass: docker-proxy's path for 8180)
- DNS is allowed only from the three egress networks (`f1-egress`, `f1-api-egress`, `f1-tunnel`), to the set `resolvers4`, and before the drop of private ranges (the resolvers may be on the LAN). The private ranges are dropped even on 443. Traffic from an `f1-*` bridge to another `f1-*` bridge is `return`ed to Docker's own internal and icc rules.
- Sets (fetched 2026-10-29): `cf4` from `https://www.cloudflare.com/ips-v4`; `cf_tunnel4` = 198.41.192.0/24 and 198.41.200.0/24 from Cloudflare's "Tunnel with firewall" documentation; `resolvers4` is filled by `f1-resolvers` from the host's resolv.conf (an `ExecStartPost` of `f1-firewall.service` and every `f1-tick`). The owner refreshes `cf4` and `cf_tunnel4` by hand (`docs/runbooks/cloudflare.md`).
- Without this table a second project's egress is unrestricted, because Waterheight's table only matches `rws-*` and `docker0`.

### 14.4 Updates

- CI on `main` (the `release` job, in the GitHub environment `production`: it waits for the owner's approval before it touches GHCR, owner 2026-10-29) builds both images, pushes `ghcr.io/mwijkhuisen/f1-server` and `f1-web` as `:main` and `:sha-<git>` (public, no secrets inside), and records the digests. The job's `concurrency` group queues runs without cancelling, so `:main` stays on the newest commit.
- `f1-update.timer` (every 10 min) runs `deploy/bin/f1-update`:
  1. take a flock; refuse (exit 1) when `table inet f1` is not loaded
  2. `docker pull` `:main`; wait (exit 0) while the two images' `org.opencontainers.image.revision` labels differ (a release half pushed); stop if the digest equals `current.env`; stop with a loud log line if the pair equals `failed.env` (a known-bad pair is never retried automatically; `rm /srv/f1/state/failed.env` to retry)
  3. run `migrate`
  4. `up -d`
  5. smoke-test `http://127.0.0.1:8180/healthz`, then require every f1 container healthy (an unhealthy `ingest` or `cloudflared` fails the deploy)
  6. on failure, write the pair to `failed.env` and roll back to the previous digests in `/srv/f1/state/current.env`
- State lives in `/srv/f1/state`: `current.env` (the last pair that passed), `candidate.env` (during a run), `failed.env`.
- `f1-update --server <ref> --web <ref>` deploys the given images instead (drills, CI); the flag not given keeps the image of `current.env`, and the revision check is skipped. A ref with a registry host is always pulled and recorded by digest, so `current.env` never names a movable tag; only a host-less local ref (`f1-server:ci`) is recorded as given.
- GitHub has no server credentials.
- Compose, Caddyfile, nftables and units change rarely. The owner applies them with `deploy/bin/f1-install` from a checkout on the VM. It is idempotent, re-applies a changed compose file to a running deploy, and does not enable the timers: the owner does that once the secrets and `f1.env` are filled (`docs/runbooks/install.md`).

### 14.5 Operations

- **`f1-tick.timer`** (every 10 min, at :05): reloads `table inet f1` if it is missing, refreshes `resolvers4`, restarts unhealthy `f1` containers (Docker doesn't) and records disk usage in `/srv/f1/state/disk`. Fail closed: when the table cannot be loaded, it stops every `f1` container and writes `/srv/f1/state/firewall-stopped`; once the table loads again, `f1-tick` or `f1-update` starts `current.env` again. Restarts and the restart of a stopped stack run under `f1-update`'s lock and are skipped for that round while a deploy or `f1-install` holds it.
- **healthchecks.io:** uses the 2 free checks left on the account: `f1-ingest` (pinged once the sync requested by the daily `30 0 * * *` Cron, or its 15-minute retry, has succeeded; not after the startup sync, so a crash loop does not stay green; period 1 day, grace 1 h) and `f1-live` (each scheduled recording completed, from P2).
- **Logs:** pino JSON to Docker's `local` driver (host daemon defaults). Fixed codes only, never URLs with tokens.

## 15. Testing

- **Unit:** parsers, timing rules, the rate limiter (fake timers), and live delta merging (a fast-check property: merging snapshot + deltas equals merging the deltas from empty).
- **Integration:** real PostgreSQL 18 as a CI service container. Each file creates its own DB, applies `roles.sql` (`apps/server/test/db.ts`) and runs dbmate up → tests; the ingest tests log in as `f1_ingest`, never as the superuser. `db-check` is P0's up → down → up test (`apps/server/test/migrate.int.test.ts`) plus `kysely-codegen --verify` against a freshly migrated database (`apps/server/test/db.int.test.ts`: the committed `types.ts` matches the migrations). A unit test pins the sha256 of every migration (`test/migrations.test.ts`).
- **Fixtures:** `apps/server/src/openf1/fixtures/` holds trimmed real OpenF1 responses (public, no auth). Live/archive parser fixtures are synthetic in the repo. Real recordings stay in `fixtures-private/` (gitignored) and are used locally only. `scripts/record-fixture.ts` refuses to run when `CI` is set.
- **Web:** component tests render statically with `react-dom/server` in Vitest's node environment, with data as props: no DOM environment (owner, 2026-10-28; happy-dom arrives with the first interaction test). They cover the lap table (colours per metric, deleted laps, missing values and their reasons, IN/OUT, compound dots, both orientations, driver order), the season picker, the stints and the status panel. `compare.test.tsx` covers the chart option (null points, `connectNulls`, the 107 % window, hollow deleted laps, the line types per repeated colour, whole-ms axis labels, the rich-text tooltip and its `{|}` stripping), the delta table (null and deleted laps → `—`, the sign, the Best-lap row and its `—` without a best lap, the note for a reference without laps, the first selected as reference, one group per other driver) and the picker's `aria-pressed`; `minisectors.test.tsx` covers `segClass` for every mapped and several unknown codes, the grey cells, the one text per sector cell, padding, `—` speeds and the race banner. `apps/web/test/build.test.ts` runs a production `vite build` and scans `dist` for inline scripts, styles and handlers, `data:`/`blob:` URLs and third-party references, and checks from Rolldown's output that ECharts (`echarts`, `zrender`) sits only in the one lazy chunk of `lib/echarts.ts`, never in the entry's static import graph; `contrast.test.ts` checks the theme tokens for 4.5:1 in both themes. No browser matrix in CI.

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
