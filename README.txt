P4d (#50) screenshot evidence. Synthetic data only: the design mock-up's invented race state (Mexico City, lap 43),
served by a local stand-in API outside the repository (~/.cache/f1-dev/p4d), the production build of claude/p4d-pit-wall
at 95de286 behind the production CSP headers, Edge headless through shot.html (CSP violations recorded into errs).

replay-{390,1280}-{dark,light}.png   /replay/7, Started:1 (Track clear): strip, tower, panel (below the tower at 390 px)
replay-sc-1280-dark.png              the same with TrackStatus 4 (Safety car)
light-<state>-1280-{dark,light}.png  the strip per light state (LIGHT=<SessionStatus>:<TrackStatus>):
  clear Started:1 · yellow Started:2 · sc Started:4 · vsc Started:6 · vscending Started:7 · red Started:5 ·
  stopped Aborted:5 · notstarted Inactive:1 · chequered Finished:1 · unknown Started:3
light-states-strip.png               the strip crops of all ten states (dark), then clear, SC and red (light)
<name>.txt                           the page's #m JSON per shot (path, title, h1, scroll widths, errs)
shots.log                            one line per shot attempt; Edge wrote no PNG on the first attempt of
                                     light-yellow, light-vsc and light-vscending, so those were re-run
                                     (the yellow one with WAIT=9000, which is why its LEFT reads 59:49).

The race-control message "CAR 1 (TST) <img src=x onerror=alert(1)> NOTED" is planted to show that markup renders as text.
