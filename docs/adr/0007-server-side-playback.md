# ADR-0007: Live and replay as server-side playback over SSE

- **Status:** Accepted (owner, 2026-10-25)
- **Date:** 2026-10-25
- **Source:** `docs/plan/ARCHITECTURE.md` (planning session 2026-10-25)

## Context

- The owner follows the timing next to the F1 TV video. The broadcast lags the timing feed by a varying 30–60 s, and some sessions are watched later.
- The owner wants an adjustable delay slider, and a replay of recorded sessions in sync with the F1 TV replay.

## Decision

- Everything is "state at session time T":
  - the recorder keeps raw messages and 30 s snapshots
  - `/api/v1/playback/:recording/stream?at=<ms>|live&delay=<s>&speed=1` sends one snapshot event, then delta events over SSE
  - live means T = now − delay
  - moving the slider, pausing or seeking opens a new stream
- The delay is set per device: 0–120 s, adjustable in 1/5/30 s steps.

## Consequences

- Live and replay share one code path and one UI.
- The phone only receives the current state and deltas, never a whole recording.
- The server holds no per-client state beyond an open stream.

## Alternatives rejected

- **A client-side delay buffer:** replay would need the full recording (tens of MB) on the phone, plus a second code path.
