-- migrate:up
-- P5a: OpenF1's weather, the seventh per-session endpoint (A§7, A§8). One row per sample of the track-side
-- station, about one a minute. The columns keep OpenF1's names: temperatures °C, humidity %, pressure mbar,
-- rainfall 0 or 1, wind direction in degrees, wind speed m/s.

CREATE TABLE weather (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  date timestamptz NOT NULL,
  air_temperature real,
  track_temperature real,
  humidity real,
  pressure real,
  rainfall smallint,
  wind_direction smallint,
  wind_speed real,
  PRIMARY KEY (session_key, date)
);

ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result', 'weather'));

-- f1_ingest replaces a session's rows (delete, then insert); f1_api reads them. Nothing new on meeting or session.
GRANT SELECT, INSERT, UPDATE, DELETE ON weather TO f1_ingest;
GRANT SELECT ON weather TO f1_api;

-- The re-queue: every final, not cancelled session goes back to fetched with its first fetch time, which has
-- long passed, so the running daemon's next tick marks it due and fetches all seven endpoints once more, newest
-- first, waiting out live windows (A§8). No now(): the tick's own clock decides. The down migration does not undo
-- it (a session back in fetched is simply fetched again and becomes final).
UPDATE session SET ingest_state = 'fetched', next_fetch_at = date_end + interval '35 minutes'
WHERE ingest_state = 'final' AND NOT is_cancelled;

-- migrate:down
-- The weather raw rows go first, so the old CHECK can come back.
DELETE FROM raw_response WHERE endpoint = 'weather';
ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result'));
REVOKE SELECT ON weather FROM f1_api;
REVOKE SELECT, INSERT, UPDATE, DELETE ON weather FROM f1_ingest;
DROP TABLE weather;
