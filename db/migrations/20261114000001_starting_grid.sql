-- migrate:up
-- #115 (O1 owner, 2026-11-13): OpenF1's starting_grid, the eighth per-session endpoint, fetched for Race-type
-- sessions from their qualifying session (A§6.1, A§8). It fills result.grid (P3c's column, so no new column) and
-- stores its raw response under the race's key. No new grants: f1_ingest already writes result and raw_response.

ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result', 'weather', 'starting_grid'));

-- The re-queue (the P5a pattern): every final, not cancelled OpenF1 race and sprint goes back to fetched with its
-- first fetch time, long past, so the running daemon's next tick fetches it once more with its grid, newest first,
-- waiting out live windows (A§8). No now(): the tick's own clock decides. The down migration does not undo it.
UPDATE session SET ingest_state = 'fetched', next_fetch_at = date_end + interval '35 minutes'
WHERE ingest_state = 'final' AND NOT is_cancelled AND type = 'Race' AND source = 'openf1';

-- migrate:down
-- The grid raw rows go first, so the old CHECK can come back; a Jolpica grid stays.
DELETE FROM raw_response WHERE endpoint = 'starting_grid';
UPDATE result SET grid = NULL WHERE source = 'openf1';
ALTER TABLE raw_response
  DROP CONSTRAINT raw_response_endpoint_check,
  ADD CONSTRAINT raw_response_endpoint_check
    CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result', 'weather'));
