# Phases: F1 Timings

Status: approved by the owner (2026-10-25). It builds on `ARCHITECTURE.md` (cited A§x). Each phase becomes one GitHub issue (template from P0) and one or more PRs.

## 1. Timeline

| Window | Phases | Why then |
|---|---|---|
| Now → mid Nov 2026 | **P0**, **P1a–P1c**, **P2-rec** (owner, alongside) | Foundation and data first. Record live feeds while the 2026 season still runs |
| Nov 2026 | **P1d–P1f**, **P2a** spike (Las Vegas 20–22 Nov or Lusail 27–29 Nov; Yas Marina 4–6 Dec is the last chance) | v1 live on the VM. The live connection has to be proven while sessions still happen |
| Dec 2026 → Feb 2027 | **P2b–P2e** | No sessions; build on the recordings and archive files |
| 2027 pre-season testing / first race | **P2f** | Live verified on a real session |
| After P2 | **P3a–P3c** | History back to 2018 (and optional pre-2018 lap times) |

Remaining 2026 weekends (OpenF1 schedule): Austin (race 25 Oct) · Mexico City 30 Oct–1 Nov · São Paulo 6–8 Nov · Las Vegas 20–22 Nov · Lusail 27–29 Nov · Yas Marina 4–6 Dec.

## 2. Criterion tags and workflow

- **Tags:**
  - **[CI]** is proven by a test or check in CI.
  - **[box]** is checked on the VM with a command the PR supplies.
  - **[weekend]** needs a real F1 session.
  - **[owner]** is a manual owner action or judgement.
- **Per phase:** one issue with the goal, scope, deliverables and acceptance criteria copied from this file. Branch `claude/p<N><x>-<slug>`, conventional commits, and a PR with an evidence checklist (each criterion → test or command output). Agents never merge. The owner merges once the `ci` check is green.
- **Reviews:** a fresh-session `/code-review` before merging P1b, P1c, P2b, P2c and P2d. A security review for anything touching secrets, the firewall, Access, the token or the compose hardening (P0 CI, P1f, P2c).
- **Done:** CI green, criteria evidenced, docs and ADRs updated, any new dependency has an ADR-lite line in the PR ("why · licence · maintainer health · transitive count").
- **New facts:** an **[U]** fact proven or disproven in a phase is written back into ARCHITECTURE.md in the same PR.

## 3. Phases

### P0: Foundation

- **Goal:** an empty but complete workspace, so every later PR only adds features.
- **Scope in:**
  - pnpm workspace (`apps/server`, `apps/web`, `packages/contracts`), tsconfig base/tooling/project references, Biome, Vitest `unit` + `integration`, msw setup (`onUnhandledFrame: 'error'`), `.node-version`, the pnpm policy in `pnpm-workspace.yaml`
  - `main.ts` role dispatcher with `healthcheck` and the heartbeat
  - dbmate + `migrate` role + a first empty migration
  - `.gitignore` (`.env*`, `fixtures-private/`, secrets), PolyForm Strict 1.0.0 `LICENSE`
  - `.claude/settings.json` denying reads of `.env*`/secrets, force-push and `npx`/`pnpm dlx`
  - CI `ci.yml`: check, integration on a PG 18 service, dbmate round trip, shellcheck, aggregate `ci`. `security.yml`: gitleaks, zizmor, workflow-lint
  - Dependabot (7-day cooldown), PR template, phase issue template
- **Scope out:** any feature (P1+), images and deploy (P1f).
- **Acceptance:**
  - [CI] `pnpm check` passes.
  - [CI] the integration job creates a DB and runs dbmate up → down → up.
  - [CI] CI asserts each pnpm policy key with `pnpm config get`.
  - [CI] gitleaks passes on the full history.
  - [CI] actions are pinned to SHAs and `permissions: {}` is set at the top level.
  - [owner] branch protection on `main` requires `ci`.

### P1a: OpenF1 client and fixtures

- **Goal:** typed, polite access to OpenF1 with recorded fixtures.
- **Scope in:**
  - undici client: timeouts, a token bucket at 25/min and 2/s, `Retry-After` handling, exponential backoff
  - zod schemas for `meetings`, `sessions`, `drivers`, `laps`, `stints`, `pit`, `race_control`, `session_result`, with every field nullable where real data shows nulls (A§6.1)
  - `scripts/record-fixture.ts` (refuses under `CI`)
  - fixtures per endpoint: normal (race 11388), edge (quali 11392 with nulls, sprint 11383), empty
- **Acceptance:**
  - [CI] each schema parses its fixtures. Golden outputs match.
  - [CI] fast-check: arbitrary JSON never throws, it gives a typed error.
  - [CI] fake-timer test: never more than 25 requests in any 60 s window or 2 in any 1 s window.
  - [CI] msw test: a 429 with `Retry-After: 5` waits 5 s.
  - [CI] verify **[U]** `pit.lap_number` = in-lap against fixture data and record the result.

### P1b: Schema, ingest and backfill

- **Goal:** every 2023+ session lands in Postgres automatically.
- **Scope in:**
  - migrations for the A§7 tables (minus `recording`)
  - Kysely + kysely-codegen
  - `ingest` role: schedule sync, session state machine (A§8), normaliser in one transaction, raw responses stored
  - `backfill` and `refetch <key>` commands
  - croner with its own busy guard
- **Acceptance:**
  - [CI] integration: ingesting the fixtures yields the expected row counts and nulls stay null.
  - [CI] state machine: `due` at end+35 min, refetch at +3 h/+24 h, then `final`; failures back off and land in `failed` with `last_error`.
  - [CI] re-running ingest is idempotent (row counts unchanged).
  - [CI] a migration file sha256 pin test covers applied files.
  - [box] the backfill completes. Measure its duration and DB size, and write both into A§7/A§8.

### P1c: Timing rules and API

- **Goal:** the server answers everything the v1 views need, with colours already computed.
- **Scope in:**
  - `timing/`: deleted/reinstated parsing (A§9), final-semantics colours, in/out laps, sector deltas, Q-phase derivation
  - the A§10 REST routes (without live/playback) with zod contracts
  - Access JWT middleware
  - `Cache-Control` rules
- **Acceptance:**
  - [CI] both known deleted-lap message forms parse, and a REINSTATED message restores the lap.
  - [CI] a deleted lap is never purple/green and doesn't change anyone's best.
  - [CI] out-laps and in-laps are never purple/green.
  - [CI] a fast-check property: exactly one purple per sector per session (or none if all null).
  - [CI] `/api` without a valid JWT → 401, wrong `aud` → 401, valid → 200 (test keys).
  - [CI] every route's answer parses against its contract.

### P1d: Web shell, lap table and stints

- **Goal:** usable on the phone: pick a session, read laps and stints.
- **Scope in:**
  - Vite + React app, `routeOf` routing, TanStack Query with contract parsing, jitless zod
  - dark and light themes (A§13), the strict-CSP-compatible build (`assetsInlineLimit: 0`)
  - season/meeting/session picker
  - lap table: colours, deleted strikethrough with a tooltip, PIT IN/OUT, compound dots
  - stints view, status panel (`/status`)
- **Acceptance:**
  - [CI] component tests: colour classes, deleted rendering, `—` for nulls with a reason.
  - [CI] the build has no inline scripts/styles and no `data:`/`blob:` URLs.
  - [owner] on a phone: the Singapore 2026 race lap table is readable and the page doesn't scroll sideways.

### P1e: Comparison, mini-sectors and speed traps

- **Goal:** the analysis views.
- **Scope in:**
  - driver multi-select
  - lazy ECharts lap-time chart (canvas, rich-text tooltips, gaps not interpolated)
  - sector-delta table
  - mini-sector grid with the code map (A§6.1) and the race banner
  - speed-trap columns
- **Acceptance:**
  - [CI] sector deltas are skipped when either value is null or the lap is deleted.
  - [CI] unknown segment codes render grey.
  - [CI] ECharts loads only on the compare route (chunk check).
  - [owner] comparing 2 drivers in Austin 2026 qualifying matches the F1 TV timing.

### P1f: Deploy on the VM

- **Goal:** v1 running at the owner's hostname behind Access.
- **Depends on:** P1c (P1d/P1e can ship on top), owner actions A1–A3, A5–A6.
- **Scope in:**
  - Dockerfiles (distroless server, Caddy web, sha256-pinned dbmate)
  - `deploy/compose.yaml` (project `f1`, A§14.2, hardening anchor repeated literally per file)
  - `deploy/host/` with `f1-firewall.service` + `nftables-f1.conf`, `install` script, systemd units (`f1-update`, `f1-tick`)
  - CI `release` job (GHCR `:main` + `:sha-*`)
  - `docs/runbooks/{install,update,cloudflare}.md`
  - healthchecks ping for ingest
- **Acceptance:**
  - [CI] `hardening` test: every service is read_only, `cap_drop: ALL`, no-new-privileges, non-root and has limits; only `127.0.0.1:8180` is published; no `rws` names, subnets or GIDs.
  - [CI] the nftables file passes `nft -c` in a container.
  - [box] `f1-install` is idempotent (a second run changes nothing) and leaves `docker compose -p rws ps` unchanged.
  - [box] from inside `ingest`, port 80 to the internet is dropped and 443 works. From `api`, any egress is dropped.
  - [box] `f1-update` with a broken image rolls back automatically.
  - [owner] the hostname without login → Cloudflare Access page; with the owner's email OTP → the site; another email → denied.
  - [owner] the Waterheight site still works.

### P2-rec: Record the rest of the 2026 season (owner, alongside P0–P1)

- **Goal:** real live-feed data for building P2 over the winter.
- **How:** on the WSL machine or the VM, `python3 -m venv ~/f1rec && ~/f1rec/bin/pip install fastf1==3.9.0`, then `~/f1rec/bin/python -m fastf1 auth f1tv --authenticate`, then `~/f1rec/bin/python -m fastf1.livetiming save <session>.txt` starting 60 min before each session. Start a second file before the first has run 2 h. This is a throwaway tool, outside the repo, so it doesn't conflict with ADR-0006.
- **Minimum:** one practice, one qualifying, one race, and one red-flag or SC session if one happens. All 2026 sprints are already done, so sprint data comes from the archive.
- **Store** in `fixtures-private/live/` (gitignored) and on the VM. Never commit.

### P2a: Live spike (on a 2026 race weekend)

- **Goal:** prove or disprove the live path in TS before building it.
- **Scope in (throwaway code under `spikes/`, deleted afterwards):**
  - TS port of the FastF1 PKCE login (A§12.3)
  - connect to SignalR Core with `@microsoft/signalr` *and* a minimal undici-WebSocket client; pick one
  - subscribe to all topics with and without a token, and list what arrives
  - measure message rate, bytes per hour, reconnect behaviour, and whether the token works for the archive too
- **Deliverables:** an amended A§11 and an ADR-lite for the client choice. A go/no-go. On no-go, ADR-0005/0006 are revisited, with OpenF1 Sponsor (€9.90/month) as the fallback.
- **Acceptance:**
  - [weekend] a full session is recorded with the TS client.
  - [owner] the login succeeds without manual steps, or the fallback is documented.

### P2b: Feed parser, state model and lap reconstruction

- **Goal:** deltas → typed state → `lap`/`stint` rows, from recordings or archive files.
- **Scope in:**
  - topic merge (index-keyed arrays, partial objects)
  - typed state for DriverList, TimingData, TimingAppData, TimingStats, SessionInfo, SessionStatus, TrackStatus, LapCount, RaceControlMessages, ExtrapolatedClock, WeatherData
  - lap reconstruction (port of FastF1 logic, with its MIT notice kept)
  - progressive colours
  - a reader for archive `.jsonStream` (token from P2a) to get winter test data
- **Acceptance:**
  - [CI] merge property (A§15).
  - [CI] synthetic fixtures cover reconnect duplicates and a full-state `R` message.
  - [box] for 3 recorded or archived 2026 sessions, the reconstructed laps match OpenF1 laps: lap and sector times within 1 ms on ≥ 99% of laps, with differences listed.

### P2c: Recorder role and token management

- **Goal:** unattended recording of every session.
- **Scope in:**
  - `live` role: schedule from `session`, connect −60 min / disconnect +30 min, reconnect with backoff, raw `feed.jsonl.gz` + 30 s snapshots, `recording` table
  - login + token cache + expiry checks
  - status panel fields, healthchecks `f1-live`
  - compose service + secrets (A4)
- **Acceptance:**
  - [CI] a fake SignalR server test covers connect, subscribe, a drop after N minutes, reconnect, no lost lines and duplicates tolerated.
  - [CI] token expiring within the session window → login first. Login failure → status error, no crash loop.
  - [CI] no log line contains the token or password (log-capture test).
  - [box] a scheduled test session (the next practice) is recorded completely.

### P2d: Playback API

- **Goal:** "state at T" over SSE for live and replay.
- **Scope in:**
  - `/live`, `/playback/:id/stream?at|live&delay&speed`
  - snapshot seek, delta streaming, heartbeat comments, back-pressure (drop to snapshot if the client lags)
- **Acceptance:**
  - [CI] the state at T from snapshot + deltas equals a full replay from 0 (property over a fixture).
  - [CI] `live&delay=45` never emits an event newer than now − 45 s.
  - [CI] SSE is closed after a client disconnect (no leak).

### P2e: Live and replay UI

- **Goal:** follow a session next to the F1 TV app.
- **Scope in:**
  - live timing tower
  - the lap table reused on the stream
  - delay slider 0–120 s (±1/±5/±30 s), play/pause/seek, session markers
  - token/recorder warnings
  - recordings list → replay
- **Acceptance:**
  - [CI] component tests for the slider and the reconnect on change.
  - [owner] replaying a recorded 2026 race in sync with the F1 TV replay: after one slider adjustment, timing and video stay within ±2 s for 10 min.

### P2f: Live on the VM

- **Goal:** live in production.
- **Acceptance:**
  - [weekend] 2027 pre-season testing or the first race weekend: every session is recorded automatically, the live view runs with a delay on the phone for a full session, and the replay works afterwards.
  - [box] measure resources and update A§14.2.

### P3a: History 2018–2022 from the F1 archive

- **Goal:** older seasons in the same views.
- **Scope in:**
  - `archive` job: Index.json walk → `.jsonStream` downloads (token, polite rate) → P2b parser → `lap`/`stint`/… rows with `source='f1-archive'`
  - raw files kept under `/srv/f1/archive`
- **Acceptance:**
  - [CI] the importer runs on synthetic archive fixtures.
  - [box] a 2019 race and a 2021 qualifying render in all v1 views. Spot-check 10 laps against FastF1 output.

### P3b: Fill OpenF1 gaps from the archive (optional)

- Use the archive or recordings where OpenF1 has nulls for 2023+, and mark the source per value. It's done if the Singapore 2026 race has fewer `—` cells than before.

### P3c: Pre-2018 lap times from Jolpica (optional)

- Lap times only, no sectors. The views hide the sector columns for these sessions.

## 4. Owner actions

| # | Action | Needed by |
|---|---|---|
| A0 | Approve this plan | P0 |
| A1 | Resize the Waterheight VM to 6 vCPU / 12 GB | P1f |
| A2 | Choose the hostname on your Cloudflare zone. Create a tunnel, put its token in `/etc/f1/secrets/cf_tunnel_token`, and route the hostname → `http://caddy:80` | P1f |
| A3 | Cloudflare Zero Trust: Access application for the hostname, allow policy = your email, one-time PIN login. Put the team domain + AUD tag into `/etc/f1/f1.env` | P1f |
| A4 | Put the F1 TV email and password in `/etc/f1/secrets/f1tv_username` / `f1tv_password` | P2a (spike: locally), P2c (VM) |
| A5 | GitHub: GHCR packages public, branch protection on `main`, Dependabot on | P0 / P1f |
| A6 | healthchecks.io: create `f1-ingest` and `f1-live` and put the ping key in a secret file | P1f / P2c |
| A7 | Record the remaining 2026 sessions with FastF1 (P2-rec) | Mexico City onward |

## 5. First task

**P0: Foundation.** Open the issue from §3, then branch `claude/p0-foundation`. Copy the gotchas section and the tsconfig/biome/vitest/pnpm policy setup from Waterheight (adjusting names `rws` → `f1`), and verify each pin against the 7-day release-age rule.
