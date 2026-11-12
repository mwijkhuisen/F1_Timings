# ADR-0009: History sources and their terms

- **Status:** Proposed (the owner made the P3 decisions H1–H16 on 2026-11-10; this ADR records their sources and terms for review)
- **Date:** 2026-11-10
- **Source:** `docs/plan/PHASES.md` P3 (decisions H1–H16); `docs/plan/ARCHITECTURE.md` A§6.2 and A§6.3
- **Revisit:**
  - when the site stops being private or gets ads or subscriptions;
  - when P3d's probe shows F1 TV serves timing before 2018;
  - when a source's terms change.

This is not legal advice. It records how the repository reads the primary texts linked under Sources.

## Context

- The owner wants the most complete history the site can hold.
- The F1 archive (ADR-0005 token) covers 2018 on, and OpenF1 (ADR-0001) 2023 on.
- Before 2018 no public source we found has per-lap sectors, mini-sectors or per-lap speed traps.
- The repository is public (PolyForm Strict 1.0.0). The web image is public. The site is private (Cloudflare Access, owner only).

## Decision

### 1. The F1 archive (`livetiming.formula1.com/static`), 2018 on

As now (A§6.2, invariant 3): raw files on the VM and in `fixtures-private/`, synthetic fixtures, never committed.

- From P3e it downloads every topic, telemetry included.
- 2023 on is downloaded as files only (H3).
- FastF1's maintainer reads F1's terms as forbidding rehosting the data, which we never do.

### 2. Jolpica-F1, 1950–2017 and a cross-check from 2018

- **Terms:** the data is CC BY-NC-SA 4.0 (`TERMS.md`). A private, ad-free site is non-commercial.
- **Attribution:** in the licences file the web build serves (as ADR-0008 does for Open-Meteo): "Data: Jolpica-F1 (Ergast), CC BY-NC-SA 4.0" with a plain link.
- **ShareAlike:** we publish no adapted database. The dump and the rows stay on the VM and in `fixtures-private/`, never in the repository or an image, and the test fixtures are synthetic.
- **Access:** the CSV dump, downloaded by the owner (H12, A10), never by CI.

### 3. The FIA timing PDFs (`fia.com`), 2012 on

- **Terms:** © Formula One World Championship Limited: "No part of these results/data may be reproduced, stored in a retrieval system or transmitted in any form or by any means … without prior permission". The FIA site terms allow private, non-commercial use.
- **How we use them** (H10): only for the owner's private use. The PDFs and the parsed rows are never committed, never in an image, and never shown outside Access. The parser fixtures are synthetic PDFs built in the tests. CI never calls `fia.com`.
- **The risk:** "stored in a retrieval system … without prior permission" reads on a database of their timing, private or not. The owner accepts it for a private site, as for the F1 TV data. If the site ever leaves private use, this source goes first.

### 4. Not used

- **formula1.com results:** "personal, non-commercial use only", and the guidelines bar text and data mining.
- **Kaggle and TracingInsights copies of Ergast:** labelled CC0, but derived from NC-SA data. We use Jolpica's own dump.
- **statsf1, forix, motorsportstats:** no open licence.
- **F1 TV video, including the data channel:** never, nor OCR of it, nor anything that gets around DRM (H9, the P6 rule). Only JSON that the F1 TV app itself fetches can be a source, after P3d.

## Consequences

- Invariants 3 and 4 (A§12.1, CLAUDE.md) now name the FIA PDFs, the Jolpica dump and `fia.com`.
- New outbound hosts for owner-run jobs: `api.jolpi.ca` (the dump, downloaded by the owner) and `www.fia.com` (P3f). Like the other hosts, they are fixed in code; the firewall limits the port, not the host (A§14.3).
- Pre-2018 sessions show fewer columns, and the views say why (P3g).

## Sources (read 2026-11-10)

- FastF1: https://github.com/theOehrly/Fast-F1/discussions/550, issues #248, #668, #677, #688, #841, #863, #930, #978; https://docs.fastf1.dev/data_reference/index.html
- Jolpica: https://github.com/jolpica/jolpica-f1/blob/main/TERMS.md, `docs/rate_limits.md`, `docs/endpoints/laps.md`, `docs/endpoints/pitstops.md`, `docs/endpoints/data/dumps.md`
- FIA: https://www.fia.com/f1-archives; https://www.fia.com/events/fia-formula-one-world-championship/season-2014/british-grand-prix-event-timing-information; https://www.fia.com/file/83930/download (site terms)
- formula1.com: https://www.formula1.com/en/information/legal-notices.7egvZU48hzrypubGBNcQKt; https://www.formula1.com/en/information/guidelines.4EOKE9RRqevL4niTK9kWyt
- OpenF1: https://openf1.org/docs/
