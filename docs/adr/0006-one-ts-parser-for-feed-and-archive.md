# ADR-0006: One TS parser for the live feed and the archive; no Python

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)

## Context

- The archive's `.jsonStream` files are recordings of the same SignalR topics the live feed sends (TimingData, TimingAppData, DriverList and so on).
- FastF1 parses both, but it is Python, and Waterheight's ADR-0002 rejects Python.

## Decision

- One TypeScript parser (`apps/server/src/live/`) merges topic deltas into a typed state and reconstructs laps. It is built for live in P2b and reused for the 2018–2022 archive import in P3a.
- FastF1 serves as a reference for the format, lap reconstruction and the login flow, not as a dependency. Any ported logic keeps its MIT notice.
- The P2-rec recording with the FastF1 CLI is a throwaway tool outside the repo.

## Consequences

- One language and toolchain. P3 history mostly comes for free once P2 is done.
- Lap reconstruction is the hardest code in the project. It is tested against OpenF1 laps for the same sessions as an oracle (P2b).
