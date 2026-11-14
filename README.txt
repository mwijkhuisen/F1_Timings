#112 screenshot evidence: Stints and Compare in the player, tiles and bands on its Laps tab (commit 447eb10, branch claude/player-tabs)

ALL DATA IS SYNTHETIC. The race, drivers, times, stints and race-control texts are invented by a local stand-in API
(a harness outside the repository, never committed). No real recording, no F1 feed data, no OpenF1 data appears in any shot.

HARNESS
- dist built from 447eb10: `~/.cache/rws-toolchain/rws pnpm --filter @f1/web build` in the code worktree, served with the production CSP
  (copy of deploy/web/Caddyfile site_headers) by a static server that proxies /api to the stand-in and logs every /api request path.
- Stand-in: synthetic 6-driver race of 64 laps as a function of T (VSC, SC, a second SC and a red flag later; stints; laps; pit stops),
  recording 7 of session 11399, real-time SSE playback (snapshot as of T, then deltas). Patched for the current contracts: /status
  (revision, ingest, rain, rc_unmatched), session detail (source, fetch_count, fail_count, last_error, next_fetch_at, results grid),
  snapshot event (weather: []). Stand-in routes and stream validated against packages/contracts (validate.mjs: 0 failures, including
  snapshot + events == later snapshot).
- Edge headless (Windows exe, --screenshot) takes the picture; each flow runs inside a wrapper page (shot.html, same-origin iframe) that
  waits for the still frame and the tab's content (tiles / stint lanes / two chart canvases), settles 2.5 s and posts the report.
  Dark theme = prefers-color-scheme dark; the light shot uses prefers-color-scheme light. PNGs are cropped to their content
  (the Compare shots are cut by the viewport height: 3000 px at 390, 2000 px at 1280; the charts are at the top).
- Each shot is a resume load: /replay/7?t=<Europe/Amsterdam HH:mm:ss>&tab=<tab>.

MOMENTS (minutes after the recording's started_at; Amsterdam clock of this run, started_at 19:48:00 local = race start 19:53:00)
  T1  +30 min  20:18:00  lap 18/64, before the first VSC (VSC deployed 20:23:00 = +35)
  T2  +58 min  20:46:00  lap 37/64, during the SC (SC deployed 20:43:00 = +55, ends 20:50:00 = +62); VSC (laps 22-24) already over
  T3  +70 min  20:58:00  lap 44/64, after the SC ended; the second SC (21:03:00 = +75) has not started
  (the stand-in's date shift changes with each start, so the Amsterdam clock times differ between runs; the offsets do not.)

SHOTS (19): <tab>-T<n>-<width>-<theme>.png and a .txt report each: laps, stints, compare x T1, T2, T3 x 390, 1280 (dark), plus
  compare-T2-390-light. The report holds: final URL, scrollWidth/clientWidth of the page and of fieldset[aria-label="View"], the View
  switch's button texts and row count (distinct offsetTop), the band classes in the lap table header, the stints legend items, the lap
  tiles, the chart canvases, CSP violations and page errors, and the /api requests made during the shot.

CHECKS (all 19 shots)
- T1: no band anywhere. Lap table: 0 th.band; Stints: no SC/VSC legend entry; Compare: no band in either chart (checked by eye).
- T2: SC band on all three tabs. Laps: th.band-sc on laps 35, 36, 37 (and band-vsc on 22, 23, 24); Stints legend "VSC, laps 22-24"
  and "SC, laps 35-37" with dashed lines; Compare: VSC and SC bands in both the lap-time and the gap chart.
- T3: the SC band stays over its laps. Laps: band-sc on laps 35 to 39 (5 headers), band-vsc 22-24; Stints legend "SC, laps 35-39";
  Compare: SC band in both charts over laps 35 to 39.
- /api requests: 7 per shot (recordings, seasons, live, status, seasons/2026, sessions/11399?v=dev, playback/7/stream?at=<T>&still=1).
  0 requests to /race-control, 0 to /stints, 0 to /laps. grep over the 19 reports: 0 matches.
- Horizontal overflow: 0 of 19 (scrollWidth == clientWidth at 390 and 1280).
- View switch (390 px): 358/358 wide, 6 px button padding, 6 buttons (Tower, Laps, Order, Compare, Stints, Weather) in 1 row. At 1280:
  1248/1248, 12 px padding, 1 row.
- CSP violations: 0. Page errors: 0.
- A ?t load opens paused at T as a still frame in all shots ("Resumed at HH:mm:ss: press Play...", PAUSED, 0 streams left open).

OBSERVATIONS (not fixed, see the PR)
- The lap table opens scrolled to the left, so at 390 px the first visible lap columns are laps 1-3 and the SC/VSC header bands (laps 22+)
  are off screen until the table is scrolled; the "SC / VSC lap" legend entry shows (underlined in the band colour).
- Stand-in difference vs. the real server: the first build of the stand-in sent open stints with lap_end null, which the Stints tab lists
  but does not draw; the real server (apps/server/src/live/laps.ts) sends lap_end = NumberOfLaps for the current stint. The stand-in was
  patched to match before these shots.
