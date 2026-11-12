-- P3c [box]: the database side of the Jolpica import (A§7), after `jolpica` has run on the whole dump.
--
-- Read-only: it runs as f1_api (SELECT only) inside a READ ONLY transaction that is rolled back. It prints years,
-- session keys, column names and counts; no name, time or other value.
--
-- On the VM:
--   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
--     psql -U postgres -d f1 -X -q -v ON_ERROR_STOP=1 -f - < jolpica-facts.sql
--
-- What each result should show:
--   1. The counts per year 1950-2017 of the rows with source 'jolpica', tab-separated in the column order of
--      scripts/jolpica-counts.py, which counts the same from the dump: the two tables must be equal, row by row
--      (runbook update.md, "Verify [box]"). laps and pits are the lap and pit rows of the races.
--   2. 0 races from 1996 on without a lap row (the dump has laps for every race since 1996).
--   3. The 2018+ tier: the lap values Jolpica filled, per column (only lap_ms: its candidates carry nothing else),
--      and the laps it added to OpenF1 or archive races, per session. Each added lap is one only Jolpica has.

SET ROLE f1_api;
BEGIN READ ONLY;
\pset format unaligned
\pset fieldsep '\t'
\pset footer off

\echo '1. Counts per year (equal to jolpica-counts.py)'
WITH s AS (
  SELECT s.session_key, s.type, m.year
  FROM session s JOIN meeting m USING (meeting_key)
  WHERE s.source = 'jolpica'),
r AS (SELECT session_key, count(*) AS n FROM result WHERE source = 'jolpica' GROUP BY 1),
l AS (SELECT session_key, count(*) AS n FROM lap WHERE source = 'jolpica' GROUP BY 1),
p AS (SELECT session_key, count(*) AS n FROM pit WHERE source = 'jolpica' GROUP BY 1),
y AS (
  SELECT y.year::text AS year,
    count(s.session_key) FILTER (WHERE s.type = 'Race') AS races,
    count(s.session_key) FILTER (WHERE s.type = 'Qualifying') AS qualifyings,
    coalesce(sum(r.n) FILTER (WHERE s.type = 'Race'), 0) AS race_entries,
    coalesce(sum(r.n) FILTER (WHERE s.type = 'Qualifying'), 0) AS quali_entries,
    coalesce(sum(l.n) FILTER (WHERE s.type = 'Race'), 0) AS laps,
    coalesce(sum(p.n) FILTER (WHERE s.type = 'Race'), 0) AS pits
  FROM generate_series(1950, 2017) AS y(year)
  LEFT JOIN s ON s.year = y.year
  LEFT JOIN r USING (session_key) LEFT JOIN l USING (session_key) LEFT JOIN p USING (session_key)
  GROUP BY y.year)
SELECT * FROM y
UNION ALL
SELECT 'TOTAL', sum(races), sum(qualifyings), sum(race_entries), sum(quali_entries), sum(laps), sum(pits) FROM y
ORDER BY year;

\echo '2. Races 1996-2017 and those without a lap row (expected 0)'
SELECT count(*) AS races,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lap l WHERE l.session_key = s.session_key)) AS without_laps
FROM session s JOIN meeting m USING (meeting_key)
WHERE s.source = 'jolpica' AND s.type = 'Race' AND m.year BETWEEN 1996 AND 2017;

\echo '3a. The 2018+ tier: values Jolpica filled on OpenF1 and archive laps, per column'
SELECT f.key AS column, count(*) AS laps
FROM lap l JOIN session s USING (session_key), jsonb_each_text(l.filled) AS f
WHERE s.source <> 'jolpica' AND f.value = 'jolpica'
GROUP BY 1 ORDER BY 1;

\echo '3b. The 2018+ tier: laps Jolpica added, per session'
SELECT l.session_key, count(*) AS laps
FROM lap l JOIN session s USING (session_key)
WHERE s.source <> 'jolpica' AND l.source = 'jolpica'
GROUP BY 1 ORDER BY 1;

ROLLBACK;
