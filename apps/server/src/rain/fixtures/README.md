# Open-Meteo fixtures

Each `<case>.raw` is an Open-Meteo API answer as sent (any status), and `<case>.meta.json` holds its query (without the host), the API, the status, the grid and the time it was fetched. `scripts/record-rain-fixture.ts` writes both, on the owner's machine only: CI never calls Open-Meteo.

The data is licensed under CC BY 4.0:

Data: Open-Meteo.com, CC BY 4.0, https://open-meteo.com/ — https://creativecommons.org/licenses/by/4.0/

- `central-wet`: the 2023 Monaco GP race (session 9094), Historical Forecast API, ICON-D2 with native 15-minute data.
- `outside-dry`: the 2026 Singapore GP race (session 11388), Historical Forecast API, global models only.
- `error`: an HTTP 400 for a latitude out of range.
- `forecast-vegas`: the 2026 Las Vegas GP weekend (meeting 1300, from its first session on Fri 20 Nov to its last on Sun 22 Nov), Forecast API, one point at the circuit's centre, hourly (#120). Recorded by the owner with `--forecast`, NOAA models, so not UK data; the CC BY 4.0 credit above applies. A negative longitude goes after `--`: `node scripts/record-rain-fixture.ts --forecast -- forecast-vegas 36.1167 -115.1666 2026-11-20T00:30:00Z 2026-11-22T06:00:00Z`.

No UK session is recorded: Open-Meteo takes UK data from the UK Met Office, which is CC BY-SA 4.0.
