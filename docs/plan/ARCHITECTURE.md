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
- Known issues (open on `br-g/openf1`): null pit `stop_duration` (#484), sessions needing re-ingest (#483), wrong `tyre_age_at_start` for used sets (#473), slowness right after a session becomes free (#474).

| View | Endpoints → fields | Known gaps → UI |
|---|---|---|
| Session header | `meetings` (name, circuit, `gmt_offset`), `sessions` (type, name, start/end), `session_result` (position, laps, dnf/dns/dsq, `duration` (an array of Q1/Q2/Q3 in qualifying), `gap_to_leader`) | — |
| Lap table | `laps`: `lap_number`, `lap_duration`, `duration_sector_1..3`, `is_pit_out_lap`, `date_start` (approximate). `drivers`: `name_acronym`, `team_name`, `team_colour`. `pit.lap_number` → in-lap **[U]**. `race_control` → deleted laps (A§9) | Null `lap_duration` or sectors on out-laps and some flying laps (11392: 84 of 280 S1 null, 25 laps without a time) → `—` with "not timed" |
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
| `meeting` | `meeting_key` | year, name, official_name, location, country_code, circuit_short_name, gmt_offset, date_start, date_end |
| `session` | `session_key` | meeting_key, type, name, date_start, date_end, `ingest_state` (scheduled · due · fetched · final · failed), `next_fetch_at`, `fetch_count`, `last_error` |
| `driver` | (session_key, driver_number) | acronym, full_name, team_name, team_colour |
| `lap` | (session_key, driver_number, lap_number) | date_start, lap_ms, s1_ms, s2_ms, s3_ms, i1_kph, i2_kph, st_kph, is_pit_out, is_pit_in, seg1/seg2/seg3 `smallint[]`, deleted, deleted_reason, quali_phase |
| `stint` | (session_key, driver_number, stint_number) | lap_start, lap_end, compound, tyre_age_at_start |
| `pit` | (session_key, driver_number, lap_number) | date, pit_ms, lane_ms, stop_ms |
| `race_control` | id | session_key, date, category, flag, scope, sector, driver_number, lap_number, qualifying_phase, message |
| `result` | (session_key, driver_number) | position, laps, dnf, dns, dsq, durations_ms `int[]`, gaps_ms `int[]` |
| `raw_response` | (session_key, endpoint) | fetched_at, http_status, body `jsonb` (latest only) |
| `recording` (P2) | id | session_key, path, started_at, ended_at, bytes, complete |

Size: 2023–2026 is about 470 sessions, under 2 GB including raw JSON **[U]** (measured after the backfill).

## 8. Ingestion (OpenF1)

- **Schedule sync:** daily at 00:30 UTC, plus at start: `meetings` and `sessions` for the current year (and every year from 2023 on the first run). Upserts `meeting`/`session`.
- **Per-session pipeline:** `due` at `date_end + 35 min` (after the paid window). Fetch `drivers`, `laps`, `stints`, `pit`, `race_control`, `session_result` → store raw → normalise in one transaction → `fetched`. Fetch again at +3 h and +24 h for OpenF1 corrections → `final`. Failures back off exponentially (5 min … 6 h), then `failed`, shown in the status panel.
- **Rate budget:** a token bucket at 25 req/min and 2 req/s, below the 30/3 limit. On a 429, honour `Retry-After` or wait 60 s. 6 requests per session.
- **First backfill:** every past session from 2023 that isn't `final`, newest first: ~470 × 6 ≈ 2,800 requests ≈ **1 h 55 min**. It's resumable, because state lives in the DB.
- **Manual:** `refetch <session_key>` for OpenF1 re-ingests (as in #483).
- **Scheduling pattern:** in-process croner (UTC) with its own busy guard. Missed ticks run once (the Waterheight pattern).

## 9. Timing rules (pure TS in `apps/server/src/timing/`, unit- and property-tested)

- **Deleted laps:** parse `race_control.message`. The car is taken from the text, because `driver_number` is null in the data. Two known forms: `CAR 87 (BEA) TIME 1:40.294 DELETED - TRACK LIMITS AT TURN 2 LAP 3 20:07:17` and `CAR 11 (PER) LAP DELETED - DOUBLE YELLOW AT TURN 12 LAP 2 21:32:22`. Also handle `… REINSTATED` (format **[U]**: none in the sample). The `LAP n` in the text is the driver's lap. A deleted lap keeps its values and is excluded from all bests.
- **Colours in the historical view (final semantics):** purple = the fastest valid value of that sector or lap in the session; green = the driver's own fastest valid value; yellow = the rest. Out-laps and in-laps are never purple or green. Live (P2) uses progressive semantics: purple/green at that moment, as on the F1 tower.
- **In/out laps:** out = `is_pit_out_lap`; in = the lap matching a `pit` row **[U]**.
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
- **Integration:** real PostgreSQL 18 as a CI service container. Each file creates its own DB and runs dbmate up → tests. `db-check` does up → down → up.
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
