-- P8 [box]: the facts behind the championship standings (A§6.1, A§7, A§8) over the OpenF1 races and sprints of 2023 on,
-- once the re-queue of 20261115000002_standings.sql has drained (/status shows no extra `fetched`).
--
-- Read-only: it runs as f1_api (SELECT only) inside a READ ONLY transaction that is rolled back. It prints counts
-- and session keys only, never a name, a number of points or a position.
--
-- On the VM:
--   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
--     psql -U postgres -d f1 -X -v ON_ERROR_STOP=1 -f - < standings-facts.sql

SET ROLE f1_api;
BEGIN READ ONLY;

\echo '1. Result rows of the OpenF1 races and sprints per season: with and without points'
SELECT m.year, s.name,
  count(*) AS rows,
  count(*) FILTER (WHERE r.points IS NOT NULL) AS with_points,
  count(*) FILTER (WHERE r.points IS NULL) AS without_points
FROM result r
JOIN session s USING (session_key)
JOIN meeting m USING (meeting_key)
WHERE r.source = 'openf1' AND s.type = 'Race' AND m.year >= 2023 AND s.name IN ('Race', 'Sprint')
GROUP BY ROLLUP (m.year, s.name) ORDER BY m.year NULLS LAST, s.name NULLS LAST;

\echo '2. Counted sessions (fetched or final, not cancelled) per season: with and without championship rows'
WITH s AS (
  SELECT s.session_key, m.year, s.name,
    (SELECT count(*) FROM championship_driver c WHERE c.session_key = s.session_key) AS drivers,
    (SELECT count(*) FROM championship_team c WHERE c.session_key = s.session_key) AS teams
  FROM session s JOIN meeting m USING (meeting_key)
  WHERE s.source = 'openf1' AND s.type = 'Race' AND m.year >= 2023 AND NOT s.is_cancelled
    AND s.ingest_state IN ('fetched', 'final'))
SELECT year, name, count(*) AS sessions,
  count(*) FILTER (WHERE drivers > 0) AS with_drivers, count(*) FILTER (WHERE drivers = 0) AS without_drivers,
  count(*) FILTER (WHERE teams > 0) AS with_teams, count(*) FILTER (WHERE teams = 0) AS without_teams
FROM s GROUP BY ROLLUP (year, name) ORDER BY year NULLS LAST, name NULLS LAST;

\echo '3. The counted sessions without driver or team rows (keys only)'
SELECT s.session_key, m.year, s.name,
  NOT EXISTS (SELECT 1 FROM championship_driver c WHERE c.session_key = s.session_key) AS no_drivers,
  NOT EXISTS (SELECT 1 FROM championship_team c WHERE c.session_key = s.session_key) AS no_teams
FROM session s JOIN meeting m USING (meeting_key)
WHERE s.source = 'openf1' AND s.type = 'Race' AND m.year >= 2023 AND NOT s.is_cancelled
  AND s.ingest_state IN ('fetched', 'final')
  AND (NOT EXISTS (SELECT 1 FROM championship_driver c WHERE c.session_key = s.session_key)
    OR NOT EXISTS (SELECT 1 FROM championship_team c WHERE c.session_key = s.session_key))
ORDER BY s.date_start DESC, s.session_key;

ROLLBACK;
