-- P5c [box]: the state of the rain job (A§8) on the VM, a day after the deploy and again after the backfill has
-- drained (about 4 days: 490 sessions x 49 location-calls at no more than 6,400 a day).
--
-- Read-only: it runs as f1_api (SELECT only) inside a READ ONLY transaction that is rolled back. It prints names,
-- counts, dates and fixed error codes; no precipitation value and no coordinate is printed. It reads now() (a
-- diagnostic, never a state decision).
--
-- On the VM:
--   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
--     psql -U postgres -d f1 -X -v ON_ERROR_STOP=1 -f - < rain-facts.sql
--
-- What each result should show:
--   1. 0 rows: every circuit_short_name in `meeting` has an outline (CIRCUITS in packages/contracts). A row is a
--      venue that gets no grid ("No circuit outline for this venue.", A§13); add it to scripts/map-extract.ts.
--      The names below are pinned to CIRCUITS by test/rain-facts.test.ts.
--   2. Grids per state and last_error: `live` while a session is in its window or waits for end + 24 h, `final`
--      for the rest. `failed` (the 9th failure in a row) has no automatic retry: reset it by hand.
--   3. Mapped sessions past end + 24 h without a grid: 0 once the backfill has drained.
--   4. The location-calls spent (an upper bound, as the budget's restart seed: A§8) and the grids touched per UTC
--      day: no day above 8,000, which is the budget's cap (D3).
--   5. Frames per grid: a final grid has about 4 * (session length + 1.5 h) + 1 frames (a race of 2 h: about 15);
--      no grid in `final` without frames.
--   6. 0 frames outside [date_start - 75 min, date_end + 45 min] (the fetch window is floor15(date_start - 60 min)
--      to ceil15(date_end + 30 min)).

SET ROLE f1_api;
BEGIN READ ONLY;

-- The mapped circuits, once: CIRCUITS' keys (OpenF1's circuit_short_name). \gset puts them into :mapped as a
-- quoted list for the queries below.
SELECT string_agg(quote_literal(name), ', ') AS mapped FROM (VALUES
  ('Austin'),
  ('Baku'),
  ('Catalunya'),
  ('Hungaroring'),
  ('Imola'),
  ('Interlagos'),
  ('Jeddah'),
  ('Kuala Lumpur'),
  ('Las Vegas'),
  ('Lusail'),
  ('Madring'),
  ('Melbourne'),
  ('Mexico City'),
  ('Miami'),
  ('Monte Carlo'),
  ('Montreal'),
  ('Monza'),
  ('Sakhir'),
  ('Shanghai'),
  ('Silverstone'),
  ('Singapore'),
  ('Spa-Francorchamps'),
  ('Spielberg'),
  ('Suzuka'),
  ('Yas Marina Circuit'),
  ('Zandvoort')
) AS m(name) \gset

\echo '1. Circuit names in meeting without a mapping (expected 0 rows)'
SELECT circuit_short_name, count(*) AS meetings
FROM meeting
WHERE circuit_short_name IS NULL OR circuit_short_name NOT IN (:mapped)
GROUP BY 1 ORDER BY 1;

\echo '2. Grids per state and last_error'
SELECT state, last_error, count(*) AS grids, max(fail_count) AS max_fail_count, max(updated_at) AS last_update
FROM rain_grid GROUP BY 1, 2 ORDER BY 1, 2 NULLS FIRST;

\echo '3. Mapped sessions past date_end + 24 h without a grid (the backfill left; not cancelled, at most 12 h long)'
SELECT count(*) AS sessions, min(s.date_end) AS oldest_end, max(s.date_end) AS newest_end
FROM session s JOIN meeting m USING (meeting_key)
WHERE NOT s.is_cancelled
  AND s.date_end - s.date_start <= interval '12 hours'
  AND s.date_end <= now() - interval '24 hours'
  AND m.circuit_short_name IN (:mapped)
  AND NOT EXISTS (SELECT 1 FROM rain_grid g WHERE g.session_key = s.session_key);

\echo '4a. Location-calls spent in total: sum(attempt_count * size^2)'
SELECT count(*) AS grids, sum(fetch_count) AS fetches, sum(attempt_count) AS attempts,
  sum(attempt_count * size * size) AS location_calls
FROM rain_grid;

\echo '4b. Grids last touched per UTC day (the last 14 days)'
SELECT (updated_at AT TIME ZONE 'UTC')::date AS day_utc, count(*) AS grids,
  sum(attempt_count * size * size) AS location_calls_upper_bound
FROM rain_grid
WHERE updated_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1 DESC;

\echo '5. Frames per grid (min, median, max) by state, and the grids with no frames'
WITH f AS (
  SELECT g.session_key, g.state, count(r.session_key) AS frames
  FROM rain_grid g LEFT JOIN rain_frame r USING (session_key)
  GROUP BY g.session_key, g.state)
SELECT state, count(*) AS grids, min(frames) AS min, percentile_cont(0.5) WITHIN GROUP (ORDER BY frames) AS median,
  max(frames) AS max, count(*) FILTER (WHERE frames = 0) AS without_frames
FROM f GROUP BY ROLLUP (state) ORDER BY state NULLS LAST;

\echo '6. Frames outside [date_start - 75 min, date_end + 45 min] (expected 0 rows counted)'
SELECT count(*) AS frames, count(DISTINCT r.session_key) AS grids,
  count(*) FILTER (WHERE r.date < s.date_start - interval '75 minutes') AS early,
  count(*) FILTER (WHERE r.date > s.date_end + interval '45 minutes') AS late
FROM rain_frame r JOIN session s USING (session_key)
WHERE r.date < s.date_start - interval '75 minutes' OR r.date > s.date_end + interval '45 minutes';

ROLLBACK;
