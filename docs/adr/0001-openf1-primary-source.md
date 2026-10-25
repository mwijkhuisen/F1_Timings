# ADR-0001: OpenF1 is the v1 data source

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)
- **Revisit:** if OpenF1 stops the free historical tier, or when P3b shows the F1 archive is strictly better for 2023+.

## Context

- The site needs lap times, S1/S2/S3, mini-sectors, speed traps and stints for past sessions from 2023 on.
- **OpenF1** serves all of these for free and without auth once a session is over. Its "live" window (from 30 min before the start until 30 min after the end) is paid only.
  - The free limit is 3 req/s and 30 req/min.
  - Checked on 2026-10-25 against Austin 2026 qualifying, Marina Bay 2026 race and sprint, and Bahrain 2023.
- **The official F1 archive** has returned 401 without an F1 TV token since ~15 Oct 2026. Its token lasts ~4 days, and datacenter IPs are blocked (FastF1 #978, #988).
- **Jolpica** has no sector times.

## Decision

- OpenF1 is the only source in v1, ingested once per session after the paid window and then twice more for corrections.
- Raw responses are stored with the normalised rows.
- Trimmed real OpenF1 responses may be committed as fixtures (they are public, unauthenticated data). Nothing derived from F1 TV is ever committed.

## Consequences

- v1 needs no F1 TV credentials and no Python.
- OpenF1's gaps are ours: null sectors on some laps, unreliable mini-sector colours in races, wrong tyre age for used sets, null stop durations. The UI shows them as gaps.
- The 2023+ backfill takes ~2 h at 25 req/min.

## Alternatives rejected

- **F1 archive via FastF1 in v1:** needs credentials, a token every ~4 days and a Python toolchain, for no gain in 2023+ coverage.
- **OpenF1 Sponsor for everything:** costs €9.90/month and isn't needed for historical data.
