-- migrate:up
-- P7b (owner, 2026-11-16, #193, T2): one packed row per driver-lap of the car's telemetry (A§7). `car` and `pos` are
-- little-endian, column-major blobs (A§6.2); date_start is the window start the sample times count from. No FK to
-- `lap`: the merge replaces `lap` rows on every write, so a cascade would wipe telemetry on each refetch. The bounds
-- hold TELEMETRY_MAX_SAMPLES (20,000) records per topic: car is 1 + 10 bytes each, pos 9.

CREATE TABLE telemetry_lap (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  driver_number smallint NOT NULL,
  lap_number smallint NOT NULL,
  source text NOT NULL CHECK (source IN ('f1-live', 'f1-archive')),
  date_start timestamptz NOT NULL,
  car bytea NOT NULL CHECK (octet_length(car) BETWEEN 1 AND 200001),
  pos bytea NOT NULL CHECK (octet_length(pos) <= 180000),
  top_kph smallint CHECK (top_kph >= 0),
  full_throttle real CHECK (full_throttle BETWEEN 0 AND 1),
  PRIMARY KEY (session_key, driver_number, lap_number)
);

-- No UPDATE: a writer replaces its rows (delete, then insert), as lap_source. f1_api reads them.
GRANT SELECT, INSERT, DELETE ON telemetry_lap TO f1_ingest;
GRANT SELECT ON telemetry_lap TO f1_api;

-- migrate:down
REVOKE SELECT ON telemetry_lap FROM f1_api;
REVOKE SELECT, INSERT, DELETE ON telemetry_lap FROM f1_ingest;
DROP TABLE telemetry_lap;
