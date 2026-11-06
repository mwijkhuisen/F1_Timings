# Runbook: a race weekend

What to check before, during and after a session so that `live` records it (A§11.2). It sequences the other runbooks and links them; it does not repeat them. Commands run as root (`sudo`) on the VM. Times are UTC. The first [weekend] is Las Vegas, 20–22 Nov 2026; the fallbacks are Lusail 27–29 Nov and Yas Marina 4–6 Dec 2026.

Never run `f1-install`, merge or approve a release during a session. `f1-update` defers a deploy by itself while `live` records, but `f1-install` has no such hold and recreates `live`: that ends the recording with `complete = false`.

## Before the weekend [owner]

Do this by Thursday evening, outside a session.

1. **No deploy pending.** `sudo journalctl -u f1-update --since '-1h' --no-pager` ends in `up to date` or `deployed …` (`docs/runbooks/update.md`, "What an `f1-update` run logs"), and no release waits for your approval in GitHub (`production` environment). Approve none during a session (`docs/runbooks/update.md`, "Rolling out P2c").
2. **The schedule.** List the weekend's sessions with their UTC times and check them against the F1 calendar:

   ```bash
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec db \
     psql -U postgres -d f1 -c "SELECT s.session_key, m.name AS meeting, s.name, s.date_start, s.date_end, s.is_cancelled FROM session s JOIN meeting m USING (meeting_key) WHERE s.date_start >= now() AND s.date_start < now() + interval '5 days' ORDER BY s.date_start"
   ```

   `live` reads the next session from the database on every tick (30 s), so a changed time is used once `ingest` has synced it. `ingest` syncs the schedule daily at 00:30 UTC and at every start (A§8; a failed sync is retried every 15 minutes, and the sync is skipped during a live window). To pick up a change now: `sudo docker restart f1-ingest-1`, then run the query again. If a session is missing, `meeting` has no row for it yet: wait for the next sync, do not edit the tables.
3. **The token.** Open `/status`, section Recorder: `token expires` is the F1 TV token's expiry (it lasts about 4 days). The recorder signs in by itself when a session starts within 48 h (or is running) and the token does not cover that session's end + 1 h (A§12.3), so a token that ends before Sunday's race is no fault on Thursday. A warning `token_expiring` shows when under 24 h are left and a session is due; `login_failed` shows after any failed login. Neither may show on Thursday evening. If one does, follow "Manual token fallback" below.
4. **The recorder.** `/status` shows `state` `idle`, a recent `last report` (no "has not reported for over 5 minutes" notice) and `last error` `None`. A `last error` of `disk_low` is the disk check below.
5. **The disk.** Every recording is kept forever (ADR-0007), and `live` warns under 5 GiB free and stops under 1 GiB (A§11.2).

   ```bash
   sudo cat /srv/f1/state/disk
   df -h /srv/f1
   ```

   `disk` holds `<UTC time> <use %>` from the last `f1-tick`. Free space before the weekend if it is near 5 GiB.
6. **The alarm.** The `f1-live` check on healthchecks.io exists (A6 is open: its ping got a 404 on 2026-11-06, so create it now). Without it a recording that ends incomplete rings nobody (`docs/runbooks/update.md`, "Check a recording [box]").
7. **A replay opens on the phone.** Open `/replay/<recording id>` on the phone, through the tunnel, for the newest recording (`id` is the `recording` row's id, from the query in "Check a recording [box]").

## During a session

- `/status` shows `recording` (`connecting` shows until the first subscribe and during a reconnect) and the session name. The recorder connects 60 minutes before the session's `date_start`; it stops at `Ends` + 30 minutes, or at `date_end` + 3 h at the latest (A§11.2).
- The logs hold fixed codes only; reconnects (`feed_socket`) are normal; F1 closed the race connections about hourly (A§11.2):

  ```bash
  sudo docker logs --since 10m f1-live-1
  ```

  A code that repeats for minutes (`feed_unauthorized`, `login_*`, `token_*`, `disk`) is not normal: see "Manual token fallback".
- The live view (`/live`) on the phone, with the delay set next to the F1 TV picture (0–120 s, A§13).
- `deploy deferred` in `sudo journalctl -u f1-update --since '-1h' --no-pager` is expected while a recording runs: `live is recording (session N): deploy deferred to a later run`. The next run after the recording deploys it.
- Never run `f1-install` during a recording, and do not restart `live`.

### The measurement [box]

`f1-measure` samples CPU, memory and disk per f1 service over a session (A§14.5). PR 2 uses the race, or at least one full session, to tune the A§14.2 limits. Start it about 70 minutes before the session's `date_start`, because the recorder connects 60 minutes before it and the window runs on to `Ends` + 30 minutes and ingest's fetch at `date_end` + 35 minutes (A§8). `5h` covers a race with its margins:

```bash
sudo systemd-run --unit f1-measure --collect /usr/local/bin/f1-measure 5h
```

For a night session, set it up in the evening and let a transient timer start it (`<YYYY-MM-DD HH:MM:SS>` is the start, UTC):

```bash
sudo systemd-run --unit f1-measure --collect --on-calendar '<YYYY-MM-DD HH:MM:SS> UTC' /usr/local/bin/f1-measure 5h
systemctl list-timers 'f1-measure*'
```

It samples every 10 s into `/srv/f1/state/measure-<UTC start>.tsv` (root `0600`; the TSV has counts and sizes only). Read the summary afterwards:

```bash
sudo journalctl -u f1-measure --no-pager
sudo f1-measure --summary /srv/f1/state/measure-<UTC start>.tsv
```

The summary is a Markdown table per service (samples, CPU mean and max %, memory max against its limit, OOM kills, restarts; 100 % CPU is one core, the unit of `cpus`) and a table of disk growth (`live-recordings`, `db-volume`, `<service>-container`). `sudo systemctl stop f1-measure` (or Ctrl-C on a foreground run) ends it early and still writes the end rows and the summary. It reads only the f1 containers and changes nothing. `f1-measure` with no f1 container running logs `no f1 container runs: nothing to measure` and exits 1.

## After a session

1. **Check the recording** about 30 minutes after the session ends: `docs/runbooks/update.md`, "Check a recording [box]". It must show `complete = t`, intact segments and a snapshot every 30 s.
2. **Replay on the phone.** Open `/replay/<recording id>`.
3. **healthchecks.io.** `f1-live` is green. Red means the recording ended incomplete (`complete = f`); the `recording` row and `docker logs f1-live-1` say why.
4. **The deploy.** `journalctl -u f1-update` shows the deferred deploy going through after the recording ended (`deployed …`).
5. **The measurement** (if run): keep the summary for PR 2.

## Manual token fallback [owner]

If `/status` shows `login_failed` or a `last error` of `login_*`, or `token_expiring` close to a session, and it does not clear within a few minutes, put a token in by hand: `docs/runbooks/update.md`, "F1 TV token by hand". The recorder reads the file every 30 s and, if it records without a token, reconnects with it. `live` records anonymously meanwhile (17 of 19 topics), and a recording without a token over the session is `complete = f` (A§11.2).

## Evidence rules

The repository is public, and the F1 TV feed is never committed (A§12.1, invariant 3).

- Counts, sizes and fixed codes only: a SQL row of `recording`, `gzip -t` results, line counts, the `f1-measure` summary.
- No screenshot, excerpt or payload of timing data in the repository, a PR or an issue. The owner's word that the live view ran for a full session is the evidence for that.
- Never paste a token, a cookie or a password anywhere.

## A new season

`ingest` syncs the new year from 1 January (00:30 UTC sync or a restart, A§8), so the schedule is there before testing. Before 2027 pre-season testing, run this checklist again from "Before the weekend". Testing days are long: a recording that has seen `Started` waits for `Ends`, and stops at `date_end` + 3 h at the latest (A§11.2), so check that a day's recording was not cut at that hard stop.
