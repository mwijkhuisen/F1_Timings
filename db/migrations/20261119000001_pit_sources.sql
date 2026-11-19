-- migrate:up
-- #219 (owner D1, 2026-11-19), A§7: a pit row takes its values from several sources (the F1 archive's and the live
-- timing's pit-lane topics, OpenF1, Jolpica) through one merge, without a new table. `sources` keeps each source's
-- candidate values, {<source>: {"date": <epoch ms>, "pit_ms": …, "lane_ms": …, "stop_ms": …}}: the date as epoch ms,
-- so no TimeZone setting can change it. `filled` is {column: source} for each value from another source than the
-- row's own, as lap.filled. Expand-only: the DEFAULTs let the previous image insert, and the merge reads a row with
-- {} sources as the candidate of its own source. No grant: f1_ingest already writes `pit`, f1_api reads it.

ALTER TABLE pit
  ADD COLUMN sources jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(sources) = 'object'),
  ADD COLUMN filled jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filled) = 'object');

-- Every existing row is the candidate of its own source.
UPDATE pit SET sources = jsonb_build_object(source, jsonb_build_object(
  'date', round(extract(epoch FROM date) * 1000)::bigint,
  'pit_ms', pit_ms,
  'lane_ms', lane_ms,
  'stop_ms', stop_ms));

-- migrate:down
ALTER TABLE pit DROP COLUMN filled, DROP COLUMN sources;
