-- migrate:up
-- P5c: the rain map (A§7; owner, 2026-11-07, D1 and C2). One grid per session of 7 x 7 modelled precipitation
-- points around the circuit, and its frames: one row per 15 minutes, mm of precipitation per grid point.

CREATE TABLE rain_grid (
  session_key int PRIMARY KEY REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'open-meteo'),
  map_id text NOT NULL,
  centre_lat double precision NOT NULL CHECK (centre_lat BETWEEN -90 AND 90),
  centre_lon double precision NOT NULL CHECK (centre_lon BETWEEN -180 AND 180),
  -- The grid is 7 x 7 (D1, A§6.3). Another size is a new migration, because rain_frame's cardinality CHECK
  -- cannot read this table.
  size smallint NOT NULL CHECK (size = 7),
  step_m int NOT NULL CHECK (step_m > 0),
  state text NOT NULL CHECK (state IN ('live', 'final', 'failed')),
  next_fetch_at timestamptz,
  fetch_count int NOT NULL DEFAULT 0,
  fail_count int NOT NULL DEFAULT 0,
  -- A short code, never Open-Meteo's or PostgreSQL's text.
  last_error text CHECK (last_error ~ '^(http_[0-9]{3}|rate_limited|timeout|network|schema|db|unknown)$'),
  updated_at timestamptz NOT NULL
);

-- C2: a frame cascades from session through its grid, and never exists without one. mm is the precipitation per
-- 15 minutes at each grid point, row-major from the north-west; an element may be null.
CREATE TABLE rain_frame (
  session_key int NOT NULL REFERENCES rain_grid ON DELETE CASCADE,
  date timestamptz NOT NULL,
  mm real[] NOT NULL CHECK (cardinality(mm) = 49),
  PRIMARY KEY (session_key, date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON rain_grid, rain_frame TO f1_ingest;
GRANT SELECT ON rain_grid, rain_frame TO f1_api;

-- migrate:down
REVOKE SELECT ON rain_grid, rain_frame FROM f1_api;
REVOKE SELECT, INSERT, UPDATE, DELETE ON rain_grid, rain_frame FROM f1_ingest;
DROP TABLE rain_frame;
DROP TABLE rain_grid;
