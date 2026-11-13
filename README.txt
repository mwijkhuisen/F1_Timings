#115 PR 1 evidence (race story views), claude/race-story at 9c9c705.

Shots: a local harness that is never committed. It runs a stand-in API with invented data, a static server with the production CSP headers, and headless Edge.
Synthetic race 11399: 22 drivers, 71 laps, a stop for every driver and a VSC on laps 34-35. Driver 77 has no line crossing around laps 20-21, which makes an incomplete Order row.
Replay 7 stands at T = lap 43/71.

  order-{390,1280}-dark, order-390-light       session page, Order tab ("Grid not in the OpenF1 data" until PR 2)
  order-lap20-{390,1280}-dark                  taller; lap 20 is incomplete ("20*", muted cells, "BOT —" at the end)
  compare-{390,1280}-dark                      Compare ?d=12,16 with the Pit cycles card (LEC L22, ANT L23)
  replay-{390,1280}-dark                       replay tower with the "1 lap" and "3 laps" at-the-line columns
  player-order-{390,1280}-dark, -390-light     player Order tab: Grid row from GridPos, lap 1 gains
  player-order-lap43-1280-dark                 taller player Order shot

Each <name>.txt holds the frame's report. shots.log has one line per shot: every final line has errs=[] (no CSP violation) and scroll=W/W (no horizontal page overflow).
The first four player-order lines (errs=["act:…"]) were superseded: the Order button renders only once the stream state is a race, so these shots were re-run with WAIT=10000.
The literal "<img src=x onerror=alert(1)>" in the race-control line is an invented test string. It renders as text.

owner-check.txt: the real Mexico City 2026 race (11404) from the dev database. It holds the running order after laps 1, 42 and 71 and the VER/HAM, VER/BOT and PER/BOT pit cycles, computed by lib/crossings.ts at b380bea, before review round 1.
That round changes none of these lines. The order of a completed lap is unchanged. For the comparable cycles, the wider period window (laps firstIn - 1 to secondIn + 2) still meets no period: VSC 7-8, SC 44-45, red 45, SC 59-62.
