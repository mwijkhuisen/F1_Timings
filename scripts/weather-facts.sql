-- P5a [box]: the facts of OpenF1's weather endpoint over every session in the database, once the re-queue of
-- 20261109000001_weather.sql has drained (/status shows no extra `fetched`). Written into A§6.1.
--
-- Read-only: it runs as f1_api (SELECT only) inside a READ ONLY transaction that is rolled back, and it prints
-- counts and intervals only, never a reading.
--
-- On the VM:
--   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
--     psql -U postgres -d f1 -X -v ON_ERROR_STOP=1 -f - < weather-facts.sql

SET ROLE f1_api;
BEGIN READ ONLY;

\echo '1. Sessions per ingest_state (not cancelled), and the cancelled count'
SELECT CASE WHEN is_cancelled THEN '(cancelled)' ELSE ingest_state END AS state, count(*) AS sessions
FROM session GROUP BY 1 ORDER BY 1;

\echo '2. Past sessions with and without weather rows, by year and type (fetched or final, not cancelled)'
WITH s AS (
  SELECT s.session_key, m.year, s.type,
    (SELECT count(*) FROM weather w WHERE w.session_key = s.session_key) AS rows
  FROM session s JOIN meeting m USING (meeting_key)
  WHERE NOT s.is_cancelled AND s.ingest_state IN ('fetched', 'final'))
SELECT year, type, count(*) AS sessions, count(*) FILTER (WHERE rows > 0) AS with_weather,
  count(*) FILTER (WHERE rows = 0) AS without, sum(rows) AS rows
FROM s GROUP BY ROLLUP (year, type) ORDER BY year NULLS LAST, type NULLS LAST;

\echo '3. Rainfall values: rows and sessions'
SELECT rainfall, count(*) AS rows, count(DISTINCT session_key) AS sessions
FROM weather GROUP BY 1 ORDER BY 1 NULLS LAST;

\echo '4. Nulls, zeros (dropouts) and calm samples per column'
SELECT count(*) AS rows,
  count(*) FILTER (WHERE air_temperature IS NULL) AS air,
  count(*) FILTER (WHERE track_temperature IS NULL) AS track,
  count(*) FILTER (WHERE humidity IS NULL) AS humidity,
  count(*) FILTER (WHERE pressure IS NULL) AS pressure,
  count(*) FILTER (WHERE rainfall IS NULL) AS rainfall,
  count(*) FILTER (WHERE wind_direction IS NULL) AS wind_direction,
  count(*) FILTER (WHERE wind_speed IS NULL) AS wind_speed,
  count(*) FILTER (WHERE humidity <> round(humidity)) AS humidity_fractional,
  -- A dropout comes as 0 (A§6.1); the web reads these as no reading.
  count(*) FILTER (WHERE air_temperature = 0) AS air_0,
  count(*) FILTER (WHERE track_temperature = 0) AS track_0,
  count(*) FILTER (WHERE humidity = 0) AS humidity_0,
  count(*) FILTER (WHERE pressure = 0) AS pressure_0,
  count(*) FILTER (WHERE wind_speed = 0) AS calm,
  count(*) FILTER (WHERE wind_direction = 0 AND wind_speed > 0) AS direction_0_with_wind,
  min(wind_direction) AS wind_direction_min, max(wind_direction) AS wind_direction_max
FROM weather;

\echo '5. The interval between consecutive samples of a session (s): median, p95, max, and gaps over 5 min'
WITH gaps AS (
  SELECT extract(epoch FROM date - lag(date) OVER (PARTITION BY session_key ORDER BY date)) AS s, session_key
  FROM weather)
SELECT count(s) AS intervals,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY s) AS p95,
  max(s) AS max,
  count(*) FILTER (WHERE s > 300) AS over_5_min,
  count(DISTINCT session_key) FILTER (WHERE s > 300) AS sessions_with_a_gap
FROM gaps;

\echo '6. Where the rows sit against the session (min): first row - date_start and last row - date_end, by type'
WITH e AS (
  SELECT s.type, extract(epoch FROM min(w.date) - s.date_start) / 60 AS first_min,
    extract(epoch FROM max(w.date) - s.date_end) / 60 AS last_min
  FROM weather w JOIN session s USING (session_key) GROUP BY s.session_key, s.type, s.date_start, s.date_end)
SELECT type, count(*) AS sessions,
  round(min(first_min)::numeric, 1) AS first_min_lo,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_min))::numeric, 1) AS first_median,
  round(max(first_min)::numeric, 1) AS first_hi,
  round(min(last_min)::numeric, 1) AS last_lo,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY last_min))::numeric, 1) AS last_median,
  round(max(last_min)::numeric, 1) AS last_hi
FROM e GROUP BY ROLLUP (type) ORDER BY type NULLS LAST;

\echo '7. Rows outside [date_start - 1 h, date_end + 1 h], and the sessions that have them'
SELECT count(*) AS rows, count(DISTINCT w.session_key) AS sessions,
  count(*) FILTER (WHERE w.date < s.date_start - interval '1 hour') AS early,
  count(*) FILTER (WHERE w.date > s.date_end + interval '1 hour') AS late
FROM weather w JOIN session s USING (session_key)
WHERE w.date < s.date_start - interval '1 hour' OR w.date > s.date_end + interval '1 hour';

ROLLBACK;
