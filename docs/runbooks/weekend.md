# Runbook: a race weekend

What to check before, during and after a session so that `live` records it (A§11.2). It sequences the other runbooks and links them; it does not repeat them. Commands run as root (`sudo`) on the VM. Times are UTC. The first [weekend] is Las Vegas, 20–22 Nov 2026; the fallbacks are Lusail 27–29 Nov and Yas Marina 4–6 Dec 2026.

Never run `f1-install`, merge or approve a release during a session. `f1-update` defers a deploy by itself while `live` records. Since #106 `f1-install` refuses too (`live is recording (session N): run again after it ends, or with --during-recording`) when it would change `compose.yaml`, but `--during-recording` overrides that, and a recreated `live` ends the recording with `complete = false`. So the rule stands: never run it during a session.

## Before the weekend [owner]

Do this by Thursday evening, outside a session.

1. **P2e is live.** P2e (#41: `/live`, `/replay/<id>`, the delay) is merged and deployed: `/live` loads on the phone.
2. **No deploy pending.** `sudo journalctl -u f1-update --since '-1h' --no-pager` ends in `up to date` or `deployed …` (`docs/runbooks/update.md`, "What an `f1-update` run logs"), and no release waits for your approval in GitHub (`production` environment). Approve none during a session (`docs/runbooks/update.md`, "Rolling out P2c").
3. **The schedule.** List the weekend's sessions with their UTC times and check them against the F1 calendar:

   ```bash
   sudo f1-psql -c "SELECT s.session_key, m.name AS meeting, s.name, s.date_start, s.date_end, s.is_cancelled FROM session s JOIN meeting m USING (meeting_key) WHERE s.date_start >= now() AND s.date_start < now() + interval '5 days' ORDER BY s.date_start"
   ```

   `live` reads the next session from the database on every tick (30 s), so a changed time is used once `ingest` has synced it. `ingest` syncs the schedule daily at 00:30 UTC and at every start (A§8; a failed sync is retried every 15 minutes, and the sync is skipped during a live window). To pick up a change now: `sudo docker restart f1-ingest-1`, then run the query again. If a session is missing, `meeting` has no row for it yet: wait for the next sync, do not edit the tables.
4. **The token.** Open `/status`, section Recorder: `token expires` is the F1 TV token's expiry (it lasts about 4 days). The recorder signs in by itself when a session starts within 48 h (or is running) and the token does not cover that session's end + 1 h (A§12.3), so a token that ends before Sunday's race is no fault on Thursday. The warning line "The F1 TV token expires within 24 h and a session is due." (`token_expiring`) shows when a session is due within 48 h and under 24 h are left on the token. It can show harmlessly: the token still covers the next session's end + 1 h, or the recorder signs in by itself within 48 h. Act only on the warning "The F1 TV login failed. …" (`login_failed`, it shows after any failed login) or a `last error` of `no_credentials`, `login_*` or `token_*` that does not clear: follow "Manual token fallback" below.
5. **The recorder.** `/status` shows `state` `idle`, a recent `last report` (no "The recorder has not reported for over 5 minutes." notice; the warnings and that notice also show at the top of `/live`) and `last error` `None`. A `last error` of `disk_low` is the disk check below.
6. **The disk.** Every recording is kept forever (ADR-0007), and `live` warns under 5 GiB free and stops under 1 GiB (A§11.2).

   ```bash
   sudo cat /srv/f1/state/disk
   df -h /srv/f1
   ```

   `disk` holds `<UTC time> <free bytes of /srv/f1> <free bytes of Docker's data root>` from the last `f1-tick`. `f1-tick` alerts `disk_low` on `f1-ingest/fail` under 20 GiB free on either (`docs/runbooks/update.md`, "Alerts from the host"), well before `live`'s 5 GiB warning. Free space before the weekend if either is near 20 GiB.
7. **The alarm.** The `f1-live` check on healthchecks.io exists (A6 is open: its ping got a 404 on 2026-11-06, so create it now). Without it a recording that ends incomplete rings nobody (`docs/runbooks/update.md`, "Check a recording [box]"). `f1-ingest` must be green too: it turns red at once for a host alert, and a red one before the weekend wants its body read first (the check's ping log on healthchecks.io; `docs/runbooks/update.md`, "Alerts from the host"). From 55 minutes before a session's start (`recorder_missing <key>`), or when no recorder status is fresh within 2 hours of a start (`recorder_stale <key>`), or after a failed login within 24 hours of one (`login_failed <key>`), `f1-tick` alerts there with the session key. Act on it as in that table: look at `/status` and `sudo docker logs --since 30m f1-live-1`, and put a token in by hand for a `login_*` or `token_*` error ("Manual token fallback" below). A red `f1-ingest` clears with the next 00:30 UTC ping, not when you fix the cause.
8. **A replay opens on the phone.** On `/replay`, tap the newest recording (the link is `/replay/<recording id>`, `id` being the `recording` row's id, also in the query of "Check a recording [box]"). Once a recording has ended, its session's name on the season page opens the same replay. The phone goes through the tunnel.

## The phone [owner]

- **The installed app.** The site has a manifest (`display: standalone`, A§13), so a home-screen icon opens it as an app of its own, without the browser's bars. iPhone: Safari, Share, Add to Home Screen, with the "Open as Web App" switch on (the default on iOS 26; with it off the icon opens Safari). Android: Chrome's menu (three dots), Add to Home screen or Install app.
- **Its own sign-in and delay on the iPhone.** A home-screen app on iOS has its own cookies and storage, apart from Safari's. So it needs its own Access sign-in, and it keeps its own delay (`Delay <n> s`, stored on the device, A§11.3): set the delay in the app you watch with. On Android the installed app shares Chrome's cookies and storage, so it has Chrome's sign-in and delay. The Access sign-in inside the iPhone app is still an open check (#203, #121 D3). Do it before the weekend. If the sign-in bounces to Safari or loops, follow the session in Safari.
- **The screen stays on by itself** while the player plays and the page is in front (the wake lock, A§13), in the app and in the browser, so Auto-Lock can stay as it is. Low Power mode (iPhone) or Battery Saver (Android) can refuse the lock. The screen then locks as usual, and the player reopens its stream after unlock. If the screen locks during a session, turn that mode off.
- **Offline.** `/live` and a replay need the network. Offline, the player says "You are offline: this page needs the network." The final sessions you opened online stay readable offline, with the tabs you opened (A§13). When the season cannot load, `/` lists them under "Saved on this device". Each release drops these copies, so open a session again after one.
- **An Access session that expires mid-race:** the player says "The stream keeps failing: your Access session has expired. Reload the page to sign in." (before its check answers: "The stream keeps failing. Reload the page (your Access session may have expired)."). The screen then locks as usual. In the browser, reload. The installed app has no reload button: swipe it away in the app switcher and open it again. It starts at `/` (the manifest's `start_url`), so tap Live. Sign in to Access again. `/live` resumes at the live edge with the same delay (the delay is stored on the device).

## During a session

- `/status` shows `recording` (`connecting` shows until the first subscribe and during a reconnect) and the session name. The recorder connects 60 minutes before the session's `date_start`; it stops at `Ends` + 30 minutes, or at `date_end` + 3 h at the latest (A§11.2). When the next session's lead comes first (2.5 h gaps: FP1 → FP2, FP3 → Q), it stops there and logs `handover`, then the next session starts.
- The logs hold fixed codes only; reconnects (`feed_socket`) are normal; F1 closed the race connections about hourly (A§11.2). One or two `feed_timeout` lines in the few minutes after `Ends` are normal too: the feed goes silent there, and the recorder reconnects (A§11.1):

  ```bash
  sudo docker logs --since 10m f1-live-1
  ```

  A code that repeats for minutes (`feed_unauthorized`, `login_*`, `token_*`, `disk`) is not normal: see "Manual token fallback".
- The live view (`/live`) on the phone, with the delay (the slider `Delay <n> s` in the playback controls, 0–120 s, A§13) set next to the F1 TV picture. A replay has no delay slider.
- `deploy deferred` in `sudo journalctl -u f1-update --since '-1h' --no-pager` is expected while a recording runs: `live is recording (session N): deploy deferred to a later run`. The next run after the recording deploys it. A hold ends after 14 h at the latest (`error: deploys held for over 14 h …`, then the deploy runs). To deploy a fix during a recording at once, end it: `sudo docker stop f1-live-1` (the recording is closed with `complete = f`), then `sudo systemctl start f1-update`.
- A red `f1-ingest` with a `recorder_missing`, `recorder_stale` or `login_failed` body in its ping log (about 55 minutes before a start, or when a recording is late) is the alarm for a recorder that is not recording: check "The alarm" above and "Manual token fallback". `f1-tick` runs every 10 minutes, so the alert comes up to 10 minutes late.
- Never run `f1-install` during a recording (it refuses unless you pass `--during-recording`, which you must not), and do not restart `live`.

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

It samples into `/srv/f1/state/measure-<UTC start>.tsv` (root `0600`; the TSV has counts and sizes only), with a pause of 10 s between samples (a sample takes 2-3 s, so about every 12-13 s). Read the summary afterwards:

```bash
sudo journalctl -u f1-measure --no-pager
sudo f1-measure --summary /srv/f1/state/measure-<UTC start>.tsv
```

The summary is a Markdown table per service (samples, CPU mean and max %, memory max against its limit, OOM kills, exits, restarts; 100 % CPU is one core, the unit of `cpus`) and a table of disk growth (`live-recordings`, `db-volume`, `<service>-container`). OOM kills, exits (every `die`, a policy restart included) and restarts (`docker restart`, as `f1-tick` does) are counted from `docker events` while it runs. `sudo systemctl stop f1-measure` (or Ctrl-C on a foreground run) ends it early and still writes the end rows and the summary. It reads only the f1 containers and changes nothing. `f1-measure` with no f1 container running logs `no f1 container runs: nothing to measure` and exits 1.

## After a session

1. **Check the recording** about 30 minutes after the session ends: `docs/runbooks/update.md`, "Check a recording [box]". It must show `complete = t`, intact segments and a `recording.json` that matches the row.
2. **Replay on the phone.** Tap the recording on `/replay` (`/replay/<recording id>`), or the session's name on the season page.
3. **healthchecks.io.** `f1-live` is green. Red means the recording ended incomplete (`complete = f`); the `recording` row and `docker logs f1-live-1` say why. `f1-ingest` is green too, or its ping log names the host alert (`docs/runbooks/update.md`, "Alerts from the host"); the next 00:30 UTC ping clears it.
4. **The deploy.** `journalctl -u f1-update` shows the deferred deploy going through after the recording ended (`deployed …`).
5. **The measurement** (if run): keep the summary for PR 2.

## Manual token fallback [owner]

If `/status` shows the "The F1 TV login failed. …" warning (`login_failed`) or a `last error` of `no_credentials`, `login_*` or `token_*` (a `token_expiring` alone needs nothing, see "Before the weekend"), and it does not clear within a few minutes, put a token in by hand: `docs/runbooks/update.md`, "F1 TV token by hand". The recorder reads the file every 30 s and, if it records without a token, reconnects with it. `live` records anonymously meanwhile (17 of 19 topics), and a recording without a token over the session is `complete = f` (A§11.2).

## Evidence rules

The repository is public, and the F1 TV feed is never committed (A§12.1, invariant 3).

- Counts, sizes and fixed codes only: a SQL row of `recording`, `gzip -t` results, line counts, the `f1-measure` summary.
- No screenshot, excerpt or payload of timing data in the repository, a PR or an issue. The owner's word that the live view ran for a full session is the evidence for that.
- Never paste a token, a cookie or a password anywhere.

## A new season

`ingest` syncs the new year from 1 January (00:30 UTC sync or a restart, A§8), so the schedule is there before testing. Before 2027 pre-season testing, run this checklist again from "Before the weekend". Testing days are long: a recording that has seen `Started` waits for `Ends`, and stops at `date_end` + 3 h at the latest (A§11.2), so check that a day's recording was not cut at that hard stop.
