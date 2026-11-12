-- migrate:up
-- P3c (owner decisions 2026-11-12), A§7: Jolpica's 1950-2017 data. The new job writes only these seven tables, so
-- only their source CHECK learns 'jolpica'; stint, race_control, raw_response, weather and recording keep three values.
-- No new grants: f1_ingest already writes all seven. result.grid is the race's starting grid position from Jolpica
-- (0 = pit-lane start); OpenF1 and the archive leave it null.
-- Rollback: an image rollback past P3c needs this down migration first, because the previous image's merge rank()
-- (apps/server/src/merge/merge.ts) throws on a source outside its ORDER.

ALTER TABLE meeting
  DROP CONSTRAINT meeting_source_check,
  ADD CONSTRAINT meeting_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE session
  DROP CONSTRAINT session_source_check,
  ADD CONSTRAINT session_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE driver
  DROP CONSTRAINT driver_source_check,
  ADD CONSTRAINT driver_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE lap
  DROP CONSTRAINT lap_source_check,
  ADD CONSTRAINT lap_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE lap_source
  DROP CONSTRAINT lap_source_source_check,
  ADD CONSTRAINT lap_source_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE pit
  DROP CONSTRAINT pit_source_check,
  ADD CONSTRAINT pit_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));
ALTER TABLE result
  DROP CONSTRAINT result_source_check,
  ADD CONSTRAINT result_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live', 'jolpica'));

ALTER TABLE result ADD COLUMN grid smallint;

-- migrate:down
-- lap.filled values naming jolpica stay until the next merge of that session (no CHECK reads its content).
DELETE FROM meeting WHERE source = 'jolpica'; -- cascades through session and every child
DELETE FROM lap_source WHERE source = 'jolpica';
DELETE FROM lap WHERE source = 'jolpica';
DELETE FROM driver WHERE source = 'jolpica';
DELETE FROM pit WHERE source = 'jolpica';
DELETE FROM result WHERE source = 'jolpica';
ALTER TABLE result DROP COLUMN grid;

ALTER TABLE meeting
  DROP CONSTRAINT meeting_source_check,
  ADD CONSTRAINT meeting_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE session
  DROP CONSTRAINT session_source_check,
  ADD CONSTRAINT session_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE driver
  DROP CONSTRAINT driver_source_check,
  ADD CONSTRAINT driver_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE lap
  DROP CONSTRAINT lap_source_check,
  ADD CONSTRAINT lap_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE lap_source
  DROP CONSTRAINT lap_source_source_check,
  ADD CONSTRAINT lap_source_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE pit
  DROP CONSTRAINT pit_source_check,
  ADD CONSTRAINT pit_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
ALTER TABLE result
  DROP CONSTRAINT result_source_check,
  ADD CONSTRAINT result_source_check CHECK (source IN ('openf1', 'f1-archive', 'f1-live'));
