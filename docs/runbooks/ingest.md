# Runbook: the ingest recovery tools

The `ingest` daemon fetches OpenF1 on its own (A§8). These roles are for the cases it does not cover (#103, owner, 2026-11-14). Commands run as root (`sudo`) on the VM. Never during a live session (`docs/runbooks/weekend.md`): OpenF1 answers every free request with 401 then, so the tools that fetch refuse to run in a live window.

## Running a role [owner]

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  run --rm ingest <role> [args]
```

- The `ingest` service needs no `--profile jobs`. It has the OpenF1 egress and logs in as `f1_ingest`.
- The run container inherits the node healthcheck, and `f1-tick` restarts any unhealthy `f1` container, run containers included. The long tools touch the heartbeat as they go.
- Logs are one JSON line per session and a `*_done` line: counts and fixed codes, never a value or a URL.
- Exit codes for every role: 0 ok, 1 a failure or a refusal (the code is in the log), 64 a usage error, 78 without the database secret.

## Backfill [owner]

`backfill` syncs the schedule and fetches every OpenF1 session that is not `final` (A§8). It needs the daemon stopped, because each process has its own rate limiter. It takes the ingest lock and refuses without it.

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env stop ingest
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  run --rm ingest backfill
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env start ingest
```

- `daemon_running` (exit 1, no request made): the daemon, or another backfill, holds the ingest lock. Stop the daemon (or wait for the other run) and start again. A daemon that was just stopped releases the lock when its connection closes.
- Duration: about 2 h 15 min for a full backfill at 25 requests a minute (A§8 estimate), less when most sessions are `final`. It is resumable. A live window stops it (exit 1): run it again later.
- Start `ingest` again afterwards, even when the backfill failed. While the daemon is down nothing else fetches.

## Refetch [owner]

`refetch` fetches from OpenF1 now and makes the normal state transition. It takes no lock: the session row lock serialises it against the daemon, so it may run with the daemon up. One run uses one rate limiter for all its sessions.

```bash
... run --rm ingest refetch 11388
... run --rm ingest refetch --failed
... run --rm ingest refetch --meeting 1229
```

- `<session_key>`: one session, newest data from OpenF1. A failure changes nothing (a `final` session stays `final`).
- `--failed`: every OpenF1 session in `failed` that is not cancelled, newest first. Use it after an outage, once the cause is gone. No failed session is exit 0.
- `--meeting <meeting_key>`: the meeting's not cancelled OpenF1 sessions that ended more than 35 min ago, newest first. A meeting with no such session logs `no_sessions` and exits 1.
- It stops at a live window: the first session refused with `live_session` ends the batch (exit 1). Run it again after the window.
- The last line is `refetch_done {sessions, done, failed}`. Per-session codes: the `last_error` codes (`rate_limited`, `http_<status>`, `timeout`, `network`, `schema`, `db`, `unknown`), `empty` (see `accept-empty`), `unknown_session`, `not_openf1`.

## Rederive [owner]

`rederive` runs the normaliser and the timing rules again over the stored `raw_response` rows. Use it after a fix to a timing rule (A§9) or the normaliser, instead of re-queuing every session in a migration: it makes no OpenF1 request, so it takes no rate budget and no live window stops it.

```bash
... run --rm ingest rederive 11388 11392
time sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  run --rm ingest rederive --all 2>&1 | tail -1
```

- Per session one transaction. It changes the child rows only: state, counters and the raw rows stay. `result.grid` is kept by driver number (D2).
- Skips (counted in `rederive_done`, no failure): `no_raw` (no stored raw rows: a session that was never fetched) and `incomplete` (one of the seven endpoints is missing).
- Failures (exit 1): `unknown_session`, `not_openf1` (an archive session), `schema` (a stored body no longer parses: the line names the endpoint and zod's paths and codes, and nothing is written for that session), `db`, `unknown`.
- The last line is `rederive_done {sessions, rederived, skipped, failed, ms}`. Expect 0 `failed`; the skipped sessions are the future and cancelled ones.

## Accept an emptied endpoint [owner]

The empty guard (A§8) fails a session with `empty` when an endpoint answers `[]` where its stored response had rows. When OpenF1 has removed those rows for good (the `pit` case of 2026-11-09), `accept-empty` clears the guard for that one session and endpoint. It accepts the loss of those rows, so it is your call each time.

1. List the sessions failing with `empty`. The `session` log line of the failed fetch has `endpoints`, the names of the endpoints that answered `[]`; this shows the stored rows the guard protects:

   ```bash
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
     psql -U postgres -d f1 -c "SELECT s.session_key, s.type, s.fail_count, r.endpoint, jsonb_array_length(r.body) AS stored_rows FROM raw_response r JOIN session s USING (session_key) WHERE s.last_error = 'empty' AND s.fail_count > 0 AND s.source = 'openf1' AND NOT s.is_cancelled AND jsonb_array_length(r.body) > 0 ORDER BY s.session_key, r.endpoint"
   ```

   A session may list several endpoints with rows; the log line says which one is empty now.
2. Accept one endpoint:

   ```bash
   ... run --rm ingest accept-empty 11388 pit
   ```

   It makes one OpenF1 request for that endpoint and deletes the stored row only when OpenF1 answers `[]` now and the stored row has rows (D4). Nothing else is deleted: the other raw rows and the child rows stay.
3. Refetch, or wait. The daemon's next tick fetches the session; for a `failed` or `final` session run `refetch <key>` (above).

Refusals (exit 1, nothing deleted): `unknown_session`, `not_openf1`, `live_session`, `no_rows` (the stored row is already empty: no request is made), `not_empty` (OpenF1 still has rows: it is a transient gap, not a removal; wait), or the code of the failed fetch (`rate_limited`, `timeout`, `http_<status>`, `schema`, …). The endpoint is one of `drivers`, `laps`, `stints`, `pit`, `race_control`, `session_result`, `weather`; a race's `starting_grid` has its own keep path (A§8).

The hand form, superseded by `accept-empty` and kept for reference (the owner's 2026-11-09 fix, `DELETE 72`; it skips the OpenF1 check and takes every non-race session at once):

```
DELETE FROM raw_response r USING session s
WHERE r.session_key = s.session_key AND r.endpoint = 'pit' AND jsonb_array_length(r.body) > 0
  AND s.last_error = 'empty' AND s.fail_count > 0
  AND s.type IS DISTINCT FROM 'Race' AND NOT s.is_cancelled
```

## Reset a failed rain grid [owner]

A rain grid is `failed` after its 9th failure in a row and has no automatic retry (A§8). `/status` lists it (A§10), and `scripts/rain-facts.sql` shows the states. Once the cause is gone (Open-Meteo reachable again, a fix deployed):

```bash
... run --rm ingest rain-refetch 11388
```

- It sets that session's grid to `live`, `fail_count` 0 and due now. The daemon's next rain step fetches it, within a minute or so, from the Historical host when the session ended more than 24 h ago. The run itself makes no network call.
- `no_grid` (exit 1): the session has no rain grid. `not_failed` (exit 1): the grid is not `failed`, and nothing changed.
- One key per run.
