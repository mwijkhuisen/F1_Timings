# ADR-0003: Own compose project and Postgres on the Waterheight VM

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)

## Context

- The site runs on the same Hyper-V VM as Waterheight (Debian 13, being resized from 4 vCPU / 8 GB to 6 vCPU / 12 GB; 960 GB of free disk).
- Waterheight's own nftables table only filters `rws-*` and `docker0` bridges, so a second project's egress is unrestricted by default.

## Decision

- Its own compose project `f1` with its own PostgreSQL 18 container and volume.
- Its own `f1-*` bridges with fixed subnets outside 172.30.0.0/16 and the LAN, and its own `table inet f1` firewall loaded by `f1-firewall.service` (never `flush ruleset`).
- Its own secret GIDs (62001+), container UID 62532, paths `/etc/f1` and `/srv/f1`, timers `f1-update`/`f1-tick`, and healthchecks.
- It publishes only `127.0.0.1:8180` (Waterheight uses `127.0.0.1:80`).

## Consequences

- An F1 bug, upgrade or migration can't touch Waterheight's data or uptime. That is checked in P1f with `docker compose -p rws ps` before and after.
- It costs ~1 GB more RAM than sharing Waterheight's Postgres.
- Host-level settings (`daemon.json`, sysctl, apt) are Waterheight's and are only read, never changed, by the F1 install.

## Alternatives rejected

- **Waterheight's Postgres with a separate database:** couples upgrades, backups and connection limits.
- **SQLite:** breaks with the Kysely + pg stack.
