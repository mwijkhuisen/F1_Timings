# Planning session: F1 lap & sector timing site

This session is for **planning only**. The output is a written plan in the repo. Don't write application code. Throwaway spikes (curl, small scripts in a scratch folder) to check data are fine and encouraged.

## Goal

A personal website that shows lap times and sector times for F1 sessions that have already happened (FP1–3, sprint qualifying, sprint, qualifying, race). Live timing comes in a later phase.

## Repo

- GitHub: https://github.com/mwijkhuisen/F1_Timings (public, `main`, only a README so far).
- This folder (`~/F1_Timing`) holds only this prompt. Connect it with `git init -b main && git remote add origin https://github.com/mwijkhuisen/F1_Timings.git && git pull origin main`, then move this file to `docs/plan/planning-prompt.md`.
- Reference project (read only, never modify): https://github.com/mwijkhuisen/Waterheight. Clone it into a scratch folder.

## Decisions already made (don't ask again)

| Topic | Decision |
|---|---|
| Scope | Historical sessions first. Live timing is a later phase: plan it, don't build it. |
| Audience | Only me. Personal use. |
| Seasons | v1: 2023 to now. Later: older history. |
| Data | OpenF1 is the primary source. FastF1 / the official F1 archive with my **F1 TV Pro** login is a later add-on (older seasons, gaps). |
| v1 views | (1) Lap table per session: lap time, S1/S2/S3, purple/green/yellow, pit in/out laps. (2) Driver comparison: 2+ drivers, lap-time chart. (3) Mini-sectors and speed traps (I1/I2/ST). (4) Tyres/stints: compound and tyre age. |
| Stack | The same kind of stack as Waterheight, with **lighter ops**. Keep the language, libraries, tooling, Docker Compose + Caddy and hardened containers. Drop what a one-user site doesn't need, such as signed pull-based releases, brownout, load tests and a static-first publisher. For each Waterheight piece you drop, give the reason in one line. |
| Hosting | The **same box as Waterheight** (home host, Debian 13 amd64). Give it more vCPU/RAM if needed, and say how much. |
| Database | **Its own Postgres** in its **own compose project**, fully separate from Waterheight. |
| Access | **Cloudflare Tunnel + Cloudflare Access**, restricted to my identity only. |
| Plan format | **`docs/plan/` + ADRs, like Waterheight**: `docs/plan/README.md`, `ARCHITECTURE.md`, `PHASES.md`, `docs/adr/NNNN-*.md`. Also a short `CLAUDE.md` for later build sessions. |

## Waterheight: what to read

Waterheight uses TypeScript 6 strict on Node 26 and a pnpm 12 workspace (`apps/server`, `apps/web`, `packages/*`).

- **Server:** Hono, Kysely + pg (PostgreSQL 18), croner, undici, pino, zod.
- **Web:** React 19 + Vite 8, TanStack Query, ECharts, Paraglide (NL/EN).
- **Tooling:** Biome, Vitest, Playwright.
- **Deploy:** Docker Compose, Caddy, cloudflared, systemd timers.

Read these before proposing anything:

- `CLAUDE.md`, especially "Gotchas (2026 versions…)", "Dependency policy" and "Bill of materials"
- `docs/plan/ARCHITECTURE.md` (stack table, BOM)
- ADR-0002 (TS only, Python rejected), 0004 (Postgres), 0014 (dependency policy), 0015 (tests on real Postgres), 0017 (owner audience / personal-use data), 0021 (home hosting behind Cloudflare Tunnel)
- `deploy/compose.yaml`, `deploy/compose.tunnel.yaml`, `deploy/host/*` (how the box is set up)

Watch for one conflict: ADR-0021 says Waterheight's tunnel has exactly one public hostname and that cloudflared can reach only `caddy:80`. Adding the F1 site to that tunnel would break Waterheight's rules. Weigh a separate tunnel + cloudflared in the F1 compose project (likely the right call) against that, and ask me.

## Data research (done 2026-10-25; re-check before relying on it, this changed last week)

### OpenF1 (`https://api.openf1.org/v1`): primary source

- Historical data from 2023 onward is free and needs **no authentication**.
- "Live" runs from 30 min before a session starts until 30 min after it ends. That window is paid Sponsor tier only (€9.90/month: REST + MQTT + WebSocket, about 3 s latency). After it closes, the session is free.
- Free rate limit is **3 req/s and 30 req/min**, so cache everything in Postgres. Never re-fetch a settled session.
- Checked against `laps?session_key=11392` (Austin 2026 qualifying). It returns `lap_duration`, `duration_sector_1..3`, `segments_sector_1..3` (mini-sector codes such as 2048/2049/2051; confirm what they mean in the OpenF1 docs), `i1_speed`, `i2_speed`, `st_speed`, `is_pit_out_lap` and `date_start`.
- Also check: `sessions`, `meetings`, `drivers`, `stints`, `pit`, `race_control` (deleted laps / track limits).
- There are known data gaps (open issues on `br-g/openf1`): null pit durations, sessions that need re-ingesting, and slowness right after a session becomes free (#474). Plan for missing data, and show it honestly in the UI.

### Official F1 archive (`livetiming.formula1.com/static`): later add-on

- Since about **15 Oct 2026** it returns 401 without a token, for all seasons (2018+). It needs **F1 TV Access/Pro/Premium**, so my Pro subscription is enough.
- FastF1 **≥ 3.9.0** (released 2026-10-24) handles the login:
  - credentials come from `F1_USERNAME` / `F1_PASSWORD`
  - CLI: `python -m fastf1 auth f1tv --authenticate|--status|--clear`
  - the token lasts about **4 days** and can't be refreshed; with credentials in env, FastF1 logs in again by itself.
- **Datacenter IPs can be blocked before auth.** GitHub Actions gets a CloudFront 403 even with a valid token (FastF1 #988), while home IPs work. So the fetching must run on the home box, and CI must never call F1 APIs (use fixtures, like Waterheight does).
- FastF1 is Python, and Waterheight's ADR-0002 rejects Python. Compare two options for the history phase:
  - a tiny Python sidecar that only fetches and stores
  - a TS client for the archive endpoints (plain HTTP plus an `Authorization` header)
- Waterheight keeps secrets as **files** (`/etc/<project>/secrets`), not env vars. Work out how the F1 TV credentials fit that.

### Others

- **Jolpica-F1** (`api.jolpi.ca/ergast`): free results and lap times back to 1996, but **no sector times**. Good for results and pre-2018 lap times only.
- **No known free source has sector times before 2018.** Say so in the history phase.

### Live timing (later phase): options to plan, not build

- **A.** OpenF1 Sponsor (€9.90/month) over MQTT/WebSocket. Simplest. One report of about 5 min delay during FP3 (openf1 #481).
- **B.** The F1 SignalR Core live feed with my F1 TV token. FastF1 can only *record* it to a file (no real-time processing, disconnects after about 2 h). Real time needs your own client. `JustAman62/undercut-f1` is a reference implementation.

### F1 TV Pro: what it's for

- **v1 (OpenF1, 2023+):** not needed at all.
- **Needed for:** the 2018–2022 history via the archive, filling OpenF1 gaps, and live option B.
- **Personal use only.** Data from my F1 TV account must stay behind Cloudflare Access for my identity only. Never make it public, never put credentials in git (the repo is public), and never log tokens.

## How to run this session

1. Set up the repo (see above) and read the Waterheight files listed.
2. Check the research with quick curl calls: OpenF1 fields for a race, a sprint and a quali; `stints`; `race_control` for deleted laps. Record what is missing.
3. **Interview me** with AskUserQuestion, max 4 questions per round. Put your recommended option first. Skip anything this prompt already decides or that the Waterheight repo answers.
4. Propose the architecture and ask me about the key choices before writing it down.
5. Write the plan files, show me a summary, and commit only after I approve.

## Open questions to ask me

1. The box: is it a VM, and on which hypervisor (see my `IaC_Homelab` repo)? How much vCPU/RAM does it have now? Is resizing OK?
2. The hostname/domain for the F1 site. A separate tunnel + cloudflared vs. an extra hostname on Waterheight's tunnel.
3. The Cloudflare Access login method: email OTP, GitHub or Google.
4. Fetching: on demand when I open a session, or automatically (croner) once a session turns free? Do the first backfill of 2023+ at first start? Estimate how long that takes at 30 req/min.
5. Times shown in Europe/Amsterdam, track local time, or both.
6. UI language: English only, or NL/EN with Paraglide like Waterheight.
7. Look and feel: a dark F1-timing-screen style? Must it work on a phone?
8. Coloring rules: purple = session best, green = personal best, yellow = slower. How should deleted laps (track limits) show?
9. Comparison depth: lap-time chart only, or also gap/delta and sector-by-sector deltas?
10. Backups: skip them (all data can be re-fetched), or back up like Waterheight?
11. CI on GitHub Actions: which checks? License (Waterheight uses PolyForm Strict)?
12. Does my F1 account have 2FA? (This affects automated login for the history phase.)
13. Live phase: pick A or B now, or later?
14. Workflow: one GitHub issue per phase with a PR template, like Waterheight, or commits straight to `main`?

## What the plan must contain

- Goal, non-goals, and every decision (above plus my interview answers), each with a one-line reason.
- A **data map**: each view → endpoint → fields, the known gaps, and how the UI shows them.
- Architecture: the services in the F1 compose project, data flow, the Postgres schema outline, caching, rate-limit handling, and how tests use recorded fixtures instead of live APIs.
- The stack, with a list of Waterheight pieces reused and pieces dropped, and why.
- Hosting: resources on the box, compose project isolation from Waterheight, the tunnel + Access setup, secrets as files.
- Phases in `PHASES.md`, each split into small tasks with acceptance criteria:
  - v1: historical, 2023+
  - v2: history back to 2018 via F1 TV, plus filling gaps
  - v3: live
- ADRs for the main choices (data source, stack, separate DB/compose, tunnel + Access, F1 TV credential handling).
- Risks: F1 API changes (like Oct 2026), OpenF1 gaps and slowness, token expiry, IP blocks, the F1 TV ToS, resource contention with Waterheight.
- The first task to start with.

## Constraints

- Keep it simple: one user, one box. No user accounts in the app (Cloudflare Access is the gate), no microservices beyond what compose needs, no metrics stack.
- Don't touch the Waterheight repo or its running stack. The F1 stack must not be able to break Waterheight.
- No secrets in git. Add `.env*` and secrets paths to `.gitignore` from the first commit.
- End commit messages with the attribution line your environment gives you.
