-- The three database logins (A§7). Runs once as the superuser from
-- /docker-entrypoint-initdb.d/ on a new volume, and in the integration tests.
-- Passwords are read server-side from the file secrets (prefix + login), so they
-- never appear in SQL text or statement logs. Idempotent. After rotating a db_*
-- secret, run this file again by hand.
DO $$
DECLARE
  prefix text := coalesce(nullif(current_setting('f1.secret_prefix', true), ''), '/run/secrets/db_');
  login text;
  pw text;
BEGIN
  FOREACH login IN ARRAY ARRAY['f1_migrator', 'f1_ingest', 'f1_api'] LOOP
    BEGIN
      pw := btrim(pg_read_file(prefix || login), E' \t\r\n');
      IF pw !~ '^[A-Za-z0-9_-]{24,}$' THEN RAISE EXCEPTION USING ERRCODE = '22023'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = login) THEN EXECUTE format('CREATE ROLE %I', login); END IF;
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', login, pw);
    EXCEPTION WHEN OTHERS THEN
      -- fixed text: the original error's context could quote the password
      RAISE EXCEPTION 'roles.sql: cannot set up login % (SQLSTATE %)', login, SQLSTATE;
    END;
  END LOOP;
  EXECUTE format('ALTER DATABASE %I OWNER TO f1_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO f1_ingest, f1_api', current_database());
  REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;  -- no login reaches another database
END $$;
