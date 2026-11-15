# #120 weekend forecast: 390 px and 1280 px evidence

Harness (outside the repository, never committed): Edge headless via the local dev API (Cloudflare Access bypassed, 127.0.0.1 only) and a static server serving a production build of the branch, in a 390x1500 / 1280x1000 / 390x1700 iframe wrapper. The database is a copy of the dev `f1` (`f1_i120`) with the new migration applied and one forecast for the Las Vegas meeting (1300) seeded from the owner-recorded Open-Meteo fixture `forecast-vegas.raw` (state live, fetched a few minutes before the shot). Data: Open-Meteo.com, CC BY 4.0. Each `.txt` is the page report (scroll width, forecast words, credit link boxes, tiles, overflowing elements, CSP errors).

- `season-390-{light,dark}`: `/2026`, "This weekend" (Las Vegas): each not-started session row has the forecast word on its own line, then "Forecast (model), updated HH:mm." with the credit.
- `season-1280-{light,dark}`: the same at 1280 px.
- `weather-fp1-390-{light,dark}`: `/2026/1300-las-vegas/11413-practice-1/weather`: the "Forecast (model)" card with four tiles (rain chance, rain, air, wind) and the credit, between the not-started message and the rain map card.

Shot after commit 6fd51b0 (credit at the foot style without the repeated "Forecast:", 12 px between the forecast and rain map cards); the first run had found both.
