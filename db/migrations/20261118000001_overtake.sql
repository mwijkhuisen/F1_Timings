-- migrate:up
-- #236 (owner, 2026-11-18, D1, D2): one row per OvertakeSeries entry, the places a car gained in one move as the F1
-- feed counts them (the start and pit stops included, U4). `fill` writes them from the archive or the recording. No
-- natural key: a car can gain twice at one time, so rows are ordered by (date, driver_number, id).

CREATE TABLE overtake (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  date timestamptz NOT NULL,
  places smallint NOT NULL CHECK (places BETWEEN 1 AND 99),
  source text NOT NULL CHECK (source IN ('f1-archive', 'f1-live'))
);
CREATE INDEX overtake_session_date ON overtake (session_key, date);

-- No UPDATE: a writer replaces a session's rows (delete, then insert), as lap_source. f1_api reads them.
GRANT SELECT, INSERT, DELETE ON overtake TO f1_ingest;
GRANT SELECT ON overtake TO f1_api;

-- migrate:down
REVOKE SELECT ON overtake FROM f1_api;
REVOKE SELECT, INSERT, DELETE ON overtake FROM f1_ingest;
DROP TABLE overtake;
