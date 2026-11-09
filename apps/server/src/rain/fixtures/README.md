# Open-Meteo fixtures

Each `<case>.raw` is an Open-Meteo API answer as sent (any status), and `<case>.meta.json` holds its query (without the host), the API, the status, the grid and the time it was fetched. `scripts/record-rain-fixture.ts` writes both, on the owner's machine only: CI never calls Open-Meteo.

The data is licensed under CC BY 4.0:

Data: Open-Meteo.com, CC BY 4.0, https://open-meteo.com/ — https://creativecommons.org/licenses/by/4.0/

- `central-wet`: the 2023 Monaco GP race (session 9094), Historical Forecast API, ICON-D2 with native 15-minute data.
- `outside-dry`: the 2026 Singapore GP race (session 11388), Historical Forecast API, global models only.
- `error`: an HTTP 400 for a latitude out of range.

No UK session is recorded: Open-Meteo takes UK data from the UK Met Office, which is CC BY-SA 4.0.
