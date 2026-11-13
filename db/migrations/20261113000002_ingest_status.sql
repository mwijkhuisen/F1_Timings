-- migrate:up
-- #105: the ingest daemon's one-row status for the api, as recorder_status. The daemon upserts it after each session
-- and each tick; display only, no host decision reads it.

CREATE TABLE ingest_status (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_sync_at timestamptz,
  live_wait boolean NOT NULL,
  last_tick_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON ingest_status TO f1_ingest;
GRANT SELECT ON ingest_status TO f1_api;

-- migrate:down
REVOKE SELECT ON ingest_status FROM f1_api;
REVOKE SELECT, INSERT, UPDATE ON ingest_status FROM f1_ingest;
DROP TABLE ingest_status;
