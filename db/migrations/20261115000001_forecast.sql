-- migrate:up
-- #120: the weekend forecast (A§7, A§8). One Open-Meteo forecast per meeting at the circuit's centre, refreshed every
-- 3 h from the Wednesday before its first session until its last session ends, and its hours: one row per hour.

CREATE TABLE forecast (
  meeting_key int PRIMARY KEY REFERENCES meeting ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'open-meteo'),
  map_id text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  state text NOT NULL CHECK (state IN ('live', 'final', 'failed')),
  next_fetch_at timestamptz,
  -- The last success: the web's "updated HH:mm".
  fetched_at timestamptz,
  fetch_count int NOT NULL DEFAULT 0,
  fail_count int NOT NULL DEFAULT 0,
  -- Every Open-Meteo attempt, success or failure, counted in the write that records its outcome (the budget seed, A§8).
  attempt_count int NOT NULL DEFAULT 0,
  -- A short code, never Open-Meteo's or PostgreSQL's text.
  last_error text CHECK (last_error ~ '^(http_[0-9]{3}|rate_limited|timeout|network|schema|db|unknown)$'),
  updated_at timestamptz NOT NULL
);

-- An hour cascades from meeting through its forecast. `date` is the end of the hour Open-Meteo sums over; any value
-- may be null. Units: %, mm, °C, m/s.
CREATE TABLE forecast_hour (
  meeting_key int NOT NULL REFERENCES forecast ON DELETE CASCADE,
  date timestamptz NOT NULL,
  precipitation_probability smallint CHECK (precipitation_probability BETWEEN 0 AND 100),
  precipitation real CHECK (precipitation >= 0),
  temperature_2m real,
  wind_speed_10m real CHECK (wind_speed_10m >= 0),
  PRIMARY KEY (meeting_key, date)
);

-- Least privilege: a forecast goes only by the cascade from its meeting (which runs as the table owner), and the job
-- replaces a forecast's hours (delete, insert) but never updates one.
GRANT SELECT, INSERT, UPDATE ON forecast TO f1_ingest;
GRANT SELECT, INSERT, DELETE ON forecast_hour TO f1_ingest;
GRANT SELECT ON forecast, forecast_hour TO f1_api;

-- migrate:down
REVOKE SELECT ON forecast, forecast_hour FROM f1_api;
REVOKE SELECT, INSERT, DELETE ON forecast_hour FROM f1_ingest;
REVOKE SELECT, INSERT, UPDATE ON forecast FROM f1_ingest;
DROP TABLE forecast_hour;
DROP TABLE forecast;
