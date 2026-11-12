# Phases: F1 Timings

Status: approved by the owner (2026-10-25). It builds on `ARCHITECTURE.md` (cited A§x). Each phase becomes one GitHub issue (template from P0) and one or more PRs.

## 1. Timeline

| Window | Phases | Why then |
|---|---|---|
| Now → mid Nov 2026 | **P0**, **P1a–P1c**, **P2-rec** (owner, alongside) | Foundation and data first. Record live feeds while the 2026 season still runs |
| Nov 2026 | **P1d–P1f**, **P2a** spike (Las Vegas 20–22 Nov or Lusail 27–29 Nov; Yas Marina 4–6 Dec is the last chance) | v1 live on the VM. The live connection has to be proven while sessions still happen |
| Dec 2026 → Feb 2027 | **P2b–P2e** | No sessions; build on the recordings and archive files |
| Las Vegas 20–22 Nov 2026 (fallbacks: Lusail 27–29 Nov, Yas Marina 4–6 Dec) | **P2f** | Live verified on a real session |
| Nov 2026 → Jan 2027 | **P4a–P4f** | The redesign (owner, 2026-11-07): web only, on the API as it is, so it can run next to P2f and the last 2026 weekends |
| Nov 2026 → Jan 2027 | **P5a–P5c** | Weather (owner, 2026-11-07), next to P4. P5c's live check needs a session (Lusail 27–29 Nov or Yas Marina 4–6 Dec 2026, else 2027 testing) |
| Nov 2026 → Jan 2027 | **P6a–P6c** | Team radio (owner, 2026-11-09), next to P4 and P5. P6a's live check needs a session (Las Vegas 20–22 Nov, else Lusail or Yas Marina). P6b and P6c start only after their gate checks |
| After P2 | **P3a–P3g**, then **P7** | History (owner, 2026-11-10): the F1 archive from 2018 (every topic, 2023 on as files only), Jolpica 1950–2017, the FIA PDFs from 2012, the sources combined, old-season views; then telemetry. P3d's probes come first |

Remaining 2026 weekends (OpenF1 schedule): Austin (race 25 Oct) · Mexico City 30 Oct–1 Nov · São Paulo 6–8 Nov · Las Vegas 20–22 Nov · Lusail 27–29 Nov · Yas Marina 4–6 Dec.

## 2. Criterion tags and workflow

- **Tags:**
  - **[CI]** is proven by a test or check in CI.
  - **[box]** is checked on the VM with a command the PR supplies.
  - **[weekend]** needs a real F1 session.
  - **[owner]** is a manual owner action or judgement.
- **Per phase:** one issue with the goal, scope, deliverables and acceptance criteria copied from this file. Branch `claude/p<N><x>-<slug>`, conventional commits, and a PR with an evidence checklist (each criterion → test or command output). Agents never merge. The owner merges with a merge commit once `ci` and `security` are green (branch protection on `main` requires both; owner, 2026-10-25).
- **Reviews:** a fresh-session `/code-review` before merging P1b, P1c, P2b, P2c, P2d, P4e, P5a, P5b, P5c, P6a and P6b. A security review for anything touching secrets, the firewall, Access, the token or the compose hardening (P0 CI, P1f, P2c), for P5c (a new outbound host in the `ingest` daemon and third-party map data in the page), for P6a (a new outbound path in the recorder, a file-serving route and a CSP change), and for P6b (a new container, C++ parsing third-party MP3 files, a host download script and a new route), for P3f (a new outbound host, `fia.com`, and a parser for third-party PDF files) and for P7 if it adds a route over a large table (owner, 2026-11-10). A fresh-session `/code-review` also before merging P3b, P3c, P3e and P3f. For the web-only P4 phases a Sonnet security review is recommended where more feed or URL text is parsed or rendered (P4d, P4e, P4f), and optional elsewhere unless the CSP or the build config changes.
- **Models and effort** (owner, 2026-10-25; each phase issue has its own table):
  - Build: Opus 5.5 at `xhigh` (`high` for UI and well-specified phases, `max` for P2b's lap reconstruction). Sonnet 5.5 at `high` for small phases (P2f, P3d).
  - Code review: a fresh session with a different model from the build. Sonnet 5.5 at `xhigh` for required reviews and `high`/`medium` otherwise; Opus 5.5 when Sonnet built.
  - Security review: a fresh Opus 5.5 session at `xhigh` when required; Sonnet 5.5 otherwise.
  - Fable 5.1 is never the default (cost and usage limits). It is only an escalation: one more review when a fix round still leaves a High or Critical finding, or a [CI]/[box] bar is still missed after one fix round.
  - GitHub chores (issues, labels, PR text): Haiku 5.5 at `low`.
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
- **Depends on:** P1c (P1d/P1e can ship on top), owner actions A1–A3, A5–A6, A8.
- **Scope in:**
  - Dockerfiles (distroless server, Caddy web, sha256-pinned dbmate)
  - `deploy/compose.yaml` (project `f1`, A§14.2, hardening anchor repeated literally per file)
  - `deploy/host/` with `f1-firewall.service` + `nftables-f1.conf`, `install` script, systemd units (`f1-update`, `f1-tick`)
  - CI `release` job (GHCR `:main` + `:sha-*`)
  - `docs/runbooks/{install,update,cloudflare}.md`
  - healthchecks ping for ingest
  - the `api`'s own egress-only network, shared with no other service, so it can reach tcp/443 on Cloudflare's published ranges (the Access certs), plus that nftables set (A§14.3, owner 2026-10-26; a P1c follow-up). Port 8080 is never published, and Caddy↔api stays on the internal `f1-edge`
- **Acceptance:**
  - [CI] `hardening` test: every service is read_only, `cap_drop: ALL`, no-new-privileges, non-root and has limits; only `127.0.0.1:8180` is published; no `rws` names, subnets or GIDs.
  - [CI] the nftables file passes `nft -c` in a container.
  - [box] `f1-install` is idempotent (a second run changes nothing) and leaves `docker compose -p rws ps` unchanged.
  - [box] from inside `ingest`, port 80 to the internet is dropped and 443 works. From `api`, only tcp/443 to Cloudflare's published ranges works (the Access certs, A§14.3, owner 2026-10-26); any other egress is dropped.
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
  - [CI] synthetic fixtures cover reconnect duplicates and the `Subscribe` completion's full state.
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
  - [weekend] Las Vegas 20–22 Nov 2026 (owner, 2026-11-06; fallbacks Lusail 27–29 Nov and Yas Marina 4–6 Dec 2026): every session is recorded automatically, the live view runs with a delay on the phone for a full session, and the replay works afterwards.
  - [box] measure resources and update A§14.2.

### P3: History (owner, 2026-11-10)

- **Research** (2026-11-10, A§6.2 and A§6.3; sources and licences in ADR-0009): the F1 archive starts in 2018 as far as anyone has shown. FastF1's maintainer says lap timing is not on the F1 API before 2018. Without a token every year answers 401, even 2099, so only a probe with the token can show whether 2017 or earlier exists. Before 2018 no public source we found has per-lap sectors, mini-sectors or per-lap speed traps:
  - Jolpica has race lap times from 1996, pit stops from 2011, results from 1950 and qualifying from 1994.
  - The FIA timing PDFs (2012 on) have every lap of every session, each driver's best sectors, the speed-trap top 10, maximum speeds, the pit stop summary, the classification and the lap chart.
  - formula1.com's results pages are out: its guidelines bar text and data mining.
- **Decisions** (owner, 2026-11-10):
  - **H1, how far back:** the archive from 2018. Before that, Jolpica race laps 1996–2017 and pit stops 2011–2017, and the FIA PDFs 2012–2017. P3d checks by hand whether F1 TV serves anything older.
  - **H2, 1950–1995:** results only (classification, grid, and qualifying times from 1994), from Jolpica, in a results view.
  - **H3, 2023 on:** the archive job downloads the files only. The rows stay OpenF1's (ADR-0001).
  - **H4, topics:** every topic the archive has, telemetry included (`CarData.z`, `Position.z`).
  - **H5, testing:** pre-season testing sessions are imported like the other sessions.
  - **H6, precedence:** when several sources have the same value, it comes from the first in this order. Every difference is logged.
    - 2018–2022: archive > FIA > Jolpica.
    - 2023 on: OpenF1 > archive > FIA > Jolpica (the archive only fills OpenF1's nulls, as P3b first planned).
    - 2012–2017: FIA > Jolpica (Jolpica is the cross-check).
  - **H7, source marking:** per value, so a filled cell can be marked in the view.
  - **H8, broken 2018 sessions:** import what parses and show `—` for the rest. P3d first looks for a better source for the gaps: the archive's other files, and the F1 TV app's data screens. Then the sources are combined (H6).
  - **H9, F1 TV data screens:** only JSON that the F1 TV app itself fetches counts, found by the owner in the browser. Never video, OCR or anything that gets around DRM (the P6 rule).
  - **H10, FIA PDFs are treated like F1 TV data** (A§12.1 invariants 3 and 4):
    - never committed, and the parser fixtures are synthetic;
    - the raw PDFs are kept under `/srv/f1/fia`, or in `fixtures-private/fia/` on the owner's machine;
    - CI never calls `fia.com`.
  - **H11, FIA documents:** lap times and the history chart, best sectors and speed traps, the pit stop summary, the classification and the lap chart.
  - **H12, Jolpica:** imported from its CSV dump, not the API. The free dump is about 14 days behind, which does not matter for finished seasons.
  - **H13, old-season views:** the views hide per-lap columns a session has no data for, and add a panel with the session's bests (best sectors and top speeds).
  - **H14, measure first:** the first full archive download (all topics, telemetry included) runs on the owner's machine for one season and measures size, time and RSS. The caps and the VM run come after.
  - **H15, telemetry:** it gets its own phase (P7), after P3e.
  - **H16, order:** the probes first (P3d), then P3e, P3c, P3f, P3b and P3g. P7 comes after P3e (owner decision D1, 2026-11-12: the P3b merge core comes before P3c; P3b is two PRs).
- **Related issues:**
  - #96 (pit-lane topics, its topic check) and #126 (2018 compound names) take facts from P3d;
  - #122 is P7;
  - #123 (standings) can take Jolpica's standings from 1950 once P3c is in.
- **Keys for sessions without one** (Jolpica and FIA before 2018; a proposal, P3c confirms and records it in A§7):
  - The keys are derived in a reserved range that collides with neither the archive (session keys under 7,200 through 2021) nor OpenF1 (7,763 on).
  - `meeting_key = 1YYYYRR` (7 digits) and `session_key = 1YYYYRRTT` (9 digits, within the API's `^\d{1,9}$`). `TT` is a fixed code per session type.
  - FIA and Jolpica derive the same key for the same session, so they meet in one row.
  - From 2018, FIA and Jolpica rows attach to the archive's or OpenF1's session, matched by year, round and type.

### P3a: History 2018–2022 from the F1 archive

- **Goal:** older seasons in the same views.
- **Scope in:**
  - `archive` job: Index.json walk → `.jsonStream` downloads (token, polite rate) → P2b parser → `lap`/`stint`/… rows with `source='f1-archive'`
  - raw files kept under `/srv/f1/archive`
- **Acceptance:**
  - [CI] the importer runs on synthetic archive fixtures.
  - [box] a 2019 race and a 2021 qualifying render in all v1 views. Spot-check 10 laps against FastF1 output.

### P3d: Probes (gate for P3e–P3g; owner, 2026-11-10)

- **Goal:** settle the [U] facts that the P3 decisions rest on, before building on them.
- **Scope in:**
  - `scripts/archive-probe.ts --token-file <path> [--from 2011] [--to 2017]`: an owner-only script (it refuses under `CI`), on the `fetch-archive.ts` pattern. It asks for `static/<year>/Index.json` per year, at least 2 s apart, and prints only the year, the HTTP status, and with a 200 the number of meetings and sessions. It never prints a body, a URL or the token. 2018 is the control: its 200 proves the token.
  - [box] the 2018 gaps: for the sessions FastF1 reports as broken, find out which other archive files fill what the 10 P3a topics leave empty: the final `.json` states, `TyreStintSeries`, `CurrentTyres`, `LapSeries`, `DriverRaceInfo`, `TimingStats` and `PitLaneTimeCollection`. The sessions:
    - the Italian GP race (phantom stints, FastF1 #930);
    - Azerbaijan (tyre data, #863);
    - Australia FP2 (almost no position data, #677).

    Counts per topic and per field only, through `feed-keys.ts`.
  - [owner] the F1 TV data screens (H9): the owner opens one of those 2018 sessions and one pre-2018 replay in the F1 TV web app with the browser's developer tools. They note which JSON requests the data screens make, by host, path pattern and topic names, never a body or a token. Video does not count.
  - [box] testing sessions: which years' Indexes list pre-season testing, and with which topics.
  - [box] the per-session `Index.json` (FastF1 says it exists from the 2018 US GP FP1): the full topic list per year, as the input to P3e's topic list. This shares #96's topic check (its `--topic` option on `fetch-archive.ts`): whichever lands first, the other reuses it.
  - [box] the 2018 tyre names in `TimingAppData` over every 2018 session, for #126.
- **Acceptance:**
  - [CI] the probe script's argument checks, the `CI` refusal and its output on msw fixtures (statuses only).
  - [box] the probe's output for 2011–2018 and the 2018-gap counts are written into A§6.2, and the F1 TV findings into A§6.3. If F1 TV serves pre-2018 timing, the owner decides before P3e whether H1 changes.

### P3e: Every topic, 2018 to now (owner, 2026-11-10)

- **Goal:** the most complete raw archive (H3, H4, H5), plus rows for the 2018–2022 testing sessions.
- **Scope in:**
  - `archive` job topics: every topic in the session's own `Index.json`. Before the 2018 US GP it has none, so the job uses the list P3d measured. 403 and 404 leave a marker as now.
  - The CLI accepts 2018 to the current year. For 2023 on it downloads files only and writes no rows (H3), and it never downloads during the live window, as now.
  - **Raw-only topics** (telemetry, `TeamRadio`, `ContentStreams` and any topic no row reads) are never parsed. Their file cap is set from P3e's own measurement, and the 16 MiB session cap counts parsed topics only.
  - **Testing:** testing sessions from 2018–2022 get rows. The session type and the views' handling of a testing day follow from P3d. Testing from 2023 on is already OpenF1's.
  - [box] H14: one full season on the owner's machine first (`--dir …/fixtures-private/archive`): bytes per topic and per session type, time, and peak RSS. Then the A§14.1 disk budget, the caps and the VM run.
- **Acceptance:**
  - [CI] the topic list, the raw-only rule, the year range and files-only for 2023 on, on synthetic fixtures.
  - [box] the measured season is in A§6.2; 2018 to now is downloaded on the VM with `failed: 0` per year, or each failure is listed with its code.

### P3c: Jolpica, 1950–2017 (owner, 2026-11-10)

- **Goal:** race lap times 1996–2017, pit stops 2011–2017, and results from 1950 (qualifying from 1994) in the site (H1, H2, H12).
- **Scope in:**
  - an owner-run `jolpica` import from the CSV dump (`api.jolpi.ca/data/dumps/download/`), never from CI. The dump is kept under `/srv/f1/jolpica` and never committed (CC BY-NC-SA 4.0, ADR-0009). Rows get `source = 'jolpica'`.
  - the derived keys (P3 decisions) and the A§7 changes: the `source` CHECK, and `date_start` for old sessions, which the dump may give only as a date ([U]).
  - from 2018 on, Jolpica is the third source (H6): it cross-checks and fills what the archive and FIA leave empty.
  - its lap rows go through `writeLaps` (P3b), as the `jolpica` candidates; it appends `jolpica` to the merge `ORDER` with the CHECK migration.
- **Acceptance:**
  - [CI] the importer on a synthetic dump: the keys, a race with laps, a pit stop, a results-only 1950 race and a qualifying with Q1–Q3.
  - [box] counts per season, 1950–2017, against the dump's own counts. The laps for every 1996–2017 race the dump lists. 10 laps of a 2017 race spot-checked against its FIA PDF.

### P3f: FIA timing PDFs, 2012 on (owner, 2026-11-10)

- **Goal:** lap times for every session from 2012, plus per-session bests and pit stops (H1, H10, H11).
- **Scope in:**
  - an owner-run `fia` job: it walks the `fia.com/f1-archives` event pages per season, downloads the timing PDFs at a polite rate, keeps them under `/srv/f1/fia/<year>/<event>/`, parses them and writes rows with `source = 'fia'`. It is resumable like the archive job.
  - parsers for the history chart and lap analysis (lap times), best sectors, the speed trap and maximum speeds, the pit stop summary, the classification and the lap chart. Where the Race Sector Analysis exists (seen from 2023), it also gives per-lap sectors.
  - its lap rows go through `writeLaps` (P3b), as the `fia` candidates; it appends `fia` to the merge `ORDER` with the CHECK migration.
  - a table for the per-session bests (best sectors and top speeds), which has no home in `lap`.
  - a PDF text library, with an ADR-lite line, or a hand-rolled reader. Decided in the phase.
- **Acceptance:**
  - [CI] each parser on synthetic PDFs built in the tests; never a real FIA file (H10).
  - [box] every 2012–2017 event: the laps per session against Jolpica's laps for the races (differences listed). The 2018–2022 laps against the archive (differences listed). Which seasons and documents are missing.

### P3b: Combine the sources (owner, 2026-11-10)

- **Goal:** one row per lap from every source, by the H6 order, with the source per value (H7, H8).
- **Two PRs** (owner decision D1, 2026-11-12; issue #17, PR 1 says "Part of #17"):
  - **PR 1:** the store, the marking, the merge on every lap write, the OpenF1, archive and recording tiers, the `fill` job, and the [box] on the Mexico race 11404.
  - **PR 2:** after P3d, P3c and P3f. It adds their tiers (`fia`, `jolpica`), the archive's other files where P3d found they help, the Singapore [box] and the 2018 [box]. P3c and P3f write their 2018+ laps through `writeLaps`.
  - **The Singapore [box] moves to PR 2** (owner decision, 2026-11-12). The archive fills none of the Singapore 2026 race's (11388) `—` cells: our parser follows OpenF1's rules, so both build the same laps from the same feed (A§7, [box] P3b PR 1). FIA and Jolpica lap times can fill its empty lap times. Its empty speed traps are a follow-up issue.
- **Owner decisions** (2026-11-12):
  - **D2, storage:** a candidate table `lap_source` per (session, driver, lap, source), each writer replaces only its own rows and `lap` is rebuilt per session; `lap.filled` is `{column: source}`.
  - **D3, conflicts:** a higher value always stays; a lower source fills nothing on a lap where a lap or sector time both have differs by more than 1 ms; a lap the higher source lacks is added from the next source.
  - **D4, recordings:** they come after the archive (`openf1` > `f1-archive` > `f1-live`, then `fia` and `jolpica` in PR 2), and only a session's `complete` recording fills (#95).
- **Scope in:**
  - a migration for the per-value source, so the view can mark a filled cell: `lap_source` and `lap.filled` (A§7).
  - the merge for 2018 on: OpenF1 or the archive first, then the archive's other files where P3d found they help (PR 2), then FIA, then Jolpica (PR 2). Every difference is logged as counts per session and field.
  - recordings fill OpenF1 nulls too, as first planned (complete ones only, D4).
  - PR 1: the owner-run `fill` job (A§4, A§14.2), which builds the archive and recording candidates from local files and merges again.
- **Out of PR 1:**
  - `stint`, `pit` and `result` are not merged (the scope is per lap).
  - No API change: #132 exposes `filled`.
  - No automatic fill: the owner runs `fill`. A timer can come when P3e downloads the 2023+ files.
- **Acceptance:**
  - [CI] the order and the marking per value on fixtures where the sources disagree.
  - [box] a 2023+ session with an OpenF1 live-ingest hole has fewer `—` cells than before, and they survive a refetch (PR 1: the Mexico race 11404). The Singapore 2026 race has fewer `—` cells than before, and so does each 2018 session P3d found broken (PR 2).

### P3g: Old-season views (owner, 2026-11-10)

- **Goal:** the views work for every era (H2, H7, H13).
- **Scope in:**
  - per-lap columns (sectors, mini-sectors, traps, stints) are hidden where a session has no data for them;
  - a bests panel: best sectors and top speeds per driver, from P3f;
  - a results view for 1950–1995;
  - a filled cell is marked with its source;
  - the season list reaches back to 1950.
- **Acceptance:**
  - [CI] component tests for a 1950 race, a 2005 race (Jolpica laps only), a 2014 qualifying (FIA), a 2018 race with filled values, and a 2023 testing day.
  - [owner] the same five sessions look right on the phone.

### P4: Redesign (owner, 2026-11-07)

- **Source:** the design review in `docs/design/2026-11-redesign/`: the README with proposals R1–R10, the renders, and the mock-up whose CSS (`mockup/app.css`) and markup (`mockup/screens.mjs`) show each screen. The owner kept all ten proposals on 2026-11-07, including the four that change an A§13 rule: R1 (`/`), R4 ("other" times as plain text), R6 (the Fit window as the chart's default) and R10 (state in the URL).
- **Rules for every P4 phase:**
  - Web only: the API, the contracts, the CSP and the images stay as they are (A§10 already serves `/pits` and `/race-control`).
  - The mock-up is a reference for the look and the behaviour, not code to copy. Keep the app's patterns: React components, pure functions with unit tests, contract parsing, and only custom properties from React. Keep the theme switch on `prefers-color-scheme`; the mock's `data-app-theme` exists only for the review page.
  - Each phase amends A§13 for what it changes, marked "(owner, 2026-11-07)", and keeps every rule it does not name.
- **Order:** P4a first. Then P4b and P4c, one after the other (both change `views/Session.tsx`). P4d after P4a, P4e after P4d, P4f after P4b.

### P4a: Design system and accessibility base (R9, R5)

- **Goal:** one token, type and shape system for the other P4 phases.
- **Scope in:**
  - tokens in `apps/web/src/styles.css` from `mockup/app.css`: surfaces (`--bg`, `--panel`, `--raised`), lines, `--fg`, `--muted`, `--dim`, the timing colours (light-theme green `#0f7553`), `--live` (live, a red flag or a failure only), `--amber` (SC and VSC), the mini-sector "other" fill and the heat steps; no brand accent
  - type scale: one label style (12 px, bold, upper case, +0.06 em, `--muted`) for table heads, eyebrows and strip labels; body and tables 14 px, the tower 15 px, titles 26 px, nothing under 11 px; a display stack of installed fonts (`"DIN Alternate", Bahnschrift, system-ui`) for titles and the clock, no font file
  - team colours on the light theme: a copy darkened (hue kept) to at least 3:1 on `--bg`, set by `teamStyle()` as a second custom property
  - mini-sector shapes (Mini-sectors and the tower): overall best full height with a ring (an outline, not a box-shadow), personal best full height, pit lane full height and hatched, other and unknown half height, no data a dashed outline; the legend shows the shapes
  - focus: a 3 px `:focus-visible` outline (inset inside `.scroll`); every `.scroll` box a focusable, named region (`tabIndex=0`, `role="region"`) with `scroll-padding` clear of its sticky header and columns
  - `@media (forced-colors: active)` rules for the mini-sectors, markers, compound dots and pressed buttons; cues drawn with box-shadow move to outline or border
  - screen-reader words: a `.vh` class, ", overall best" and ", personal best" on coloured values, the compound dot `aria-hidden` with its words beside it
- **Scope out:** each view's layout (P4b–P4f).
- **Acceptance:**
  - [CI] the contrast test checks every text token on `--bg`, `--panel` and `--raised` in both themes (≥ 4.5:1) and the mini-sector fills on `--bg` (≥ 3:1).
  - [CI] a property test (fast-check): the light-theme clamp reaches 3:1 on `--bg` for any six-digit colour and keeps its hue.
  - [CI] a colour-separation test: purple, green and plain text are ≥ 15 ΔE (OKLab × 100) apart for normal vision and ≥ 8 under simulated deuteranopia and protanopia, in both themes.
  - [CI] component tests: the mini-sector class per code, the screen-reader words, focusable named scroll regions.
  - [CI] the build test still finds no inline style or script and no `data:` or `blob:` URL.
  - [owner] on a phone and a laptop, both themes match `docs/design/2026-11-redesign/renders/` in feel.

### P4b: Session views: lap table, tiles and qualifying (R4, R3)

- **Goal:** the session page points at the bests and reads qualifying by phase.
- **Scope in:**
  - lap table (A§13 amended): "other" values in plain text (already landed in P4a: owner, 2026-11-07, O1); purple keeps its box with a light tint, green stays bold; in- and out-laps dimmed with IN (OUT only where no compound chip starts the stint); a stint rule beside the compound chip; SC, VSC and red-flag laps banded in the lap header from `/sessions/:key/race-control`; the driver and Best columns frozen; a "Δ to own best" view per metric with a one-hue step behind the value (in, out, deleted and neutralised laps show the word instead)
  - `trackPeriods()`, a pure function from race-control rows to SC, VSC and red-flag periods in laps; a message without a lap number is listed, never banded
  - session tiles on the Laps tab: fastest lap, best S1–S3, the sum of best sectors (so named, never "ideal lap"), top speed (speed trap), each with its holder and lap, `—` with a reason when absent; for qualifying: pole and each phase's cut-off
  - qualifying and sprint qualifying, a "By phase" view: each driver's best valid lap per phase from `quali_phase`, the phase's fastest boxed purple, the margin to that phase's cut-off (inside or out), labelled knock-out lines, Δ to pole and timed laps; the number that went through comes from the data (who set a time in the next phase), so 20- and 22-car fields both work; "Every lap" keeps today's table
- **Scope out:** compare and stints (P4f), the live tower (P4d).
- **Acceptance:**
  - [CI] unit tests: `trackPeriods` (SC, VSC, red, overlapping periods, a null lap number), the sum of best sectors, the cut-offs and margins (20 and 22 cars, a driver without a time, a deleted lap), the Δ steps.
  - [CI] component tests: plain "other" text with purple boxed and green bold, the frozen columns, the VSC header band, a tile's `—` with its reason, the knock-out lines.
  - [box] the race-control forms `trackPeriods` relies on are counted over every 2023–2026 race with a query the PR supplies, and written into A§6.1.
  - [owner] Mexico City 2026 qualifying by phase matches the F1 TV classification.

### P4c: Wayfinding and a spoiler-safe start (R7, R1)

- **Goal:** any session in two taps, without seeing a result first.
- **Scope in:**
  - `/` (A§13 amended): `/live` while a recording is open, else the newest season's page; never a lap table in result order
  - the season page: "This weekend" first (the meeting in progress, else the next one), each session with Amsterdam time, the track time beside it and its state in words (laps ready, recorded with a Replay link, live now with a Follow link, next, scheduled, cancelled struck through); an "Up next" countdown; the rest of the season as cards; no result anywhere on the page
  - the header and the session head: a breadcrumb switcher (season, meeting, session) with previous and next session; an eyebrow (year, round, place), the meeting as the h1 with a boxed session tag; the weekend's sessions as pills that keep the current tab; a Replay link when the session has a recording
  - the round number only where it can be derived: the count of non-cancelled meetings with a race session up to this one, so testing never counts
  - routes: `/replay` lists the recordings (`/live` links to it); the season switcher as year links in a popover, not a `<select>`
  - `document.title` per route; after an in-app navigation, focus moves to the h1; the Live and Status links stay mounted with `aria-current`
- **Scope out:** the pit wall and the player (P4d, P4e).
- **Acceptance:**
  - [CI] unit tests: the `/` decision (an open recording, a season with and without a started session, no seasons), the weekend choice and the session states (inside a weekend, between weekends, after the last race, a cancelled session), the round numbers.
  - [CI] the season page renders no result: no position, time or gap.
  - [CI] the title for every route.
  - [owner] on a phone, any 2026 session is two taps from `/`, and nothing shows a result before a session is opened.

### P4d: The pit wall (R2, R3)

- **Goal:** the live and replay screen tells the story of the session at a glance.
- **Scope in:**
  - a status strip above the tower: the session light, the lap, the time left (counting down locally while `Extrapolating`), the weather, and the latest race-control message (text only)
  - the session light (owner, 2026-11-07) at the front of the strip: red, yellow and green lamps in fixed positions, the lit one named in words (Track clear, Yellow flag, Safety car, VSC, VSC ending, Red flag, Stopped, Chequered flag, Not started, or "Track status unknown" for a code it does not know), from `SessionStatus` and `TrackStatus`; while a session runs, the tab title starts with the same word
  - beside the tower (below it on a phone): race control up to T, newest first, with category filters and counts; "within a second" pairs from the intervals (races only); the fastest lap so far
  - the tower: "Leader" instead of the leader's lap count; places since the start (`GridPos`) as ▲ or ▼ with a number, in `--fg` and `--muted`, never green or red; the sector time over its mini-sector strip (6 × 8 px, the P4a shapes) with a legend; tyre with age and new or used; IN PIT and OUT tags; a tap on a driver focuses that row
  - [U] the tower per session type: the practice and qualifying gap and interval fields (reportedly `TimeDiffToFastest`, `TimeDiffToPositionAhead`, and `Stats` per qualifying part) checked on a recording, typed in `packages/contracts/src/live.ts`, `—` with a reason where a gap does not exist
- **Scope out:** the player bar (P4e).
- **Acceptance:**
  - [CI] unit tests on synthetic states: the strip (clear, SC, VSC, red), race control by T and category, the within-a-second pairs, places since the start.
  - [CI] the session light for every `TrackStatus` code, an unknown code and the `SessionStatus` values (not started, stopped, finished), each with its word; the tab title's prefix while a session runs.
  - [CI] the tower fills Gap and Int for synthetic practice, qualifying and race lines.
  - [CI] feed text renders as text only: a message holding markup stays text.
  - [box] the practice and qualifying gap fields are checked on a real recording with a command the PR supplies, and the fact is written into A§11.
  - [owner] in a replayed 2026 race, the strip, the panel and the tower agree with the F1 TV graphics.

### P4e: The player (R2, R1, R10, R5)

- **Goal:** one control model around T, nothing ahead of T, and a reload that comes back where you were.
- **Scope in:**
  - one control model (A§13 amended): every nudge moves T, so −5 is always earlier; live, −5 adds 5 s of delay and +5 takes 5 s away (never below 0); a compact cluster on wide screens and the equal row on a phone; a clock line in the bar (T, the time left, the lap, and the mode: LIVE with its delay, or replay playing or paused); "Delay not set" while live at 0 s
  - only the past (A§13 amended): seek-bar markers by shape (a tall tick for the start, a band for SC, VSC or red from its start to its end, left open up to T while it lasts, a checker for the chequered flag); "Back to" chips that seek to markers already seen and to the focused driver's last stop; no forward jump anywhere
  - after a forward seek, one dismissible line of what was skipped (SC and VSC periods, stops, deleted laps, incidents), never a modal and never anything after T
  - a paused seek shows a still frame (A§13 amended): after the debounce, open the stream at T, render its snapshot and close it, one at a time
  - state in the URL (A§13 amended): `/replay/:recording?t=HH:mm:ss` (Amsterdam clock) kept with `replaceState` on pause, on seek and every 15 s; loading it opens paused at t ("Resumed at 21:44:05: press Play when the video is there"); a bad or out-of-range `t` is ignored
  - an opt-in "Announce events" toggle feeding one polite live region (track status, the start and the finish, a new overall best, one line after a seek), at most one line per 5 s; while playing, the seek bar's `aria-valuetext` changes per minute
- **Scope out:** the compare picks in the URL (P4f).
- **Acceptance:**
  - [CI] component tests (happy-dom, like `player.test.tsx`): the nudge direction live and in replay; no forward jump control; markers and chips only at or before T; the skipped-events line; a still frame opens and closes exactly one stream; `?t` parsing and writing (a recording across midnight, garbage, out of range); announcements throttled.
  - [CI] the existing player tests (one stream at a time, reconnect, watchdog) still pass.
  - [owner] the P2e sync test again: after one adjustment a replayed 2026 race stays within ±2 s of the F1 TV replay for 10 min, and a reload resumes paused at the same T.

### P4f: Compare and stints (R6, R8, R10)

- **Goal:** Compare explains the race, and stints read on a real lap scale.
- **Scope in:**
  - the picker: picked drivers as chips with the reference named, "Add driver" opening the full chip grid, a Reference choice above the deltas; the picks in the URL (A§13 amended: `?d=3,63`, pick order, the first is the reference), kept by the Compare and Mini-sectors links
  - the lap chart (A§13 amended): a Fit window (the picked drivers' fastest valid lap − 1 s, floored, to + 3 s) with the 107 % window as a toggle; laps above the window as triangles on the top edge with their value in the tooltip; each driver's own best as a ringed dot; deleted laps hollow (10 px); `showAllSymbol: true` and no symbol on ordinary laps, so no marker is ever thinned away; SC, VSC and red bands from `trackPeriods()` (P4b); line keys in the legend; end labels in `--fg` that never collide; whole-second ticks; a tooltip with the value first, then Δ to the reference, the compound and flags; the next line type whenever two team colours are within ΔE 15 (8 colour-blind) after the light clamp, not only when they are equal
  - a gap chart per driver to the reference from the laps' own line crossings (`date_start`, nothing interpolated), with the same bands; a best-lap duel per sector; a 4 px bar in each delta cell from a centre hairline, `--muted` only
  - stints: ticks every 10 laps and at the last lap with hairlines through the rows, SC and VSC as dashed lines, a track to each driver's last lap so a hole in the data shows, 2 px gaps between stints, an inset ring on pale fills in the light theme, labels hidden by a container query instead of clipped, used sets marked, stops counted, and each row a 44 px button whose popover lists its stints
- **Acceptance:**
  - [CI] chart option tests: `showAllSymbol` is true, a deleted lap keeps its hollow point at 390 px, triangles mark the laps above the window, the Fit bounds, the line-type rule by ΔE.
  - [CI] unit tests: the gap from line crossings (a missing lap, pit laps, a lapped driver) and the stint layout (a track to the last lap, a stint without laps).
  - [CI] `?d` parsing: unknown and duplicate numbers dropped, order kept.
  - [CI] ECharts still loads only on Compare, and its chunk passes the dist scan.
  - [owner] comparing two drivers in the Mexico City 2026 race reads the same as the F1 TV timing.

### P5: Weather (owner, 2026-11-07)

- **Decision:** a Weather tab on the session page (summary, chart, race laps on the timeline, a rain map around the circuit), a one-line summary in the session head, and a Weather tab in the player.
- **Sources** (checked 2026-11-07):
  - Point weather (air and track temperature, humidity, pressure, rain yes/no, wind): OpenF1 `/weather` for the session pages (2023+, about one sample a minute), and the feed's `WeatherData` for live and replay. Both are the same track-side station, which the recorder already records.
  - MET Norway was checked and dropped. Its Nowcast and radar cover only Norway, Sweden, Finland and Denmark, and its global `locationforecast` is a model refreshed every 6 h outside the Nordics.
  - The rain field: the Open-Meteo model grid (CC BY 4.0, free for non-commercial use). It is sharp only where a high-resolution model runs: about 1.5–3 km in Central Europe, the UK and North America, 9–25 km elsewhere. It is modelled rain, not radar, and the page says so.
  - Circuit outlines: `bacinger/f1-circuits` (MIT; all 25 venues of 2026), vendored with its notice.
  - The surroundings: a simplified OpenStreetMap extract per circuit (ODbL), only after the licence ADR of P5c is approved.
- **Rules for every P5 phase:** the browser still makes no third-party request: every source is fetched by our server or vendored. Each phase amends A§6, A§7, A§10 and A§13 for what it changes, marked "(owner, 2026-11-07)".
- **Order:** P5a after P4b and P4c (all three change `views/Session.tsx`). P5b after P5a and P4e (`views/Player.tsx`). P5c after P5a; its player part needs P5b.

### P5a: The Weather tab (OpenF1)

- **Goal:** every session since 2023 shows how its weather went.
- **Scope in:**
  - OpenF1 `weather` as the seventh per-session endpoint: zod schema (each field nullable and bounded by its column), fixtures, a `weather` table keyed (session_key, date), the `raw_response.endpoint` CHECK extended, grants (`f1_ingest` replaces, `f1_api` reads)
  - a re-queue in the same migration: every `final`, not cancelled session goes back to `fetched` with `next_fetch_at` = `date_end` + 35 min, so the running daemon fetches all seven endpoints once more (about 455 sessions × 7 requests ≈ 2 h 15 min, paused during live windows)
  - `GET /sessions/:key/weather` with a strict contract and the A§10 cache rule
  - the route `/:year/:meeting/:session/weather` and a Weather tab after Stints:
    - tiles: air and track min–max, humidity, pressure, wind (mean, max, prevailing direction as a compass point), and rain: "Dry", or its periods in Amsterdam time
    - a chart on the lazy ECharts chunk: air and track temperature as two line types, rain as bands, the rest in a rich-text tooltip
    - in `Race`-type sessions, the leader's lap at each sample (the highest lap any driver has started, from the laps already loaded) in the tooltip and beside each rain period ("laps 23–27")
  - a one-line summary in the session head on every tab ("Air 24–27 °C · Track 38–45 °C · Dry")
- **Scope out:** the player (P5b), the rain map (P5c).
- **Acceptance:**
  - [CI] the schema parses its fixtures (a dry session, a wet session, empty), the golden outputs match, and arbitrary JSON never throws.
  - [CI] integration: ingest writes the weather rows and their raw row, a duplicate date keeps the last, a re-run is idempotent, and an empty answer after rows is `empty` and keeps them.
  - [CI] the migration: a final session becomes `fetched` and the next tick processes it; cancelled, scheduled and failed sessions are unchanged; `f1_api` reads `weather` and cannot write it.
  - [CI] the route parses against its contract; a bad key gives 400, an unknown key 404, and the cache follows the session state.
  - [CI] unit tests: the summary (nulls, all null, rain periods split by a gap, compass points at 0° and 359°), the leader's lap (before the start, mid-race, after the flag, not a race).
  - [CI] chart option tests: two line types, rain bands, the lap in the tooltip only in races, and data strings stripped of `{`, `|` and `}`.
  - [CI] ECharts stays out of the initial bundle and is loaded only by the chart views (Compare and Weather), and the dist scan passes with no new allowance.
  - [box] after the deploy the re-queue has drained, and a query the PR supplies counts the sessions with weather, the rainfall values, the sample interval and any rows outside the session window. The facts go into A§6.1.
  - [owner] a wet 2024–2026 session reads the same as the F1 TV weather graphic.

### P5b: Weather in the player

- **Goal:** live and replay show the weather up to T.
- **Scope in:**
  - a pure `weatherRow(view, t)` in `packages/contracts`: the feed's `WeatherData` strings become a row of the P5a contract (non-numbers become null)
  - the playback `snapshot` carries `weather`, every sample so far from the same replay pass (A§11.3); the client appends a row on each `WeatherData` delta
  - the player's tabs Tower · Laps · Weather; the Weather tab reuses P5a's tiles and chart on the rows up to T, with race laps from the stream's lap rows
- **Scope out:** the rain map in the player (P5c).
- **Acceptance:**
  - [CI] unit tests: `weatherRow` on numbers as strings, an empty string and garbage.
  - [CI] the playback property extended: the snapshot's `weather` at a random T equals a full replay to T, and the client-applied deltas give the same rows.
  - [CI] component tests (happy-dom): a `WeatherData` delta appends a row, a seek back drops later rows, and nothing after T is shown.
  - [owner] in a replayed 2026 race the Weather tab agrees with the F1 TV weather graphic at three moments.

### P5c: The rain map

- **Goal:** see where the rain was around the circuit, and when.
- **Scope in:**
  - a licence ADR first (ADR-0008): `bacinger/f1-circuits` (MIT), the OpenStreetMap extract (ODbL against PolyForm Strict: a Produced Work or a Derivative Database, the attribution) and Open-Meteo (CC BY 4.0). No OSM-derived file lands before the owner approves it; without approval the map shows the outline and the scale rings only.
  - `scripts/map-extract.ts` (the owner's machine only, refuses under `CI`): per circuit, the outline from the vendored GeoJSON plus coastline, water and main roads within about 6 km from Overpass, simplified and projected, written as one JSON per circuit that the web loads lazily
  - a mapping from OpenF1's `circuit_short_name` to the outline id, covering every circuit of 2023–2026
  - a rain job in the `ingest` daemon with its own state per session, rate limiter, fixed hostnames, timeouts and fixed error codes: a grid of about 7 × 7 points around the circuit; the Historical Forecast API once for a past session; every 15 min while a session is live, then once more after it ends; a backfill of past sessions within a daily call budget
  - tables for the grid and its 15-minute frames, and `GET /sessions/:key/rain`
  - the map on the Weather tab (and in the player up to T): an SVG with the OSM layers, the outline, 1 km rings to 5 km, a north arrow, rain cells in three intensity steps with a legend, a time slider, a text summary per frame, and the attributions
- **Acceptance:**
  - [owner] ADR-0008 approved before any OSM-derived file is committed.
  - [CI] unit tests: the grid points, the projection (a known distance within 1 %), the intensity steps, and the circuit mapping over the 2023–2026 meetings fixtures.
  - [CI] msw tests: the Open-Meteo client refuses redirects, times out, caps the body and maps failures to fixed codes; the job's live refresh, final fetch, back-off and daily budget run on a fake clock.
  - [CI] integration: the job stores frames, the route parses against its contract, and it is `no-store` until the grid is final.
  - [CI] component tests: the map (outline, rings, cells by class, legend, attributions), the slider, the text summary, the "no outline" and "not fetched yet" states; the contrast test classifies the rain tokens.
  - [CI] the build test: the map data loads lazily per circuit, and the dist scan passes.
  - [box] every `circuit_short_name` in the VM database maps to an outline, and the rain backfill finishes within the budget (a query and log counts the PR supplies).
  - [weekend] during a live session the grid refreshes every 15 min, and the player's map never shows a frame after T.
  - [owner] a wet 2024–2026 session shows rain where the broadcast reported it.

### P6: Team radio (owner, 2026-11-09)

- **Decision:** the player lists the team-radio clips up to T, and each one plays in the page (P6a). Transcripts follow once a local Whisper spike has measured cost and accuracy (P6b). Onboard radio from F1 TV goes further than the curated clips, gated on DRM (P6c).
- **Sources** (checked 2026-11-09, on the owner's machine):
  - The feed's `TeamRadio` topic, recorded since P2c, already reaches the browser in the playback stream (only `.z` topics are skipped). Each capture is exactly `{Utc, RacingNumber, Path}`: 164 capture messages in 11397, 11404 and 11408, with no transcript.
  - The clip is `https://livetiming.formula1.com/static/<SessionInfo.Path><Path>`, an MP3 at 128 kbps, mono, 48 kHz (about 6 s in the sample). It answered 200 without a token on 2026-11-09, unlike the archive's JSON files (A§6.2).
  - About 20–30 clips per session. F1 picks them, so they are not all the radio. From speech (the file name's track-local time) to `Utc`: a median of 21–27 s, 90 % within 35–40 s, and at most 46 s.
  - The feed's other audio, `AudioStreams` "Live coverage (EN)", is commentary, and `ContentStreams` adds the live text commentary. Neither is radio, and neither is used.
  - The F1 TV onboard channels carry each driver's radio (owner). They are only an option if the streams carry no DRM (P6c).
- **Rules for every P6 phase:**
  - The browser still makes no third-party request: clips are fetched by the recorder, which already reaches `livetiming.formula1.com`, and served by our `api` under `media-src 'self'`.
  - Audio and transcripts are F1 data: never committed (A§12.1 invariant 3), and test fixtures are synthetic.
  - We never build anything that gets around DRM.
- **Order:** P6a first. P6b after P6a and its spike. P6c only after its gate check, independent of P6b.

### P6a: Team radio in the player

- **Goal:** live and replay list the team-radio clips up to T, and each one plays in the page.
- **Scope in:**
  - a `TeamRadio` view in `packages/contracts` (`Captures`: `Utc`, `RacingNumber`, `Path`) and a pure `radioFile(path)`, the basename only when `Path` is `TeamRadio/<1–64 of A–Z a–z 0–9 _>.mp3`
  - the recorder downloads each new clip into `<recording>/radio/`:
    - one at a time, anonymous, no redirects, 15 s timeout, `audio/mpeg` only, at most 2 MB, written through a temporary name with mode `0600`
    - retries after 5 s, 30 s and 120 s, then a fixed error code; no download under the disk floor
    - it never blocks the feed, and a stop aborts what is pending
  - a role `radio <recording dir>` that replays a recording's lines and fills `radio/`, for the recordings made before P6a
  - `GET /api/v1/playback/:recording/radio/:file`:
    - the path from the `recording` row, opened with `O_NOFOLLOW`, a regular file of at most 2 MB
    - `audio/mpeg`, `private, max-age=31536000, immutable`, `Accept-Ranges: bytes`
    - a single byte range answers 206 (Safari needs it), an unsatisfiable one 416; HEAD gets no body; the fixed A§10 errors
  - `media-src 'self'` in the CSP, and a test that pins the whole CSP
  - a "Team radio" card in the player's side panel under race control, newest first: the driver in team colour, the time, the driver's lap at `Utc` from the stream's lap rows, and a native `<audio controls preload="none">`. Click to play (owner, 2026-11-09)
- **Scope out:** transcripts (P6b), autoplay, onboard radio (P6c), and radio on the OpenF1 session pages (OpenF1 `/team_radio`; a later idea).
- **Acceptance:**
  - [CI] unit tests: `radioFile` on valid paths, traversal, odd extensions, over-long names and non-strings.
  - [CI] msw tests for the download:
    - each new capture is downloaded once, duplicates across Subscribe states are skipped, and invalid `Path` and `SessionInfo.Path` values are skipped
    - a redirect, a wrong content type and a body over 2 MB are refused
    - a timeout, the retries on a fake clock, then the fixed codes
    - no download under the disk floor, and an abort leaves no temporary file
  - [CI] the recorder's integration test: a `TeamRadio` delta leaves the clip in `<dir>/radio/` while the feed keeps flowing.
  - [CI] the `radio` role: a bad argument exits 64 (`EXIT_USAGE`), and a replay of a test recording fills `radio/` once.
  - [CI] integration tests for the route: 200 and its headers, 206 and 416, HEAD, 400 for a bad id or file, 404 for an unknown recording or a missing file, a symlink refused, 401 without the Access JWT.
  - [CI] the pinned CSP includes `media-src 'self'`.
  - [CI] component tests: the card (order, driver, time, lap, empty state, escaping), and in happy-dom a `TeamRadio` delta adds an item while a seek back drops it.
  - [box] `radio <dir>` on the VM's São Paulo recordings: the clips found, downloaded and failed (counts only).
  - [weekend] in a live session clips appear at about T and play on desktop and on the phone, and the recorder stays within its limits (`f1-measure`).
  - [owner] in a replay, a clip sits where it airs on the F1 TV replay.

### P6b: Transcripts of the clips

- **Goal:** each clip shows what was said, under the clip in the Team radio card.
- **Decided (owner, 2026-11-09, after the spike and the listening check):** `large-v3-turbo`, on the VM, in Docker.
- **The Whisper spike** (owner's machine, 145 clips of six sessions, `fixtures-private/radio/spike/`; numbers on the P6b issue):
  - faster-whisper int8 at 2 threads, word error rate against a `large-v3` reference:
    - `large-v3-turbo`: 0.22, 10.6 s per clip, 2.1 GB
    - `distil-large-v3`: 0.24
    - `small.en`: 0.30, 2.5 s per clip
    - `base.en`: 0.37
  - A prompt of names gains 0.6 to 1.7 points, and driver names stay the weak spot.
- **Runtime:** whisper.cpp (MIT, no dependencies) with the same turbo weights, not faster-whisper (24 Python packages; ADR-0006 rules out Python). It runs one process per clip, so it holds no memory between clips.
- **Gate: passed 2026-11-09** (owner's machine, the same 145 clips; pins and numbers on the P6b issue):
  - limits: it reads the MP3 directly; a clip without speech exits 0 with no text; p50 ≤ 20 s per clip; peak RSS ≤ 2.5 GB; word error rate ≤ 0.25 against the reference
  - whisper.cpp v1.9.5 with turbo q8_0 at 4 threads: p50 12.9 s, peak RSS 1.17 GB, word error rate 0.221 (faster-whisper turbo had 0.220)
  - at 2 threads p50 is 22.7 s, which fails, so `stt` runs 4 threads (owner, 2026-11-09)
  - `-nt` fails the error rate (0.265). In whisper.cpp it decodes without timestamp tokens, and the decoder then drops whole stretches of a clip.
  - whisper.cpp's default VAD (100 ms silence, 30 ms pad) cuts speech; the faster-whisper defaults fix it
- **Scope in:**
  - the server image, `deploy/server/Dockerfile`:
    - a builder stage compiles `whisper-cli` from the pinned release tarball (`ADD --checksum`, as dbmate)
    - CMake: no shared libraries, no OpenMP, `GGML_NATIVE=OFF` with AVX2, FMA and F16C on and AVX-512 off; no `GGML_BACKEND_DL`
    - the binary and the Silero VAD model (885 kB, `ADD --checksum`) go into the runtime image
    - there is no new image, so neither the workflows nor `f1-update` change
  - the turbo model (`ggml-large-v3-turbo-q8_0.bin`, 874 MB) on the host in `/srv/f1/models`:
    - fetched once by a new idempotent `deploy/bin/f1-model`: a pinned Hugging Face revision and sha256, installed `0444` root
    - `f1-install` creates `/srv/f1/models` (0755 root) and `/srv/f1/transcripts` (0700 62532) and installs `f1-model`
  - a compose service `stt` on `F1_SERVER_IMAGE`:
    - `network_mode: none`
    - `/srv/f1/live` and `/srv/f1/models` read-only, `/srv/f1/transcripts` read-write
    - `mem_limit: 3g`, `cpus: 4.0`, `cpu_shares: 256` (`live` and `api` win under load), `pids_limit: 64`
    - the node healthcheck
    - `api` gets `/srv/f1/transcripts` read-only
  - a role `stt`, a daemon like `live`:
    - every 30 s it lists `<recording>/radio/<name>.mp3` (regular files of at most 2 MB, no symlinks) without a result yet, newest first, one at a time
    - it runs `whisper-cli -m <model> -t 4 -bs 5 -l en -np --vad -vm <vad> -vsd 2000 -vp 400 -vspd 0 -f <clip>` (never `-nt`) through `execFile` (120 s timeout, 1 MiB output, the stop signal)
    - it strips the `[… --> …]` prefix of each output line (`^\[[^\]]*\]\s*`) and joins the lines with a space; text without a letter or digit counts as no speech (one silent clip printed only `.`)
    - it writes `<recording>/<name>.txt` (empty means no speech; at most 4000 characters) under `/srv/f1/transcripts`, through a temporary name, mode 0600
    - one retry, then an empty `<name>.fail`
    - fixed codes `stt_timeout`, `stt_exit`, `stt_spawn`; logs never carry text, paths or stderr
    - without the model it logs `stt_model_missing` once and stays idle and healthy, checking again on every scan
    - it beats on every scan and every 30 s while a clip runs
  - `GET /api/v1/playback/:recording/radio`:
    - `{ "<name>.mp3": text | null }`, where `null` means it failed
    - at most 500 entries; each file opened with `O_NOFOLLOW`, at most 16 KB
    - `{}` without a directory, 404 for an unknown recording, `no-store`, the fixed A§10 errors
  - a `RadioText` contract
  - the web:
    - `useRadioText` polls every 15 s while the recording is open and fetches once in a replay
    - the text sits under each clip as plain text, marked as an automatic transcript
    - "Transcribing…" shows while the recording is open; nothing shows on a failure or without speech
  - ADR-0009, speech-to-text with whisper.cpp on the VM:
    - licences: whisper.cpp MIT, the OpenAI weights MIT
    - the gate's numbers
    - no network
    - the data flow: clips and text never leave the VM, are never committed and are never posted to GitHub
  - A§4, A§10, A§11 (`stt`), A§12, A§14.2 (`stt`'s budget), the install and update runbooks, and the role list in CLAUDE.md
- **Scope out:** language detection (`-l en`), a prompt of names, hand correction, search over transcripts, and onboard radio (P6c).
- **Acceptance:**
  - [CI] unit tests of `stt` with a fake `whisper-cli` on `PATH`:
    - valid names only; done and failed clips skipped; newest first
    - the 2 MB cap; a symlink skipped
    - a timeout or a failed exit gives one retry, then `.fail`
    - a missing model idles, logs once and is picked up later
    - an abort kills the child and leaves no temporary file
    - the text cap; no text in the logs
    - the timestamp prefix is stripped, and output without a letter or digit gives an empty `.txt`
  - [CI] `stt` takes no argument: an extra one exits 64.
  - [CI] integration tests for the route:
    - a failure gives `null`, and no directory gives `{}`
    - 404 and 400
    - a symlink skipped, the size cap
    - 401 without the Access JWT, `no-store`
  - [CI] the `RadioText` contract.
  - [CI] component tests:
    - the text under the clip
    - "Transcribing…" while open, nothing on a failure
    - escaping
    - the hook polls only while the recording is open
  - [CI] `hardening.sh`: `stt` in the service list, the binds and the secret consumers, and a new no-network check with a negative case.
  - [CI] `e2e.sh`:
    - `stt` runs idle and healthy with an empty models directory
    - the new directories are created, and a second `f1-install` run still changes nothing
    - `whisper-cli --help` exits 0 in the runtime image with `--network none`
  - [box] on the VM, after `f1-model`, over the clips of P6a's `radio` backfill:
    - transcribed, empty and failed counts
    - p50 and p90 seconds per clip
    - `stt`'s peak memory (`f1-measure`), with no OOM
    - AVX2 in `/proc/cpuinfo`
  - [weekend] in a live session the text appears within about 60 s of its clip, and `live` and `api` stay within their limits.
  - [owner] a spot check of 10 transcripts against the audio.
- **Rollout order:**
  1. the P6b release is deployed (`current.env`)
  2. then `sudo deploy/bin/f1-install`
  3. then `sudo f1-model`

  `f1-install` recreates the stack with the image already deployed, so running it earlier makes `stt` exit 64.
- **Order:** after P6a is merged (the gate has passed).

### P6c: Onboard radio (gate check first)

- **Goal:** the radio from every driver's F1 TV onboard channel, recorded and transcribed, beyond the clips F1 picks.
- **Gate, in order (no plan and no VM work before it passes):**
  1. [owner] In the browser (DevTools, a past session's replay, one onboard channel): HLS or DASH; any `EXT-X-KEY` with `SAMPLE-AES` or a Widevine, PlayReady or FairPlay key format, any DASH `ContentProtection`, or a licence request; an audio-only rendition and its codec and bitrate; and whether the audio carries radio that is not among the clips. **DRM present = stop.**
  2. Without DRM: a harness on the owner's machine (outside the repository, the token read through `--token-file` as `fetch-archive.ts` does) records 10 min of one onboard's audio and measures the speech share, Whisper's cost on the speech only, and the messages heard against the clips of those 10 min.
  3. An ADR on recording F1 TV audio (terms, storage; as ADR-0005), then P6c's scope, sized by those numbers: 20 streams × the session's length, disk per race, CPU on the VM.
- **Acceptance:** written into this section and the issue once the gate has passed.

### P7: Telemetry (owner, 2026-11-10; after P3e; the plan of #122)

- **Goal:** car telemetry (speed, throttle, brake, gear, RPM, DRS) and track position, per lap, in the site (H15). This is the phase that #122 (owner, 2026-11-09: telemetry traces and a car-position map reopen A§1) plans. Its spike is this gate, and its questions are answered in the PR that writes P7's scope.
- **Sources:** the archive's `CarData.z` and `Position.z` (2018 on, downloaded raw by P3e) and the recordings (P2c, 19 topics with a token). OpenF1's `car_data` and `location` (2023 on, about 3.7 Hz) are the cross-check. Their rows are live-ingested and can have holes (A§11.3).
- **Gate first** [box], #122's spike:
  - the `.z` decoder (bounded inflate) and the CarData channel layout;
  - from P3e's measurements, the rows and bytes per session once parsed;
  - the PostgreSQL size for 2018 to now, against the A§14.1 disk;
  - whether a table (perhaps partitioned per season) or compressed files next to the archive serve the views better.
- **Scope** (written into this section once the gate has passed): a parser for the two `.z` topics on the P2b reader, the storage, `/api/v1/sessions/:key/telemetry?driver=&lap=` with a bounded size, and the views: a speed trace with throttle and brake per lap, two laps compared, and a track position replay in the player.
- **Acceptance:** written into this section and the issue once the gate has passed.

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
| A8 | Create a fine-grained GitHub token for agent sessions on this repository only (contents, pull requests and issues read/write; no Administration, no secrets) and log agent sessions in with it instead of your admin token (A§12.4) | P1f |
| A9 | Run `scripts/archive-probe.ts` with your F1 TV token, and note which JSON requests the F1 TV web app's data screens make for a 2018 session and a pre-2018 replay (H9: hosts, paths and topic names, never a body or a token) | P3d |
| A10 | Download the Jolpica CSV dump to the VM (`/srv/f1/jolpica`), and to `fixtures-private/jolpica/` for the [box] checks | P3c |

## 5. First task

**P0: Foundation.** Open the issue from §3, then branch `claude/p0-foundation`. Copy the gotchas section and the tsconfig/biome/vitest/pnpm policy setup from Waterheight (adjusting names `rws` → `f1`), and verify each pin against the 7-day release-age rule.
