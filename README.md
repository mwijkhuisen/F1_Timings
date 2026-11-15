# F1_Timings

A personal website for F1 lap times, sector times, mini-sectors, speed traps and tyre stints, from 2023 onward via [OpenF1](https://openf1.org). Live timing and replay (next to the F1 TV app) and history back to 2018 come in later phases. It is owner-only, behind Cloudflare Access.

The plan lives in [`docs/plan/`](docs/plan/README.md). Decisions are in [`docs/adr/`](docs/adr/). Commands are in [`CLAUDE.md`](CLAUDE.md).

Licence: [PolyForm Strict 1.0.0](LICENSE).

## Third-party data

| Path | Source | Licence | What changed |
|---|---|---|---|
| `data/third-party/f1-circuits/` | [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) | MIT | Nothing, a verbatim copy |
| `apps/web/src/map/*.json` | derived from the file above | MIT: the notice applies | Projected, simplified and clipped to ±6 km by `scripts/map-extract.ts`, plus a viewBox and a start/finish bar from a sourced table |
| `apps/web/src/map/osm/*.json` | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | Coast, water and main roads, extracted by `scripts/map-extract.ts --osm` |
| `apps/server/src/rain/fixtures/` | [Open-Meteo.com](https://open-meteo.com/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Recorded answers, used as test data |

PolyForm Strict covers the code and the owner's own files. It does not apply to the files in this table, which keep their licences (ADR-0008). The MIT notice is also in `apps/web/public/third-party-licences.txt`, which the site serves.
