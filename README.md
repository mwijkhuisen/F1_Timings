# #72 evidence: popovers open at what opened them

Synthetic data only: an invented stand-in API, no F1 or OpenF1 data. A local harness frames the production build (with the production CSP) in an iframe and screenshots it with headless Microsoft Edge 156 (Chromium). Each shot clicks the popover's `popovertarget` button and records the button's and the open popover's `getBoundingClientRect()` in `<name>.txt` (`pop.btn`, `pop.pop`, `pop.vw`, `pop.vh`), with any CSP violations in `errs`. Built from commit 42e3cb7 of `claude/fix-72-anchored-popovers`. Routes: `/2026/1298-mexico-city-grand-prix/11399-race/laps` (and `/stints`).

| shot | viewport (vw×vh) | placement | gap (px) | popover width (px) | on screen | errs |
|---|---|---|---|---|---|---|
| menu-season | 1280×1000 | below, left-aligned | 4 | 256 | yes | 0 |
| menu-session | 1280×1000 | below, left-aligned | 4 | 256 | yes | 0 |
| menu-meeting | 1280×1000 | below, left-aligned | 4 | 256 | yes | 0 |
| menu-season-390 | 390×900 | below, left-aligned | 4 | 256 | yes | 0 |
| menu-session-390 | 390×900 | below, right-aligned | 4 | 256 | yes | 0 |
| menu-meeting-390 | 390×900 | below, shifted 3 px to stay on screen | 4 | 256 | yes | 0 |
| menu-meeting-light | 1280×1000 | below, left-aligned | 4 | 256 | yes | 0 |
| note-left | 1280×1000 | below, left-aligned | 4 | 330 | yes | 0 |
| note-right | 1280×1000 | below, right-aligned | 4 | 253 | yes | 0 |
| note-bottom | 1280×1000 | above, left-aligned | 4 | 330 | yes | 0 |
| note-corner | 1280×1000 | above, right-aligned | 4 | 245 | yes | 0 |
| note-390 | 390×900 | below, left-aligned | 4 | 207 | yes | 0 |
| stints | 1280×1000 | above, left-aligned | 4 | 301 | yes | 0 |
