# OpenStreetMap layers

The `*.json` files in this folder contain information from OpenStreetMap (© OpenStreetMap contributors, https://www.openstreetmap.org/copyright), made available under the Open Database License (ODbL) 1.0 (https://opendatacommons.org/licenses/odbl/1-0/).

They are a Derivative Database: coast, water and main roads (motorway, trunk, primary) within 6 km of each circuit, extracted on 2026-11-09 by `node scripts/map-extract.ts --osm`. Anyone may use them under the ODbL.

The method of making the alterations (ODbL §4.6 b) is that script: it sends one Overpass API query per circuit (the query is in `overpassQuery`), then assembles water relations into rings, simplifies every line (Douglas–Peucker, 15 m), clips it to a ±6 km box around the circuit centre, rounds it to 10 m and writes it as SVG path data. Raw Overpass answers are not stored in the repository.

The rest of this repository is under PolyForm Strict 1.0.0. That licence does not apply to the files in this folder.
