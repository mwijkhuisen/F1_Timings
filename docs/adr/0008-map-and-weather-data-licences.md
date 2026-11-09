# ADR-0008: Licences of the map and rain data

- **Status:** Accepted (owner, 2026-11-09 10:11 UTC): route B for the OpenStreetMap layers and the attribution strings of section 4. No OSM-derived file was committed before this approval.
- **Date:** 2026-11-09
- **Source:** `docs/plan/PHASES.md` P5c (issue #65); plan of 2026-11-09
- **Revisit:** when the site stops being private or gets ads or subscriptions; when a new data source is added.

This is not legal advice. It records how the repository reads the primary texts quoted under Sources.

## Context

- The repository is public on GitHub under PolyForm Strict 1.0.0. The web image `ghcr.io/mwijkhuisen/f1-web` is public. The site itself is private (Cloudflare Access, owner only).
- P5c shows a rain map built from three third-party sources:
  - **bacinger/f1-circuits** (MIT): circuit outlines. The file is vendored under `data/third-party/f1-circuits/`. A script projects, simplifies (15 m), clips (±6 km) and rounds each outline into `apps/web/src/map/<id>.json`, so derived geometry is in the repository and in the public image.
  - **OpenStreetMap** (ODbL 1.0), only after this ADR is approved: coast, water and main roads, one Overpass query per circuit (about 25), a few hundred ways each, simplified the same way and committed as path data.
  - **Open-Meteo** (CC BY 4.0): model precipitation on a 7 × 7 grid per session. The server stores it in PostgreSQL and the private page shows it. It is never committed. Recorded answers for tests (two sessions outside the UK and one error) are committed.
- CLAUDE.md invariant 6: the browser makes no third-party requests. So every attribution link is a plain `<a href rel="noreferrer">`; the page fetches nothing.
- `LICENSE` is PolyForm Strict 1.0.0. Its grant is for "the software": "other than distributing the software or making changes or new works based on the software". It speaks for the licensor's own work. Files of others keep their own licence.

## Decision

### 1. bacinger/f1-circuits (MIT)

The MIT text has one condition: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." The derived per-circuit JSON is a simplified copy of the geometry, so we treat it as a substantial portion and carry the notice.

- `data/third-party/f1-circuits/LICENSE.md`: the verbatim licence (E2 vendors it). `README.md` there gives the URL and commit `8094e957…`.
- A "Third-party data" section in `README.md` (see 5).
- `apps/web/public/third-party-licences.txt`: the full MIT text with "Copyright (c) 2019-2025 Tomislav Bacinger", plus the ODbL notice of section 2 and the Open-Meteo credit. Vite copies `public/` into `dist`, so the image serves it at `/third-party-licences.txt` like any static file, behind Access. The "MIT" link under the map points to it (a same-origin link, no third-party request). `build.test.ts` asserts the file is in `dist`.
- Why not a comment in each JSON file: the files are generated and JSON has no comments. The licences file sits next to every copy shipped in the image, which is the "all copies" the licence asks for.
- bacinger's README says the circuit data is unofficial and that the F1 marks belong to Formula One Licensing B.V. It names Google Maps as the "initial circuits data source". The MIT licence covers bacinger's rights only; we accept that residual risk for a private, noncommercial page. The licences file repeats the trademark line.

### 2. OpenStreetMap: route B (Derivative Database, ODbL as separate files). Recommended.

What the texts say:

- ODbL §4.5 b): using a Database "to create a Produced Work does not create a Derivative Database". So route A is lawful only if the path data is a Produced Work.
- The OSMF Produced Work guideline lists ".PNG, JPG, .PDF, SVG images and any raster image" as usually Produced Works, then says: "intended for the extraction of the original data, then it is a database and not a Produced Work." It does not discuss other vector formats. Our files are not an image. They are per-circuit data files (SVG path strings in JSON), committed standalone in a public repository and loaded as separate lazy chunks. Anyone can read the coordinates back. A reviewer could call them intended for extraction, or not. The guideline does not settle it.
- The Substantial guideline: "More that 100 Features only if the extraction is non-systematic", and "we regard repeated small extractions as one big extraction!". We extract a few hundred ways per circuit, systematically, for 25 circuits. That is Substantial. If the files are a database, they are a Derivative Database.
- A Derivative Database that is publicly used must be ODbL (§4.4 a), and publicly used means "to Persons other than You". The repository and the image are public, even though the page is private.

Route A (Produced Work, code licence) fails if the OSMF reading goes the other way: PolyForm Strict on a Derivative Database breaks §4.4. Route B holds under both readings and costs only notices. B does not depend on how vector coordinates are classed.

Route B in practice:

- OSM geometry lives only in `apps/web/src/map/osm/<id>.json`, never mixed into the outline files. Shape: `{"attribution":"© OpenStreetMap contributors","licence":"ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/","water":…,"coast":…,"roads":…}`. This puts the §4.2 b) copy or URI "in the Database" itself. The size and path-grammar tests check the path fields only.
- `apps/web/src/map/osm/README.md`: the §4.2 d) notice for tools that skip JSON: the data is from OpenStreetMap, extracted by `scripts/map-extract.ts --osm`, under ODbL 1.0, with the URL of the licence text.
- §4.6 offer: §4.6 a) offers "The entire Derivative Database". The files are the entire database, public in the repository and in the image, in machine-readable form, free. §4.6 b) also allows "the method of making the alterations … (such as an algorithm)": `scripts/map-extract.ts` states the query and the processing. Raw Overpass answers are never committed (they are not the Derivative Database we use publicly). No other offer is needed.
- The code stays PolyForm Strict. §4.5 a): "You are not required to license Collective Databases under this License … but this License still applies to this Database or a Derivative Database as a part of the Collective Database". The repository and the image are such a collection. The OSMF FAQ says the same: "it will not apply to any other data forming part of a Collective Database."
- Display: the notice of §4.3 ("Contains information from DATABASE NAME, which is made available here under the Open Database License (ODbL)") is met by the credit under the map (section 4). It shows only when OSM layers are drawn.
- Overpass use: one query per circuit, run on the owner's machine, not in CI, with the limits already in the plan. The extraction is a one-off per circuit (re-run when the outlines change), not a service.

Alternatives:

- **A, Produced Work:** simpler files, but rests on a reading the OSMF text does not confirm. Rejected.
- **No OSM layers:** zero OSM exposure; the map is outline, rings and rain only. Valid fallback if the owner prefers it. E8 is then dropped and listed as a follow-up.
- **Another open map source:** not researched.

### 3. Open-Meteo (CC BY 4.0)

- Open-Meteo: "You must give appropriate credit, provide a link to the licence, and indicate if changes were made." and "You must include a link next to any location Open-Meteo data are displayed", with example text "Weather data by Open-Meteo.com" linked to open-meteo.com. CC BY 4.0 §3(a)(2): conditions may be met "in any reasonable manner based on the medium". The credit goes next to the map in both Weather tabs.
- Changes to indicate: the values are binned into three steps (and 15-minute sums become mm/h), and only 49 points are sampled.
- **Non-commercial:** the terms give "Private or non-profit websites or apps that do not have subscriptions or advertising" as non-commercial, and the free tier is under "10'000 API calls per day, 5'000 per hour and 600 per minute". The site is private with no ads or subscriptions, and the budget (D3) stays under those limits. A subscription or ad ever added means a paid plan first.
- **Committed fixtures:** CC BY 4.0 allows redistribution ("copy and redistribute the material in any medium or format") with attribution, and the terms say nothing against storing responses. Each fixture's `meta.json` carries "Data: Open-Meteo.com, CC BY 4.0" (the plan already has it) and a link `https://open-meteo.com/en/licence`. `apps/server/src/rain/fixtures/README.md` repeats the credit and says the fixtures are test data only. Open-Meteo's licence page lists some sources under their own licences (NOAA, Météo-France) and gives no terms for them. A Central-Europe fixture may use AROME. The risk is small (a few hundred numbers, attributed, noncommercial), and U4 records which model each fixture came from.
- **UK Met Office (C6):** the licence page lists "UK Met Office | CC-BY-SA". ShareAlike (§3(b)) applies when "You Share Adapted Material You produce", and "Share" means to provide material "to the public". Silverstone's field is shown only on a page behind Access and is never committed or in the image, so ShareAlike is not triggered today. Recommendation: the simplest compliant option is to keep Silverstone on `best_match` and add one credit for `gb-1948` only (section 4). Silverstone never gets a committed fixture. If the site ever becomes public, the Silverstone field would be Adapted Material and must be shared as CC BY-SA 4.0 or be dropped. Alternative: pin a non-UKMO model for Silverstone. That adds a second query shape and a coarser field, for a duty that does not arise. Rejected.

### 4. The attribution strings (final)

Shown as one line (wrapping allowed) under the map, in both Weather tabs. Every link is `<a href rel="noreferrer">`.

1. Always: `Rain: Weather data by Open-Meteo.com (CC BY 4.0). Modelled, not radar; 7 × 7 points binned into three steps.`
   - "Open-Meteo.com" → `https://open-meteo.com/`
   - "CC BY 4.0" → `https://creativecommons.org/licenses/by/4.0/`
2. Always: `Circuit outline: bacinger/f1-circuits (MIT), simplified.`
   - "bacinger/f1-circuits" → `https://github.com/bacinger/f1-circuits`
   - "MIT" → `/third-party-licences.txt`
3. Only when the OSM layers are drawn: `© OpenStreetMap contributors, ODbL.`
   - "OpenStreetMap" → `https://www.openstreetmap.org/copyright`
   - "ODbL" → `https://opendatacommons.org/licenses/odbl/1-0/`
4. Only when `grid.map_id` is `gb-1948` (Silverstone): `Includes UK Met Office model data (CC BY-SA 4.0).`
   - "CC BY-SA 4.0" → `https://creativecommons.org/licenses/by-sa/4.0/`

Notes:

- OSMF asks that the credit make clear the data is under the ODbL and that "OpenStreetMap" link to `openstreetmap.org/copyright`. It accepts "© OpenStreetMap contributors" as a historical form. The plan's bare "© OpenStreetMap contributors" did not mention the ODbL, so the string above adds it. OSMF: "Attribution must be placed in the vicinity of the produced work". Under the map is the vicinity.
- The Open-Meteo credit differs from the plan's draft ("Rain: Open-Meteo.com (CC BY 4.0), modelled, not radar"): it now carries the words "Weather data by" and the change note.
- `apps/web/public/third-party-licences.txt` holds the full MIT text, the ODbL notice and the Open-Meteo credit. The README section holds the same facts.

### 5. The PolyForm Strict repository with third-party files

`README.md` gets a "Third-party data" section, after the Licence line. One table: path, source, licence, what we changed.

- `data/third-party/f1-circuits/`: bacinger/f1-circuits, MIT, verbatim.
- `apps/web/src/map/*.json`: derived from the above (simplified, projected), MIT notice applies.
- `apps/web/src/map/osm/*.json`: OpenStreetMap contributors, ODbL 1.0, extracted by `scripts/map-extract.ts --osm`.
- `apps/server/src/rain/fixtures/`: Open-Meteo.com, CC BY 4.0, recorded answers.

It says: PolyForm Strict covers the code and the owner's own files. Third-party files keep their licence, and the PolyForm licence does not apply to them. This is consistent with the licence, which grants rights only in "the software" of the licensor. MIT allows the vendored copy to be distributed. §4.5 a) allows the ODbL files to sit in a repository under another licence.

## Consequences

- Four new notice places: the vendored `LICENSE.md`, the OSM directory README, the licences file in `dist`, and the README section. `build.test.ts` and `map-data.test.ts` assert the last two and the notice fields.
- OSM files cannot be relicensed or merged into outline files. Any change to them stays ODbL. Anyone may copy them under the ODbL.
- Credits live in `RainMap.tsx` and are tested for text, hrefs and `rel="noreferrer"`. The Silverstone credit is tested by `map_id`.
- A public site, ads or subscriptions would reopen this ADR: Open-Meteo needs a paid plan, and Silverstone's CC BY-SA field would have to be shared.
- If the owner picks route A, section 2 reduces to the §4.3 notice and the OSM files go under the code's licence, at the risk stated there.

## Sources

All fetched 2026-11-09. Quotes are exact; the fetch tool capped some quotes, so those passages are short.

1. bacinger/f1-circuits at commit `8094e957b8d6aa8b9f4510c93968556cccd30e02`:
   - `https://raw.githubusercontent.com/bacinger/f1-circuits/8094e957b8d6aa8b9f4510c93968556cccd30e02/LICENSE.md`: "Copyright (c) 2019-2025 Tomislav Bacinger"; "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."
   - `…/README.md` (same commit): "The MIT License (MIT)"; "Initial circuits data source" (a Google Maps link); "This repository is unofficial and is not associated in any way with the Formula 1 companies."; "Formula 1™ circuits data are not official, and they are not approved nor endorsed by Formula One Licensing B.V." No usage terms beyond the MIT licence.
2. ODbL 1.0, `https://opendatacommons.org/licenses/odbl/1-0/`:
   - §1: "Derivative Database" "Means a database based upon the Database, and includes any translation, adaptation, arrangement, modification"; "Collective Database" "Means this Database in unmodified form as part of a collection of independent databases in themselves"; "Produced Work": "a work (such as an image, audiovisual material, text, or sounds) resulting from using the whole"; "Substantial": "Means substantial in terms of quantity or quality or a combination of both."; "Publicly": "means to Persons other than You or under Your control by either more than 50% ownership".
   - §4.2: "If You Publicly Convey this Database, any Derivative Database, or the Database as part of a Collective Database,"; b) "Include a copy of this License (or, as applicable, a license permitted under Section 4.4) or its Uniform Resource Identifier (URI) with the Database or Derivative Database"; d) "If it is not possible to put the required notices in a particular file due to its structure, then You must include the notices in a location (such as a relevant directory) where users would be likely to look for it."
   - §4.3: "Creating and Using a Produced Work does not require the notice in Section 4.2. However, if you Publicly Use a Produced Work, You must include a notice associated with the Produced Work"; "Contains information from DATABASE NAME, which is made available here under the Open Database License (ODbL)."
   - §4.4 a): "Any Derivative Database that You Publicly Use must be only under the terms of:" this License, a later version "similar in spirit", or "A compatible license."
   - §4.5: a) "You are not required to license Collective Databases under this License if You incorporate this Database or a Derivative Database in the collection, but this License still applies to this Database or a Derivative Database as a part of the Collective Database"; b) "to create a Produced Work does not create a Derivative Database for purposes of Section 4.4"; c) "Use of a Derivative Database internally within an organisation is not to the public and therefore does not fall under the requirements of Section 4.4."
   - §4.6: "If You Publicly Use a Derivative Database or a Produced Work from a Derivative Database, You must also offer to recipients … a copy in a machine readable form of: a. The entire Derivative Database; or b. A file containing all of the alterations made to the Database or the method of making the alterations to the Database (such as an algorithm)".
3. OSMF guidelines (the `wiki.osmfoundation.org` URLs redirect with 301 to `osmfoundation.org`):
   - `https://osmfoundation.org/wiki/Licence/Attribution_Guidelines`: "Attribution must be placed in the vicinity of the produced work."; the credit "should typically appear in a corner of the map"; link "OpenStreetMap" to openstreetmap.org/copyright; "© OpenStreetMap contributors" or "© OpenStreetMap" accepted as historical forms; for databases include attribution and the ODbL text or a link, "where users would likely look, such as a readme file"; substantial extractions for training datasets "are considered Derivative Databases". No separate rule for vector data. "not a substitute for the legal text itself".
   - `https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline`: usually Produced Works ".PNG, JPG, .PDF, SVG images and any raster image"; usually not, database dumps; "intended for the extraction of the original data, then it is a database and not a Produced Work." Vector data is not addressed as a category.
   - `https://osmfoundation.org/wiki/Licence/Community_Guidelines/Substantial_-_Guideline`: "Less than 100 Features."; "More that 100 Features only if the extraction is non-systematic."; "we regard repeated small extractions as one big extraction!"; "The systematic extraction of all eating places within an area" is systematic.
   - `https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ`: "A Collective Database is not therefore considered a Derivative Database."; "it will not apply to any other data forming part of a Collective Database."; "You can license a Produced Work under any terms you like."; "a Derivative Database is created where you adapt, modify, enhance, correct or extend our data." The page does not say "vector" and refers to other guidelines for classification.
4. Open-Meteo:
   - `https://open-meteo.com/en/licence`: "API data are offered under Attribution 4.0 International (CC BY 4.0)"; "You must give appropriate credit, provide a link to the licence, and indicate if changes were made."; "You must include a link next to any location Open-Meteo data are displayed"; example "Weather data by Open-Meteo.com"; "copy and redistribute the material in any medium or format"; the sources table lists "UK Met Office" as "CC-BY-SA" and NOAA NCEP, Météo-France, CMC and JMA as "Own licence".
   - `https://open-meteo.com/en/terms`: "You accept to the CC-BY 4.0 licence"; non-commercial examples "Private or non-profit websites or apps that do not have subscriptions or advertising"; commercial examples "Websites or apps that have subscriptions or display advertisements"; "Less than 10'000 API calls per day, 5'000 per hour and 600 per minute." No rule on storing responses; no mention of UK Met Office.
   - `https://open-meteo.com/en/pricing`: "The free API is for non-commercial use, rate-limited to 10,000 calls/day"; "attribution is a requirement under this licence"; "A subscription grants a commercial use licence."
5. Creative Commons:
   - `https://creativecommons.org/licenses/by/4.0/legalcode.en`: §3(a)(1) "If You Share the Licensed Material (including in modified form), You must:"; §3(a)(2) "You may satisfy the conditions in Section 3(a)(1) in any reasonable manner based on the medium, means,"; §1.9 "Share means to provide material to the public by any means or process that requires permission under the Licensed Rights".
   - `https://creativecommons.org/licenses/by-sa/4.0/legalcode.en`: §3(b) "In addition to the conditions in Section 3(a), if You Share Adapted Material You produce," "The Adapter's License You apply must be a Creative Commons license with the same License Elements,"; "Share" as above ("to the public").
6. `LICENSE` of this repository: PolyForm Strict 1.0.0, "other than distributing the software or making changes or new works based on the software".
