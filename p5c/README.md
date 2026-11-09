# P5c screenshots: the rain map (evidence for PR #88, not for main)

Local harness, real data, not committed to the code branch. A stand-in API (127.0.0.1) serves OpenF1 weather rows and the Open-Meteo rain frames of two sessions to the built web app (`apps/web` dist) behind the production CSP; Edge headless takes the shots. The Weather tab is opened at `/:year/:meeting/:session/weather`, scrolled so the card "Rain around the circuit" is in view.

| Shot | Session | Key | Slider frame |
| --- | --- | --- | --- |
| `rain-monaco-{390,1280}-{dark,light}` | 2023 Monaco GP, Race (Monte Carlo, native 15-minute model) | 9094 | 13:45 UTC = 15:45 Amsterdam: the frame with the most rain on the grid (6 of 49 cells, light, heaviest 0.8 mm/h) |
| `rain-singapore-{390,1280}-{dark,light}` | 2026 Singapore GP, Race (outside the native regions: coarse-model note) | 11388 | default (first frame at or after the start: 12:00 UTC = 14:00 Amsterdam), dry, "No rain within 5 km" |

Each `.txt` is the page's JSON report for its shot: CSP violations and page errors, horizontal overflow, the summary text, the slider's `aria-valuetext`, the counts of `rect.rain-1/2/3` cells, outline, rings, OSM layers (water, coast, roads), credits, coarse-model note and label overlaps. `shots.log` has one line per shot.

Sessions chosen: of the Monte Carlo, Hungaroring, Imola, Monza and Spielberg sessions 2023-2026, OpenF1's `rainfall = 1` rows exist only for Spielberg 2023 Sprint and Race and Monaco 2023 Race; the Open-Meteo Historical Forecast answers (the repo's own query, window start - 60 min to end + 30 min) held at most 3 light cells for Spielberg and 6 for Monaco. Nothing was moderate or heavy, so the colour steps moderate and heavy do not occur on these shots.

Data sources:

- Rain: Weather data by Open-Meteo.com, CC BY 4.0 (https://open-meteo.com/, https://creativecommons.org/licenses/by/4.0/); Historical Forecast API, the repo's fixtures `central-wet.raw` (Monaco) and `outside-dry.raw` (Singapore).
- Weather rows: OpenF1 (`/v1/weather`, session 9094; the repo's fixture `weather-normal.raw` for session 11388).
- Circuit outline: bacinger/f1-circuits (MIT); water, coast and roads: OpenStreetMap contributors, ODbL 1.0, both from the repo's bundled map files.
