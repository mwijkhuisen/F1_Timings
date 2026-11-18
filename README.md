# #237 UX scan: screenshots

Local harness only (`~/.cache/f1-dev/i237/harness`, a copy of #235's, never committed to an app branch). Each build's `apps/web/dist` is served with the production Caddy headers and the strict CSP. A stand-in API serves **synthetic** data: a six-car race (recording 7, a 2 h replay) and an open recording 9 for `/live`, a second synthetic race at the real clock. Windows Edge headless takes each shot at 390 x 2000 and 1280 x 1200 (`rc-link`: 390 x 700 and 1280 x 800, so the page scrolls), dark and light.

- `before/`: `main` at 3bedefe, every scenario.
- `after-a/`: PR #243 (`claude/ux-player-bar`, 5db294c): `undo`, `min-live`, `reconnect`, `hold`.
- `after-b/`: PR #244 (`claude/ux-player-content`, 8c6c229): `tower`, `rc-link`, `map-focus`.
- `after-c/`: PR #245 (`claude/ux-session-pages`, e8cd970): `laps-remembered`, `compare-picks`, `error-retry`.
- Each `<scenario>-<390|1280>-<dark|light>.txt` is the page's report (JSON): 0 CSP violations and 0 page errors in every shot (`reconnect` and `error-retry` force a failure on purpose; neither raises a page error), the page's `scrollWidth`/`clientWidth` (390/390 in every phone shot), and `x`, what the scenario measured.

| scenario | before (3bedefe) | after |
| --- | --- | --- |
| `undo` (item 1): two seeks while playing | Back to: Start, SC, VSC | `20:47:01` (the T before the last seek) first, then Start, SC, VSC |
| `min-live` (3): /live minimised, paused | head: Play, Controls | head: Play, Live, Controls, one 44 px row at 390 px |
| `reconnect` (4): the stream cut, then 500 | pill REPLAY (`pill`) | pill RECONNECTING (`pill warn`); the "Reconnecting…" line stays |
| `hold` (9): /live at delay 0, then −30 | six nudges enabled; then LIVE, 30 S BEHIND | the three later nudges disabled at 0; then LIVE, HOLDING 29 S, counting down |
| `tower` (2): 390 px, unscrolled | Last at 403–485 px in a 356 px box | Last at 259–341 px, inside; 1280 px order unchanged |
| `rc-link` (7): the strip's message | plain text; cell 54 px (390) / 55 px (1280); the card at 1038 px | a link; cell 54 / 55 px; after the click the card's top at 0 px |
| `map-focus` (8): `?tab=map&focus=44` | every dot r 0.0234 | HAM r 0.0351 (1.5 x), class `focus`, `--fg` ring |
| `laps-remembered` (5): `f1.tables` stored | Lap, Times pressed | S2, Δ to own best, Drivers as columns pressed |
| `compare-picks` (5): picks [44, 16] stored | VER, RUS (the top two) | HAM, LEC; the URL has no `?d=` |
| `error-retry` (6): the detail answers 500 | "API error", no button | "API error" and Try again |
