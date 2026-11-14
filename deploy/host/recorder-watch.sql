-- The recorder watch (#104, A§14.5). f1-tick runs it every 10 minutes as postgres in f1-db-1, in a READ ONLY
-- transaction, and alerts each row's code through f1-ingest/fail once per session. One row per code at most, the
-- earliest session's; root validates both fields. One SELECT, relative to now(), no parameters.
--   recorder_missing  from date_start - 55 min until date_end, no recording of the session started since
--                     date_start - 65 min (the recorder starts at - 60), and no recording of any session open or ended
--                     in the last 3 min: a truly overlapping session starts late by design (A§11.2), and after a
--                     handover the next row appears only on the recorder's next 30 s tick.
--   recorder_stale    date_start within 2 h, or past, and recorder_status missing, older than 5 min or more than 1 min
--                     ahead (the bounds of f1-update's hold).
--   login_failed      date_start within 24 h, or past, and recorder_status.warning login_failed: it stays set while
--                     a failed login stands.
-- A session counts until date_end + 30 min (the recorder's AFTER_MS), unless it is cancelled.
WITH due AS (
  SELECT session_key, date_start, date_end FROM session
  WHERE NOT is_cancelled AND date_end + interval '30 minutes' > now()
),
fresh AS (
  SELECT 1 FROM recorder_status
  WHERE updated_at > now() - interval '5 minutes' AND updated_at <= now() + interval '1 minute'
),
alert AS (
  SELECT 'recorder_missing' AS code, session_key, date_start FROM due
  WHERE now() >= date_start - interval '55 minutes' AND now() < date_end
    AND NOT EXISTS (SELECT 1 FROM recording r
      WHERE r.session_key = due.session_key AND r.started_at >= due.date_start - interval '65 minutes')
    AND NOT EXISTS (SELECT 1 FROM recording r WHERE r.ended_at IS NULL OR r.ended_at > now() - interval '3 minutes')
  UNION ALL
  SELECT 'recorder_stale', session_key, date_start FROM due
  WHERE date_start <= now() + interval '2 hours' AND NOT EXISTS (SELECT 1 FROM fresh)
  UNION ALL
  SELECT 'login_failed', session_key, date_start FROM due
  WHERE date_start <= now() + interval '24 hours'
    AND EXISTS (SELECT 1 FROM recorder_status WHERE warning = 'login_failed')
)
SELECT DISTINCT ON (code) code, session_key FROM alert ORDER BY code, date_start, session_key;
