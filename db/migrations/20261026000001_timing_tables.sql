-- migrate:up
-- A§7 tables (minus recording). Times timestamptz, durations integer ms, speeds smallint km/h.

CREATE TABLE meeting (
  meeting_key int PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  year smallint NOT NULL,
  name text,
  official_name text,
  location text,
  country_code text,
  circuit_short_name text,
  gmt_offset text,
  date_start timestamptz,
  date_end timestamptz,
  is_cancelled boolean NOT NULL DEFAULT false
);

CREATE TABLE session (
  session_key int PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  meeting_key int NOT NULL REFERENCES meeting ON DELETE CASCADE,
  type text,
  name text,
  date_start timestamptz NOT NULL,
  date_end timestamptz NOT NULL,
  is_cancelled boolean NOT NULL DEFAULT false,
  ingest_state text NOT NULL DEFAULT 'scheduled'
    CHECK (ingest_state IN ('scheduled', 'due', 'fetched', 'final', 'failed')),
  next_fetch_at timestamptz,
  fetch_count smallint NOT NULL DEFAULT 0,
  fail_count smallint NOT NULL DEFAULT 0,
  last_error text CHECK (last_error ~ '^(http_[0-9]{3}|rate_limited|timeout|network|schema|empty|db|unknown)$')
);
CREATE INDEX session_meeting_key ON session (meeting_key);

CREATE TABLE driver (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  acronym text,
  full_name text,
  team_name text,
  team_colour text,
  PRIMARY KEY (session_key, driver_number)
);

CREATE TABLE lap (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  lap_number smallint NOT NULL,
  date_start timestamptz,
  lap_ms int,
  s1_ms int,
  s2_ms int,
  s3_ms int,
  i1_kph smallint,
  i2_kph smallint,
  st_kph smallint,
  is_pit_out boolean,
  is_pit_in boolean NOT NULL DEFAULT false,
  seg1 smallint[],
  seg2 smallint[],
  seg3 smallint[],
  deleted boolean NOT NULL DEFAULT false,
  deleted_reason text,
  quali_phase smallint,
  PRIMARY KEY (session_key, driver_number, lap_number)
);

CREATE TABLE stint (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  stint_number smallint NOT NULL,
  lap_start smallint,
  lap_end smallint,
  compound text,
  tyre_age_at_start smallint,
  PRIMARY KEY (session_key, driver_number, stint_number)
);

CREATE TABLE pit (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  lap_number smallint NOT NULL,
  date timestamptz,
  pit_ms int,
  lane_ms int,
  stop_ms int,
  PRIMARY KEY (session_key, driver_number, lap_number)
);

CREATE TABLE race_control (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  date timestamptz,
  category text,
  flag text,
  scope text,
  sector smallint,
  driver_number smallint,
  lap_number smallint,
  qualifying_phase smallint,
  message text
);
CREATE INDEX race_control_session_date ON race_control (session_key, date);

CREATE TABLE result (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  driver_number smallint NOT NULL,
  position smallint,
  laps smallint,
  dnf boolean,
  dns boolean,
  dsq boolean,
  durations_ms int[],
  gaps_ms int[],
  PRIMARY KEY (session_key, driver_number)
);

CREATE TABLE raw_response (
  session_key int NOT NULL REFERENCES session ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('openf1', 'f1-archive', 'f1-live')),
  endpoint text NOT NULL CHECK (endpoint IN ('drivers', 'laps', 'stints', 'pit', 'race_control', 'session_result')),
  fetched_at timestamptz NOT NULL,
  http_status smallint NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (session_key, endpoint)
);

-- migrate:down
DROP TABLE raw_response;
DROP TABLE result;
DROP TABLE race_control;
DROP TABLE pit;
DROP TABLE stint;
DROP TABLE lap;
DROP TABLE driver;
DROP TABLE session;
DROP TABLE meeting;
