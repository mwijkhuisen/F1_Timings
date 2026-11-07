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
| After P2 | **P3a–P3c** | History back to 2018 (and optional pre-2018 lap times) |

Remaining 2026 weekends (OpenF1 schedule): Austin (race 25 Oct) · Mexico City 30 Oct–1 Nov · São Paulo 6–8 Nov · Las Vegas 20–22 Nov · Lusail 27–29 Nov · Yas Marina 4–6 Dec.

## 2. Criterion tags and workflow

- **Tags:**
  - **[CI]** is proven by a test or check in CI.
  - **[box]** is checked on the VM with a command the PR supplies.
  - **[weekend]** needs a real F1 session.
  - **[owner]** is a manual owner action or judgement.
- **Per phase:** one issue with the goal, scope, deliverables and acceptance criteria copied from this file. Branch `claude/p<N><x>-<slug>`, conventional commits, and a PR with an evidence checklist (each criterion → test or command output). Agents never merge. The owner merges with a merge commit once `ci` and `security` are green (branch protection on `main` requires both; owner, 2026-10-25).
- **Reviews:** a fresh-session `/code-review` before merging P1b, P1c, P2b, P2c, P2d and P4e. A security review for anything touching secrets, the firewall, Access, the token or the compose hardening (P0 CI, P1f, P2c). For the web-only P4 phases a Sonnet security review is recommended where more feed or URL text is parsed or rendered (P4d, P4e, P4f), and optional elsewhere unless the CSP or the build config changes.
- **Models and effort** (owner, 2026-10-25; each phase issue has its own table):
  - Build: Opus 5.5 at `xhigh` (`high` for UI and well-specified phases, `max` for P2b's lap reconstruction). Sonnet 5.5 at `high` for small phases (P2f, P3b, P3c).
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
  - lap table (A§13 amended): "other" values in plain text; purple keeps its box with a light tint, green stays bold; in- and out-laps dimmed with IN (OUT only where no compound chip starts the stint); a stint rule beside the compound chip; SC, VSC and red-flag laps banded in the lap header from `/sessions/:key/race-control`; the driver and Best columns frozen; a "Δ to own best" view per metric with a one-hue step behind the value (in, out, deleted and neutralised laps show the word instead)
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

## 5. First task

**P0: Foundation.** Open the issue from §3, then branch `claude/p0-foundation`. Copy the gotchas section and the tsconfig/biome/vitest/pnpm policy setup from Waterheight (adjusting names `rws` → `f1`), and verify each pin against the 7-day release-age rule.
