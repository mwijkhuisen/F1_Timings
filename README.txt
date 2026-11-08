P4f (Compare and stints) screenshot evidence. SYNTHETIC DATA ONLY (invented drivers and laps, never from fixtures-private).
dist built from commit 57dd67e (branch claude/p4f-compare-stints, HEAD at build time).

SHOTS (Edge headless, <name>.png + <name>.txt = the #m JSON of the page, shots.log = one line per shot)
  Session: Mexico City race 11399, path /2026/1298-mexico-city/11399-race/<view>. Drivers by result position: A = VER (3), B = RUS (63), C = NOR (1).
  compare-<w>-<theme>      /compare?d=3,63          w = 390|1280, theme = dark|light   (4)
  compare3-<w>-<theme>     /compare?d=3,63,1                                           (4)
  stints-<w>-<theme>       /stints                                                     (4)
  compare-add-390-dark     compare?d=3,63 with details.add opened (the picker chips)
  stints-pop-390-light     stints with the first row's popover shown (showPopover())
  laps-390-dark            /laps (ECharts chunk check)
  Heights: compare/compare3 390 = 3050/3250 px, 1280 = 1980/2150 px (the sector-delta table's .scroll box has max-height 75dvh,
  so the page grows with the shot height: the shots end inside that table); stints 390 = 1500, 1280 = 1400.

HARNESS (outside the repository, never committed): /home/maikel/.cache/f1-dev/p4f (copied from ../p4d; see its README.txt)
  stand-in API (scenario weekend, :8080) + static server with the production CSP (:4173), both on 127.0.0.1.
  Re-run (sandbox disabled, Edge is a Windows exe; ports 8080/4173 free):
    cd /home/maikel/.cache/f1-dev/p4f && ./shots.sh dist screens weekend 'compare-390-dark|/2026/1298-mexico-city/11399-race/compare?d=3,63|390|dark|3050' ...
    target = name|path|width|theme[|height[|act]], act = add | pop

CHECKS (from the #m JSON, shots.log)
  (a) errs == [] on all 15 shots (no CSP violations, no page errors).
  (b) scrollWidth == clientWidth on all 15 shots (390/390 or 1280/1280): no horizontal page overflow.
  (c) compare-390 with two drivers (dark, light, add): table.deltas .scroll box 356/356, no horizontal scroll.
      (compare3-390 with three drivers: 485/356, the box scrolls sideways, as designed.)
  (d) canvases: compare, compare3, compare-add = 2 (one per .chart box: [1,1]); stints = 0; laps = 0.
  (e) /assets/echarts-*.js requested: yes on all compare/compare3/compare-add shots; no on stints (all 5) and on laps-390-dark.
  (f) location.search after load: compare = ?d=3,63, compare3 = ?d=3,63,1 (unchanged).
