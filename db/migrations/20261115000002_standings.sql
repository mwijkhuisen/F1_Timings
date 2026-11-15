-- migrate:up
-- P8 (owner, 2026-11-15, #123, D4): the championship standings of 2023 on (A§6.1, A§7, A§8). result.points holds
-- OpenF1's session_result points (races and sprints only; null elsewhere, and for archive and Jolpica rows).
-- championship_drivers and championship_teams are the ninth and tenth per-session endpoints, fetched for
-- Race-type sessions under the session's own key; the tables keep OpenF1's names and are replaced per session.

ALTER TABLE result ADD COLUMN points real;

CREATE TABLE championship_driver (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  position_start smallint,
  position_current smallint,
  points_start real,
  points_current real,
  PRIMARY KEY (session_key, driver_number)
);

CREATE TABLE championship_team (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  team_name text NOT NULL,
  position_start smallint,
  position_current smallint,
  points_start real,
  points_current real,
  PRIMARY KEY (session_key, team_name)
);

ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result', 'weather', 'starting_grid',
                        'championship_drivers', 'championship_teams'));

-- f1_ingest replaces a session's rows (delete, then insert) and never updates one; f1_api reads them. Nothing new
-- on meeting or session.
GRANT SELECT, INSERT, DELETE ON championship_driver, championship_team TO f1_ingest;
GRANT SELECT ON championship_driver, championship_team TO f1_api;

-- The re-queue (the P5a pattern): every final, not cancelled OpenF1 race and sprint of 2023 on goes back to fetched
-- with its first fetch time, long past, so the running daemon's next tick fetches it once more with the two new
-- endpoints and result.points, newest first, waiting out live windows (A§8). No now(): the tick's own clock decides.
-- The down migration does not undo it.
UPDATE session SET ingest_state = 'fetched', next_fetch_at = date_end + interval '35 minutes'
WHERE ingest_state = 'final' AND NOT is_cancelled AND type = 'Race' AND source = 'openf1'
  AND meeting_key IN (SELECT meeting_key FROM meeting WHERE year >= 2023);

-- migrate:down
-- The two endpoints' raw rows go first, so the old CHECK can come back.
DELETE FROM raw_response WHERE endpoint IN ('championship_drivers', 'championship_teams');
ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result', 'weather', 'starting_grid'));
REVOKE SELECT ON championship_driver, championship_team FROM f1_api;
REVOKE SELECT, INSERT, DELETE ON championship_driver, championship_team FROM f1_ingest;
DROP TABLE championship_team;
DROP TABLE championship_driver;
ALTER TABLE result DROP COLUMN points;
