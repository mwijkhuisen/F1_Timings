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

Re-shot after the review fixes (dist built from 0fa01ed)
  Folder fix/: same 15 shots, same targets, same stand-in (PNG + .txt + shots.log).
  CHECKS
    (a) errs == [] on all 15 shots (no CSP violations).
    (b) scrollWidth == clientWidth on all 15 (390/390, 1280/1280).
    (c) compare-390 (dark, light, add) with two drivers: table.deltas .scroll 356/356, fits. compare3-390: 485/356 (scrolls sideways, as designed).
    (d) canvases: compare, compare3, compare-add = 2; stints (all 5) = 0; laps = 0.
    (e) echarts chunk requested: true only on compare/compare3/compare-add; false on stints and laps.
    (f) location.search kept: ?d=3,63 and ?d=3,63,1.
  VISUAL
    stints-1280-light, stints-390-dark: tick labels (10, 20, ...) sit centred on their hairlines; the last label (71) ends at the lanes' right edge.
      No "· used" label spills into the next stint (HAD, LIN, COL at 1280 fit their segments; at 390 the label is just "S 17"). The data has no one-lap stint, so that point
      is not exercised here; the shortest stints (S 12) are as wide as their laps.
    compare-1280-dark: the Lap times card now fills its row; its chart box is 732x490 (was 732x320), no empty band under the chart (compare3-1280: 732x666).
    compare-390-dark: layout unchanged (chart boxes 332x320, deltas box 356/356).
