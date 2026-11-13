-- P4b [box]: the race-control forms that trackPeriods (apps/web/src/lib/track.ts) relies on, over every
-- race and sprint (session.type = 'Race', not cancelled) of the years of the psql variables from and to
-- (default 2023 and 2026). Written into A§6.1.
--
-- Read-only: it runs as f1_api (SELECT only) inside a READ ONLY transaction that is rolled back, and it
-- prints counts, and in query 2 each distinct message of the period-class rows (safety car, VSC, red flag,
-- restart, chequered flag) with only its digits masked. Stewards' notes are left out. Query 6 lists the
-- period-like rows that no form of queries 3 to 5 accepts (class NULL), digits masked, with counts. Its two
-- patterns are PERIOD_LIKE and IGNORED of packages/contracts/src/race-control.ts, verbatim (what /status
-- lists as races with unknown wording; test/race-control-forms.test.ts pins it). The CASE below is its own copy.
--
-- For 2018-2022, queries 2 and 6 print F1-archive text: it stays on the VM and is never pasted into the
-- repository, a PR or an issue (A§12.1 invariant 3); only counts are quoted.
--
-- On the VM (add -v from=2018 -v to=2022 for the archive years):
--   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
--     psql -U postgres -d f1 -X -v ON_ERROR_STOP=1 -f - < race-control-forms.sql
--
-- The classes in queries 3 to 5 use the same patterns as track.ts:
--   VSC+  ^(VIRTUAL SAFETY CAR|VSC) DEPLOYED     VSC-  ^(VIRTUAL SAFETY CAR|VSC) ENDING
--   SC+   ^SAFETY CAR DEPLOYED                   SC-   ^SAFETY CAR IN THIS LAP
--   RED   flag RED, or ^RED FLAG                 RESUME ^RACE WILL RESUME
--   END   flag CHEQUERED

\if :{?from}
\else
  \set from 2023
\endif
\if :{?to}
\else
  \set to 2026
\endif

SET ROLE f1_api;
BEGIN READ ONLY;

\echo '1. Race-control rows per year, and rows without a lap number'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int)
SELECT r.year, count(DISTINCT rc.session_key) AS races, count(*) AS rows,
  count(*) FILTER (WHERE rc.lap_number IS NULL) AS no_lap
FROM race_control rc JOIN races r USING (session_key)
GROUP BY ROLLUP (r.year) ORDER BY r.year NULLS LAST;

\echo '2. The forms (digits as #) of safety-car, VSC, red-flag, suspension, resumption and chequered rows'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int)
SELECT rc.category, rc.flag, regexp_replace(rc.message, '[0-9]+', '#', 'g') AS form, count(*) AS n,
  count(*) FILTER (WHERE rc.lap_number IS NULL) AS no_lap, count(DISTINCT rc.session_key) AS races,
  min(r.year) AS first_year, max(r.year) AS last_year
FROM race_control rc JOIN races r USING (session_key)
WHERE (rc.category = 'SafetyCar' OR rc.flag IN ('RED', 'CHEQUERED')
       OR rc.message ~ '(SAFETY CAR|VSC|RED FLAG|SUSPENDED|RESUME)')
  AND rc.message !~ '(INCIDENT|STEWARDS|INFRINGEMENT)'
GROUP BY 1, 2, 3 ORDER BY n DESC, form;

\echo '3. What follows each class in the same race (how each period ends)'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int),
classed AS (
  SELECT rc.id, rc.session_key, rc.date, rc.lap_number,
    CASE
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) DEPLOYED' THEN 'VSC+'
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) ENDING' THEN 'VSC-'
      WHEN rc.message ~ '^SAFETY CAR DEPLOYED' THEN 'SC+'
      WHEN rc.message ~ '^SAFETY CAR IN THIS LAP' THEN 'SC-'
      WHEN rc.flag = 'RED' OR rc.message ~ '^RED FLAG' THEN 'RED'
      WHEN rc.message ~ '^RACE WILL RESUME' THEN 'RESUME'
      WHEN rc.flag = 'CHEQUERED' THEN 'END'
    END AS class
  FROM race_control rc JOIN races USING (session_key))
SELECT class, coalesce(next, '(none)') AS next, count(*) AS n
FROM (SELECT class, lead(class) OVER (PARTITION BY session_key ORDER BY date, id) AS next
      FROM classed WHERE class IS NOT NULL) t
GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2;

\echo '4. lap_number against the leader''s lap (the highest lap any driver had started by the row''s date)'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int),
classed AS (
  SELECT rc.id, rc.session_key, rc.date, rc.lap_number,
    CASE
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) DEPLOYED' THEN 'VSC+'
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) ENDING' THEN 'VSC-'
      WHEN rc.message ~ '^SAFETY CAR DEPLOYED' THEN 'SC+'
      WHEN rc.message ~ '^SAFETY CAR IN THIS LAP' THEN 'SC-'
      WHEN rc.flag = 'RED' OR rc.message ~ '^RED FLAG' THEN 'RED'
      WHEN rc.message ~ '^RACE WILL RESUME' THEN 'RESUME'
      WHEN rc.flag = 'CHEQUERED' THEN 'END'
    END AS class
  FROM race_control rc JOIN races USING (session_key))
SELECT c.class, c.lap_number - (SELECT max(l.lap_number) FROM lap l
                                WHERE l.session_key = c.session_key AND l.date_start <= c.date) AS diff,
  count(*) AS n
FROM classed c
WHERE c.class IN ('SC+', 'SC-', 'VSC+', 'VSC-', 'RED') AND c.lap_number IS NOT NULL AND c.date IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo '5. Rows of a period class without a lap number (listed, never banded)'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int),
classed AS (
  SELECT rc.id, rc.session_key, rc.date, rc.lap_number,
    CASE
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) DEPLOYED' THEN 'VSC+'
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) ENDING' THEN 'VSC-'
      WHEN rc.message ~ '^SAFETY CAR DEPLOYED' THEN 'SC+'
      WHEN rc.message ~ '^SAFETY CAR IN THIS LAP' THEN 'SC-'
      WHEN rc.flag = 'RED' OR rc.message ~ '^RED FLAG' THEN 'RED'
      WHEN rc.message ~ '^RACE WILL RESUME' THEN 'RESUME'
      WHEN rc.flag = 'CHEQUERED' THEN 'END'
    END AS class
  FROM race_control rc JOIN races USING (session_key))
SELECT class, count(*) AS n FROM classed WHERE class IS NOT NULL AND lap_number IS NULL GROUP BY 1 ORDER BY 1;

\echo '6. Period-like rows that no form accepts (digits as #): a reworded message would show here'
WITH races AS (SELECT s.session_key, m.year FROM session s JOIN meeting m USING (meeting_key)
               WHERE s.type = 'Race' AND NOT s.is_cancelled AND m.year BETWEEN :'from'::int AND :'to'::int),
classed AS (
  SELECT rc.session_key, rc.message,
    CASE
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) DEPLOYED' THEN 'VSC+'
      WHEN rc.message ~ '^(VIRTUAL SAFETY CAR|VSC) ENDING' THEN 'VSC-'
      WHEN rc.message ~ '^SAFETY CAR DEPLOYED' THEN 'SC+'
      WHEN rc.message ~ '^SAFETY CAR IN THIS LAP' THEN 'SC-'
      WHEN rc.flag = 'RED' OR rc.message ~ '^RED FLAG' THEN 'RED'
      WHEN rc.message ~ '^RACE WILL RESUME' THEN 'RESUME'
      WHEN rc.flag = 'CHEQUERED' THEN 'END'
    END AS class
  FROM race_control rc JOIN races USING (session_key)
  WHERE rc.message ~ 'SAFETY CAR|VSC|RED FLAG|RESUME|SUSPENDED|(^|[^A-Z])SC([^A-Z]|$)' AND rc.message !~ 'INCIDENT INVOLVING|STEWARDS|LIGHTS (ON|OFF)|OVERTAKE THE SAFETY CAR|THROUGH THE PIT LANE|FORMATION LAP|START\/FINISH STRAIGHT|WILL ENTER PITS|START BEHIND THE SAFETY CAR|WILL STAY OUT|COVERS ON|STARTING PROCEDURE SUSPENDED')
SELECT regexp_replace(message, '[0-9]+', '#', 'g') AS form, count(*) AS n, count(DISTINCT session_key) AS races
FROM classed WHERE class IS NULL GROUP BY 1 ORDER BY n DESC, form;

ROLLBACK;
