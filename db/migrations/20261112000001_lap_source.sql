-- migrate:up
-- P3b, A§7 (owner decision D2, 2026-11-12): the laps of one session can come from several sources (OpenF1, the F1
-- archive, the live recording). lap_source keeps every source's candidate rows; `lap` is rebuilt per session from
-- them (the merge), and `lap.filled` records {column: source} for each value that came from another source than
-- the row's own. is_pit_in, deleted and deleted_reason are derived after the merge, so lap_source has no such columns.

CREATE TABLE lap_source (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  lap_number smallint NOT NULL,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  date_start timestamptz,
  lap_ms int,
  s1_ms int,
  s2_ms int,
  s3_ms int,
  i1_kph smallint,
  i2_kph smallint,
  st_kph smallint,
  is_pit_out boolean,
  seg1 smallint[],
  seg2 smallint[],
  seg3 smallint[],
  quali_phase smallint,
  PRIMARY KEY (session_key, driver_number, lap_number, source)
);

ALTER TABLE lap ADD COLUMN filled jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filled) = 'object');

-- Every existing row is the candidate of its own source.
INSERT INTO lap_source (session_key, driver_number, lap_number, source, date_start, lap_ms, s1_ms, s2_ms, s3_ms,
                        i1_kph, i2_kph, st_kph, is_pit_out, seg1, seg2, seg3, quali_phase)
SELECT session_key, driver_number, lap_number, source, date_start, lap_ms, s1_ms, s2_ms, s3_ms,
       i1_kph, i2_kph, st_kph, is_pit_out, seg1, seg2, seg3, quali_phase
FROM lap;

-- No UPDATE: a writer replaces its own rows (delete, then insert). f1_api reads `lap`, never the candidates.
GRANT SELECT, INSERT, DELETE ON lap_source TO f1_ingest;

-- migrate:down
REVOKE SELECT, INSERT, DELETE ON lap_source FROM f1_ingest;
ALTER TABLE lap DROP COLUMN filled;
DROP TABLE lap_source;
