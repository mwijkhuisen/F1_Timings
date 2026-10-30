-- migrate:up
-- P2c: one row per recorded live session, and the recorder's one-row status for the api.
-- `path` is relative to /srv/f1/live, and the recorder joins it to a directory: ingest shares the login, so its shape
-- is pinned here. RESTRICT: recordings stay replayable forever (ADR-0007). last_error holds fixed codes only.

CREATE TABLE recording (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_key int NOT NULL REFERENCES session ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'f1-live' CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  path text NOT NULL UNIQUE CHECK (path ~ '^[0-9]+-[0-9]+$'),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  bytes bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false
);
CREATE INDEX recording_session_key ON recording (session_key);

CREATE TABLE recorder_status (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  state text NOT NULL CHECK (state IN ('idle', 'connecting', 'recording')),
  session_key int REFERENCES session ON DELETE SET NULL,
  token_expires_at timestamptz,
  last_error text CHECK (last_error ~ '^(no_credentials|login_(discovery|authorize|signin|token|claims)|token_(file|format|expired)|feed_(unauthorized|options|negotiate|socket|parse|handshake|subscribe|timeout)|disk|disk_low|unknown)$'),
  warning text CHECK (warning IN ('token_expiring', 'login_failed', 'disk_low')),
  login_failures int NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  updated_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON recording, recorder_status TO f1_ingest;
GRANT SELECT ON recording, recorder_status TO f1_api;

-- migrate:down
REVOKE SELECT ON recording, recorder_status FROM f1_api;
REVOKE SELECT, INSERT, UPDATE ON recording, recorder_status FROM f1_ingest;
DROP TABLE recorder_status;
DROP TABLE recording;
