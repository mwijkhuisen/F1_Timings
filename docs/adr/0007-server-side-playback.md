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

## Amendment (owner, 2026-11-05, P2e)

- **The seek replays from the first line.** Every stream applies the recording's lines from the first one up to T through one `createFeed` and one `createLaps`, then sends one `snapshot`. Playback no longer reads snapshot files (the recorder still writes them and is unchanged).
  - Why: a snapshot holds no lap history, so the nearest-snapshot seek of P2d gave only the current state, and a lap table on the stream could not be rebuilt from it.
  - Measured (local P2a recordings, WSL): a full replay in process takes 1.1 s for the 4 h Mexico race (11404: 99k lines, 1369 laps) and 0.37 s for FP1 (11397). Over HTTP through the local `api`, the first complete snapshot arrives after 0.98–1.20 s at the race's end (641 KB, of which lap rows 541 KB; 1369 laps, 80 stints) and after 47–61 ms at its start.
- **A session switch clears the state.** When a `SessionInfo` carries another `Key` than the state's, the stream clears the state and sends a fresh `snapshot`. Without it the previous session's lines stayed (limit E, A§11.3): FP1 11397 ended with 32 TimingData/DriverList/TimingAppData lines for 22 drivers and 171 race-control messages instead of 67; with the reset it has 22/22/22 and 67. The lap and stint rows are byte-identical with and without it on both recordings.
- **The stream carries the lap and stint rows.** All of them in the `snapshot`, and the changed ones in a new `laps` event (A§10).
- **Replay sync** is the seek bar with markers plus ±1/±5/±30 s position nudges. The 0–120 s delay slider is live only (A§11.3, A§13).
