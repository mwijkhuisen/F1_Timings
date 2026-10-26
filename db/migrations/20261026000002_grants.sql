-- migrate:up
-- Logins come from deploy/postgres/roles.sql. Later phases grant their own tables.
GRANT USAGE ON SCHEMA public TO f1_ingest, f1_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  meeting, session, driver, lap, stint, pit, race_control, result, raw_response TO f1_ingest;
GRANT SELECT ON meeting, session, driver, lap, stint, pit, race_control, result TO f1_api;

-- migrate:down
REVOKE SELECT ON meeting, session, driver, lap, stint, pit, race_control, result FROM f1_api;
REVOKE SELECT, INSERT, UPDATE, DELETE ON
  meeting, session, driver, lap, stint, pit, race_control, result, raw_response FROM f1_ingest;
REVOKE USAGE ON SCHEMA public FROM f1_ingest, f1_api;
