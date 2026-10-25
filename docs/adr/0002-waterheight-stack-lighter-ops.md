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
  - the BOM check script, boundary/OpenAPI generators, CodeQL, the browser matrix and Lighthouse
  - A§3 gives a one-line reason for each.
- **Deploy:** CI pushes images to GHCR by digest, and a systemd timer on the VM pulls them, migrates, smoke-tests and rolls back on failure.
- **Backups:** none. All database data can be re-fetched. The owner accepts losing raw live recordings if the disk dies.

## Consequences

- The project shares Waterheight's gotchas and versions, so its CLAUDE.md gotchas section carries over.
- Supply-chain protection rests on exact pins, the 7-day release-age rule, Dependabot cooldowns, gitleaks/zizmor/Grype, and GHCR digests rather than signatures.
- If the repo ever gets other contributors, revisit signed releases.
