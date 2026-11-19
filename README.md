# #238 UX scan, smaller items: screenshots

These come from a local harness only (`~/.cache/f1-dev/i238/harness`, a copy of #237's), which is never committed to an app branch.

- **Serving:** each build's `apps/web/dist` is served with the production Caddy headers and the strict CSP.
- **Data:** a stand-in API serves **synthetic** data. Weekend mode has a six-car race (recording 7) and the 22-driver laps of session 11399. Live mode has an open recording 9. Between mode has no open recording and a future session.
- **Capture:** Windows Edge headless takes each shot at 390 and 1280 px, dark and light. The bar shots use a real phone screen, 390 x 844 (1280 x 800).

## Sets

- `before/`: `main` at 2612f2b, every scenario.
- `after-player/`: PR #246 (`claude/ux-small-player`), built at ec44075. It looks the same as the head 49cb332, whose review round changed only an ARIA attribute and where `Next`'s timer lives.
  - Scenarios: `bar-first-replay`, `bar-first-live`, `bar-expanded`, `live-next`.
- `after-pages/`: PR #247 (`claude/ux-small-pages`, 03f94ee).
  - Scenarios: `session-tabs`, `session-tabs-result`, `laps-length`, `laps-jump`, `picker-open`, `season-upnext`, `compare-nolaps`.

## Reports

Each `<scenario>-<390|1280>-<dark|light>.txt` is the page's report (JSON):

- 0 CSP violations and 0 page errors in every shot;
- the page's `scrollWidth`/`clientWidth`, which is 390/390 in every phone shot;
- `x`, what the scenario measured.

`laps-jump` reports a PROBLEM in `before/` on purpose, because main has no link to click.

## Before and after

| Scenario (item) | Before (2612f2b) | After |
| --- | --- | --- |
| `bar-first-replay` (1): first visit, nothing stored | 390: expanded, 264 px (31 % of 844) | 390: minimised, 61 px; 1280: expanded as before |
| `bar-first-live` (1) | 390: expanded, 312 px (37 %) | 390: minimised, 61 px |
| `bar-expanded` (2): `f1.minimized`=`0` | "Announce events", 44 px | "Announce events to a screen reader" and its muted line, 308 x 67 px; the bar +23 px (the line wraps in two) |
| `live-next` (3): `/live` between sessions | "Next: … starts Sat 21 Nov 2026, 15:30" | the same plus ", in 2 days 5 h" |
| `session-tabs` (6): Laps tab | 390: 2 rows, 93 px | 390: 1 row, 45 px, scrolls (455/358); 1280 unchanged |
| `session-tabs-result` (6): Result tab | 390: 2 rows | 390: 1 row, scrolled 97 px so Result is in view; window not scrolled |
| `laps-length` (7, 8): Laps tab | no jump row; no switch labels | "Laps · Speed traps · Race control" first, 44 px; METRIC and VALUES each with its buttons |
| `laps-jump` (7): click "Race control" | no link | 390: the card at 441 px in the viewport, `#race-control` |
| `picker-open` (9): open Add driver, pick | stays open (276 px at 390), focus on body | closed (44 px), focus on its summary |
| `season-upnext` (12b) | "Open Live" | "Follow" |
| `compare-nolaps` (11): 11397 Compare | "No laps in the OpenF1 data." | "Compare needs laps. No laps in the OpenF1 data." |

The measurements behind the closed items (`tower-tab` 4, `compare-ref` 10, `header-warn` 12a) are in `before/` only.
