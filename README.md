# P5b evidence: Weather in the player (#64)

App build shot: commit b15229d (branch claude/p5b-player-weather). Later commits adaa105 and 5acc69d change docs only.
Synthetic data from a local stand-in API; nothing from F1 (no real recording, feed or token). Edge headless, 12 shots, all `ok` in shots.log.

Each shot is `<flow>-<width>-<theme>.png` with its report `.txt` (JSON); `shots.log` has one line per shot.
Recording 7 is synthetic: it starts 20:55:00 (Amsterdam, harness clock), rain at +40..+51 min = 21:35-21:46, laps 25-33.

- weather: /replay/7?t=22:00:00 (+65 min, lap 41, after the rain), paused still frame, Weather view opened. Tiles (air, track, humidity,
  pressure, wind, rain "Rain at times 21:35-21:46"), the air (solid) and track (dashed) chart with the blue rain band, the strip's Weather cell.
- weather-back: opened at 22:35:00, then Position set to 21:25:00 (before the rain). Later rows are gone (snapshot rows 101 -> 31),
  the rain band and period are gone, rain tile says "Dry".
- weather-live: playing from 21:58:52, Weather opened, 14 s of play: a WeatherData delta (t = 21:59:00) appends a row; the tiles and chart redraw
  (air max 22.9 -> 23.0). No row after T.

Widths 390 and 1280, themes dark and light for every flow.
