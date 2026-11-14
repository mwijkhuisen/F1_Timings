# ADR-0002: Waterheight's stack with lighter ops

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)

## Context

The owner wants the same kind of stack as Waterheight (`mwijkhuisen/Waterheight`). Waterheight is a public site built to survive flood-time traffic spikes, and much of its ops machinery exists for that. This site has one reader.

## Decision

- **Reuse** the language and tools:
  - TypeScript 6 strict on Node 26, a pnpm 12 workspace with the same supply-chain policy, Biome, Vitest (unit + integration on real PostgreSQL), msw, fast-check
  - Hono, Kysely + pg, dbmate, croner, pino, undici, zod contracts
  - React + Vite + TanStack Query + ECharts
  - distroless images, the hardened compose anchor, file secrets, Caddy, cloudflared, a strict CSP
  - ADR and phase-issue conventions
- **Drop:**
  - signed pull-based releases (cosign, promote gate)
  - the static-first publisher, brownout, load tests and benches
  - the owner-audience machinery and WireGuard owner site
  - Paraglide i18n, the map stack, restic backups and restore drills
  - the watchdog role and public status page
    - amended: host alerts go through healthchecks.io's `f1-ingest/fail` (owner, 2026-11-09, #104); still no watchdog role
  - the BOM check script, boundary/OpenAPI generators, CodeQL, the browser matrix and Lighthouse
  - A§3 gives a one-line reason for each.
- **Deploy:** CI pushes images to GHCR by digest, and a systemd timer on the VM pulls them, migrates, smoke-tests and rolls back on failure.
- **Backups:** none. All database data can be re-fetched. The owner accepts losing raw live recordings if the disk dies.

## Consequences

- The project shares Waterheight's gotchas and versions, so its CLAUDE.md gotchas section carries over.
- Supply-chain protection rests on exact pins, the 7-day release-age rule, Dependabot, gitleaks/zizmor, and GHCR digests rather than signatures.
  - Dependabot does two jobs here:
    - its security alerts on the lockfile, dev dependencies included (a repository setting, not `dependabot.yml`);
    - its weekly version bumps, after a 7-day cooldown, of the npm packages, the actions and the images pinned by digest (`deploy/{server,web}/Dockerfile` and `deploy/compose.yaml`).
  - amended (owner, 2026-11-14, #108): no Grype, as A§3 says; it was named here but never run.
  - **Accepted ceiling:** nothing reports a CVE in an image's OS packages or in its bundled binaries (Node in distroless, Caddy, PostgreSQL, cloudflared). Such a CVE is fixed only when upstream rebuilds the image and Dependabot's weekly run opens the bump after its cooldown, two weeks or so later, and then only once the owner merges and releases.
  - The dbmate binary and pnpm are pinned by sha256 by hand, so they get neither alerts nor bumps.
- If the repo ever gets other contributors, revisit signed releases.
