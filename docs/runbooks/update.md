# Runbook: updates, rollbacks and operations

How a change reaches the VM (A§14.4). Commands run as root (`sudo`) on the VM. GitHub holds no credential for the server.

1. A merge to `main` runs the CI `release` job: it builds `ghcr.io/mwijkhuisen/f1-server` and `f1-web` and pushes `:main` and `:sha-<git>`. Its `concurrency` group queues runs without cancelling, so `:main` always ends on the newest commit.
2. `f1-update.timer` (every 10 minutes, `:00 :10 …`) runs `f1-update`, which deploys the new `:main` digests.
3. `f1-tick.timer` (`:05 :15 …`, five minutes after each update) runs `f1-tick`.

Both timers are enabled by the owner after install (`docs/runbooks/install.md`, step 6), never by `f1-install`.

## Where things are

| | |
|---|---|
| `/srv/f1/state/current.env` | the image pair that last passed its smoke test |
| `/srv/f1/state/failed.env` | the pair that last failed; never retried until you remove the file |
| `/srv/f1/state/candidate.env` | the pair being deployed (only while a run is going) |
| `/srv/f1/state/held-since` | while a hold lasts: the epoch of its first deferral (its mtime is the last one); removed when a deploy starts |
| `/srv/f1/state/disk` | `<UTC time> <free bytes of /srv/f1> <free bytes of Docker's data root>`, written by `f1-tick` |
| `/srv/f1/state/restarts` | `<name> <rounds>` lines: the containers `f1-tick` restarted in its last round and in how many rounds in a row |
| `/srv/f1/state/alert-<code>` | the token of the last host alert of that code (pair, held-since epoch, looping names, session key or `low`); remove it to alert again (below) |
| `/srv/f1/state/live/` | the only part of the state directory the `live` container sees (as `/srv/f1/state`); `f1tv-token` lives here. `62532:62532 0700`; `/srv/f1/state` itself stays root `0700` |
| `/srv/f1/live/<session_key>-<startedAt>/` | one recording: `feed.jsonl` (current segment), `feed-<ms>.jsonl.gz` (finished ones), `snapshots/<ms>.json.gz`. `62532:62532`, files `0600` |
| `/srv/f1/state/measure-<UTC>.tsv` | the samples of one `f1-measure` run, root `0600` (`docs/runbooks/weekend.md`) |
| `/etc/f1/compose.yaml`, `/usr/local/bin/f1-*` | root-owned copies installed by `f1-install` |

```bash
systemctl list-timers 'f1-*'
sudo journalctl -u f1-update --since '-1h' --no-pager
sudo journalctl -u f1-tick --since '-1h' --no-pager
sudo cat /srv/f1/state/current.env
```

## What an `f1-update` run logs

| Log line | Meaning | Exit |
|---|---|---|
| `up to date (server … web …)` | the pulled digests equal `current.env` | 0 |
| `deploying …`, `smoke test passed: http://127.0.0.1:8180/healthz 200, no f1 container unhealthy, starting or restarting`, `deployed …` | success; `candidate.env` became `current.env`, `failed.env` was removed | 0 |
| `not configured: run f1-install, then fill …` | `f1.env` or a secret is empty or malformed; nothing deployed | 0 |
| `pulling … failed: trying again next run` | GHCR unreachable, or the packages are private | 0 |
| `another f1-update or f1-install is running` | the lock is held | 0 |
| `server revision <a> and web revision <b> differ; waiting for the release to finish` | the two `:main` images come from different commits (the release is half pushed); drills skip this check | 0 |
| `skipping known-bad … ; rm /srv/f1/state/failed.env to retry` | this pair already failed. Alerts `known_bad`, once per pair (not in a drill) | 0 |
| `live is recording (session N): deploy deferred to a later run` | `recorder_status` is not `idle`, under 5 minutes old and not over 1 minute in the future, so a deploy would end the recording (`N` is `-` when it names no session); the next run retries. A drill is held too. It fails open: an unreachable db or a stale row does not hold. To deploy during a recording anyway: `sudo docker stop f1-live-1` (closes it, `complete = f`), then `sudo systemctl start f1-update` | 0 |
| `error: deploys held for over 14 h (session N, since <UTC time>): deploying anyway; check recorder_status` | the hold lasted 14 h without a gap (a stuck row, or a recorder that is broken but still ticks); the deploy goes ahead. Alerts `hold_14h <session>`, once per hold (not in a drill). Look at `recorder_status` and `docker logs f1-live-1` | continues |
| `warning: cannot read recorder_status: deploying without the hold` | the query failed (no db container, db down or wedged, a renamed column); the run deploys without the hold | continues |
| `error: table inet f1 is not loaded: no deploy without the f1 firewall (systemctl restart f1-firewall)` | the firewall table is missing; nothing deployed | 1 |
| `error: cannot resolve the images (--server …, --web …)` | a drill ref could not be pulled (a ref with a registry host is always pulled and recorded by digest) | 1 |
| `smoke test failed: …` (two forms, below), `deploy of … failed: rolling back to …`, `rolled back to …` | the new pair failed migrate, `up` or the smoke test; the old pair runs again | 1 |
| `first deploy failed: … (fix the cause, then rm …)` | no previous deploy to go back to; containers left as they are | 1 |
| `error: the rollback to … failed its smoke test too: the site is down` | the old pair does not answer either | 1 |

Every run that exits 1 also fails `f1-update.service`, which alerts `unit_failed f1-update.service` through `f1-ingest/fail` ("Alerts from the host", below). That holds when the timer or `systemctl start f1-update` runs it, not for `sudo f1-update …` typed in a shell (a drill).

The smoke test is `curl http://127.0.0.1:8180/healthz` through caddy, api and db, then every f1 container must be healthy (none unhealthy, starting or restarting), for up to `F1_SMOKE_TIMEOUT` seconds (default 120). Two failure lines:

- `smoke test failed: no 200 from http://127.0.0.1:8180/healthz within <N> s`
- `smoke test failed: http://127.0.0.1:8180/healthz 200, but within <N> s not every f1 container is healthy: <name>: <status>, …`

So an unhealthy `ingest`, `live` or `cloudflared` fails a deploy and rolls it back too.

A `--server`/`--web` ref with a registry host (`ghcr.io/…`) is always pulled and recorded by digest in `current.env`; only a ref without a host (`f1-server:ci`, `f1-server:broken`) is recorded as given.

## A deploy failed

`f1-update` already rolled back. A known-bad pair is skipped with a loud log line on every later run, so it does not loop. Find out why:

```bash
sudo journalctl -u f1-update -n 60 --no-pager
sudo docker compose -p f1 ps -a
sudo docker logs --tail 80 f1-api-1
```

- Fix the release in a new PR. The next `:main` is a different digest, so it deploys by itself.
- A transient failure (GHCR hiccup, slow start) of the same pair: `sudo rm /srv/f1/state/failed.env`, then `sudo systemctl start f1-update.service` (or wait for the timer).
- Migrations are never undone (below).

## Manual rollback

Redeploy an older image pair by hand. Find the digest of a previous release in the `release` job summary of its CI run, or use a tag:

```bash
sudo f1-update --server ghcr.io/mwijkhuisen/f1-server:sha-<git> --web ghcr.io/mwijkhuisen/f1-web:sha-<git>
```

Expected: `deploying …`, `smoke test passed`, `deployed …`, exit 0. Naming one of the flags keeps the other image as `current.env` has it. The pair is recorded by digest in `current.env`. The timer then deploys `:main` again at its next run, so a rollback that must hold needs the bad commit reverted on `main`. To stop deploys meanwhile: `sudo systemctl stop f1-update.timer` (start it again afterwards).

## The broken-image drill

`docs/runbooks/install.md`, step 8: builds `f1-server:broken` from the real image, deploys it with `--server`, expects `rolled back` and exit 1, and ends with `sudo rm /srv/f1/state/failed.env`. Run it after changes to `f1-update`, `compose.yaml` or the smoke test. `--server` and `--web` take a local image as given and never pull `:main` during a drill.

## Host-file changes: compose, nftables, units, scripts

Changes to `deploy/compose.yaml`, `deploy/host/*`, `deploy/systemd/*`, `deploy/bin/*` or `deploy/postgres/roles.sql` do not travel with the images. After the PR is merged:

```bash
cd ~/F1_Timings
git pull --ff-only
sudo deploy/bin/f1-install
```

Expected: the changed files as `changed  <path>`, `ok` for the rest, and `f1-install: N change(s)`; run it again for `0 change(s)`. What it does with each change:

- A changed `nftables-f1.conf`: `nft -c` first, then `f1-firewall.service restarted (table inet f1 reloaded)`.
- A changed `compose.yaml` under a running deploy: `changed  the f1 stack recreated with the new compose.yaml`. It uses the images of `current.env` and smoke-tests them; on failure it exits 1 with `the stack did not come back`.
- A changed unit: `daemon-reload`. A timer is not enabled or restarted by `f1-install`; `sudo systemctl restart f1-update.timer f1-tick.timer` picks up a changed schedule.
- A changed `roles.sql` runs only on a new, empty `f1_pgdata` volume. For an existing database a role change is a migration.

`f1-install` refuses while `f1-update` holds the lock (`f1-update is running: try again in a minute`).

## Migrations: expand, then contract

`migrate` (dbmate in the server image, as `f1_migrator`) runs at every deploy, after `db` is healthy and before `api`, `ingest` and `live` are recreated. A failed deploy rolls the images back, never the schema. So:

- A migration must be expand-only for one release: add a table, column or view; never drop or rename what the previous release still reads. The old image then runs on the new schema, which is exactly what a rollback runs.
- The contract step (drop, rename, tighten) goes into a later release, once no release you could roll back to needs the old shape.
- `test/migrations.test.ts` enforces this (#107). It fails on an up section with `DROP`, `RENAME`, a column `TYPE` change, `SET NOT NULL`, `REVOKE`, an `ADD CONSTRAINT` that replaces nothing (a new constraint tightens an existing table) or an `ADD COLUMN ... NOT NULL` without a `DEFAULT` (the previous image's `INSERT`s fail). Comments and string literals do not count: they are lexed in one pass, left to right, so a `--` inside a string hides nothing. The contract migration says why it is safe on a line of its own above `-- migrate:down` (a marker in the down section does not count), and then passes:

  ```sql
  -- contract: <why no release you could roll back to still needs the old shape>
  ```

- The replace idiom needs no marker: `DROP CONSTRAINT x` with `ADD CONSTRAINT x` in the same statement, which is how a CHECK widens. Another table's `ADD CONSTRAINT x` does not excuse it. `DROP NOT NULL` passes too.
- The test does not see these, so the reviewer looks for them:
  - a widened CHECK whose new value the previous image cannot read (its contracts' enums, such as a new `source`): ship the reader in an earlier release;
  - a `CREATE UNIQUE INDEX` on an existing table;
  - data rewrites (`UPDATE`, `DELETE`, `TRUNCATE`);
  - `SET SCHEMA`;
  - a replaced CHECK that narrows;
  - dynamic SQL in a `DO` or function body.
- An applied migration never changes. A mistake is fixed forward in a new migration.
- A failed migration is not retried by hand; dbmate runs each file in a transaction, so it leaves nothing behind. Fix it forward in a new PR.

## Rolling out P2c (the `live` role) [owner]

P2c adds the `live` service, two secrets (`f1tv_username`, `f1tv_password`) and two host directories. The compose file and the image must arrive in this order:

1. Merge the PR.
2. Approve the release in GitHub (the `production` environment). **Not during a session**: a deploy restarts `live`, which closes the open `recording` row with `complete = false` and starts a new one on the next tick. Since P2f `f1-update` defers a deploy by itself while `live` records, but `f1-install` has no such hold and must still not run during a session.
3. Wait until `f1-update` has deployed the new image: `sudo journalctl -u f1-update --since '-30min' --no-pager` shows `deployed …`, and `sudo cat /srv/f1/state/current.env` names the new digests. The old compose file is still installed, so there is no `live` yet.
4. Run `f1-install` from a fresh checkout (`docs/runbooks/install.md`, step 3; update the checkout first). It creates `/srv/f1/live` and `/srv/f1/state/live` (`62532:62532 0700`) and the two empty secret files, installs the new `compose.yaml` and, because a deploy is running, recreates the stack with the images of `current.env`, so `live` starts now. It ends with the two files to fill. Do this outside a session too.
5. Fill `f1tv_username` and `f1tv_password` straight away (`docs/runbooks/install.md`, step 4, A4). Until then `live` runs, records nothing and shows `no_credentials` on the status panel; it reads the files again on its next tick (within 30 s).

Why this order, and what the reverse does:

- **`f1-install` before the new image is deployed:** `live` starts on the old image, which exits 2 for a role it does not have. It restarts in a loop, the smoke test fails and `f1-install` stops with `the stack did not come back`. The same holds for a manual rollback (`f1-update --server …:sha-<old>`) to an image from before P2c: the smoke test fails and `f1-update` rolls back to `current.env`. While `compose.yaml` has `live`, only an image from P2c or later deploys.
- **Secrets still empty:** `f1-update` checks every entry of `F1_SECRETS` and, while one is empty, logs `not configured: run f1-install, then fill …` and exits 0. So no deploy happens, a new release included, until both `f1tv_*` files are filled. This is deliberate: nothing is deployed that is half configured.

To rotate the F1 TV password, change it on formula1.com, then write the new one only into `/etc/f1/secrets/f1tv_password` on the VM (in place, keeping `root:62008 0440`); it goes nowhere else. `live` reads the file at its next login, so a token already on disk keeps working until it expires.

## Rolling out P2f (the deploy hold, `f1-measure`, cloudflared over http2) [owner]

P2f changes `f1-update`, adds `f1-measure`, and pins cloudflared to `--protocol http2` with a firewall that allows tcp/7844 only (A§14.3).

1. Merge the PR and approve the release in GitHub. Never during a session (`docs/runbooks/weekend.md`).
2. Wait until `f1-update` has deployed the new images (`deployed …` in `sudo journalctl -u f1-update --since '-30min' --no-pager`). This is still the old `f1-update`, compose file and firewall.
3. Outside a session, update the checkout and run `f1-install` from it (see "Host-file changes" above). It installs the new `f1-update` and `f1-measure`, loads the new firewall (`f1-firewall.service restarted (table inet f1 reloaded)`) and, because a deploy is running, recreates the stack with the new compose file.
4. Expect exit 0 and `f1-install: N change(s)` well within the 120 s smoke test, because cloudflared now connects over http2 at once (before, its QUIC attempt failed with `tls: no application protocol` and its fallback took ~130 s). `sudo docker logs f1-cloudflared-1` shows connections registered with `protocol=http2`.
5. `sudo nft list table inet f1` shows the tunnel rule with `tcp dport 7844` only, no `udp`.

Next time `live` records, `journalctl -u f1-update` shows `deploy deferred` for a deploy that arrives meanwhile. The weekend checklist is `docs/runbooks/weekend.md`.

## F1 TV token by hand (when the automatic login fails) [owner]

The status panel then shows the warning "The F1 TV login failed. …" (`login_failed`) or a `login_*` last error, and `live` keeps recording without a token: 17 of the 19 topics arrive anonymously, and `CarData.z` and `Position.z` need one. To give it a token yourself, copy the value of the `login-session` cookie from formula1.com (browser developer tools, Storage or Application, Cookies; a raw `subscriptionToken` JWT works too) and put it in the token file without it touching a command line or the shell history:

```bash
sudo install -o 62532 -g 62532 -m 0600 /dev/stdin /srv/f1/state/live/f1tv-token
```

Paste the value, press Enter, then Ctrl-D. The terminal shows what you paste: clear it afterwards (`clear`). The value must be one line.

`live` reads the file every 30 s, so a new token is used within that time, and it reconnects with it if a recording is running without one. The panel's last error says what is wrong with the file:

| Last error | Meaning |
|---|---|
| `token_file` | not a regular file, not readable by 62532, or any group or other permission bit set: check the owner (`62532:62532`) and the mode (`0600`). Also a token from a login that could not be saved: `live` uses it from memory and writes it as soon as `/srv/f1/state/live` allows that |
| `token_format` | not a JWT or a `login-session` cookie value on one line, or no expiry in it |
| `token_expired` | the token is past its expiry |
| `feed_unauthorized` | the feed refused the token; it is ignored until the file holds a different value |

The token lasts about 4 days. The panel warns 24 h before it expires, when a session is due within 48 h.

## Fetch the F1 archive of 2018–2022 (the `archive` job) [owner]

`archive` (A§4, A§6.2) downloads the archive files of the 2018–2022 sessions into `/srv/f1/archive` and loads their laps into the database. `f1-update` never runs it and no timer does: you start it, one year at a time (`archive <year> [<session_key>…]`; the keys limit it to those sessions). `f1-install` creates `/srv/f1/archive` (62532, 0700); the job's other options (`--token-file`, `--dir`) default to the container's paths and are not needed on the VM. `--dir` takes only `/srv/f1/archive` or a path with a `fixtures-private` segment (exit 64 otherwise), so archive files never land in a tracked directory.

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  --profile jobs run --rm archive archive 2019
```

- **Token:** it needs a valid F1 TV token in `/srv/f1/state/live/f1tv-token` (the job sees it read-only as `/srv/f1/state/f1tv-token`; it never logs in and has no F1 TV password). `live` refreshes that file only within 48 h of a session (A§12.3), so between weekends it is usually expired: paste one as under "F1 TV token by hand" first.
- **Live window:** it stops inside a live window and exits 1. Run it between weekends.
- **Resume:** a rerun skips the files already present in `/srv/f1/archive`, so after a stop or a failure run the same command again.
- **Missing topics:** a topic the archive answered 403 or 404 for gets an empty `<Topic>.missing` marker, and a rerun never asks for it again. To ask again (after a 403 that was not the archive's, say), clear the markers of that session: `sudo rm /srv/f1/archive/<session_key>/*.missing`. SessionInfo and TimingData never get one.
- **Heartbeat t0:** a session with neither SessionData nor ExtrapolatedClock is imported on the Heartbeat t0 and logs its `archive` line at error level (`"t0":"heartbeat"`, counted in `t0_heartbeat`): such a session's times can be minutes off.
- **Temp files:** a kill can leave `<file>.<uuid>.tmp` files in `/srv/f1/archive/<session_key>/`; they are never read and can be deleted.
- **Stops (exit 1):** `busy` (another archive run holds the lock: wait for it), `token_expired` (also mid-run, 60 s before the token's expiry: paste a new token and rerun), `disk_low` (under 5 GiB free in `/srv/f1/archive`, the recorder's warning level: free space first), `live_session`, `http_401`.
- **Expected failures (2026-11-12):** a 2021 run always ends with `failed: 1` (exit 1): 2021 Abu Dhabi Practice 1 (7165) is skipped as `key_mismatch` (A§6.2). A 2022 run ends with `index_http_403` and imports nothing while F1 refuses that year; run `archive 2022` again later. A loop over the years that stops on a failure therefore stops after 2021.
- **Rate:** one request every 2 s, about 3 h for all of 2018–2022 (run a year at a time; `tmux` or `nohup` keeps it alive after the SSH session ends).
- **Years:** it never runs for 2023 and later (exit 64); those come from OpenF1.

## Merge the archive files and recordings into the laps (the `fill` job) [owner]

`fill` (A§4, A§7) reads, for each OpenF1 session, its archive files in `/srv/f1/archive/<session_key>/` and its complete recording in `/srv/f1/live`, stores their laps as candidates and merges the session's laps again. It never reaches the network. `f1-update` never runs it and no timer does: you start it, for every session (`--all`, newest first) or for the keys you give.

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  --profile jobs run --rm fill fill --all
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
  --profile jobs run --rm fill fill 11388 11392
```

- **Exit codes:** 0 when no session failed; 1 when one did (an unknown key, a failing source, `stale_lap` or a database error: the session's `fill` line is at error level with the code, and `fill_done` counts the failures); 64 for a usage error (keys and `--all` together or neither, a key that is not digits, an unknown flag, a directory outside the rule below); 78 without the database secret.
- **Directories:** `--archive-dir` and `--live-dir` default to the container's paths and are not needed on the VM. They take only `/srv/f1/archive` and `/srv/f1/live` or a path with a `fixtures-private` segment (exit 64 otherwise).
- **Recordings:** only a complete recording counts (`recording.complete = t`), the earliest one of the session, found through the table. A recording still running or one that ended incomplete is ignored.
- **A failing source** (`too_large`, `key_mismatch`, `t0_heartbeat`, `not_file`, and for a recording `recording_missing` (its directory is not under `--live-dir`) or `incomplete` (no sealed segment or no SessionInfo), under `errors` in the line) keeps its stored candidates; the other source is still stored and the session merged. Absent files (or an archive without a t0) are no failure.
- **After an image rollback:** an image before P3b writes `lap` only, so `lap_source` goes stale for the sessions it wrote. Once rolled forward, refetch (`refetch <session_key>`) or re-archive those sessions before running `fill` on them. `fill` leaves a session unchanged and fails it as `stale_lap` when any `lap` row has no candidate of its own source (the old image wrote it), files or not; it cannot tell a candidate that is present but stale (a session the old image refetched), hence the refetch first.
- **Browser cache:** a final session's laps stay cached in the browser for up to 24 h (A§10, `max-age=86400`), so check a filled session with a hard reload.

## Import Jolpica (the `jolpica` job) [owner]

`jolpica` (A§4, A§6.3, A§7) reads the Jolpica-F1 CSV dump in `/srv/f1/jolpica` and writes the races and qualifyings of 1950–2017 as `jolpica` rows; from 2018 on it adds lap candidates to the sessions that already exist. It never reaches the network, so the download is your step. `f1-update` never runs it and no timer does. `f1-install` creates `/srv/f1/jolpica` (`root:62532 0750`: root unpacks the dump, the job only reads it).

1. **Download.** The free (delayed) copy is 14 days behind, which does not matter for finished seasons. Read the hash and the upload time from the info JSON first, into a directory of its own:

   ```bash
   d=$(mktemp -d)
   curl -sS https://api.jolpi.ca/data/dumps/download/ | python3 -I -m json.tool   # delayed_dumps.csv: uploaded_at, file_size, file_hash
   curl -sSL -o "$d/jolpica-f1-csv.zip" 'https://api.jolpi.ca/data/dumps/download/delayed/?dump_type=csv'
   stat -c %s "$d/jolpica-f1-csv.zip"
   sha256sum "$d/jolpica-f1-csv.zip"
   ```

   The size and the sha256 must equal `file_size` and `file_hash` of `delayed_dumps.csv`. Stop if they differ (a partial download or an error page). Both come from the same host as the zip, so they check integrity (truncation, an error page), not authenticity: a changed host could serve a matching pair.
2. **Unpack** into `/srv/f1/jolpica`, as root. The zip is flat: 18 `formula_one_<table>.csv` files and no directory.

   ```bash
   sudo python3 -I -m zipfile -l "$d/jolpica-f1-csv.zip"
   sudo python3 -I -c 'import sys, zipfile; i = zipfile.ZipFile(sys.argv[1]).infolist(); bad = [f for f in i if "/" in f.filename or "\\" in f.filename or ".." in f.filename]; total = sum(f.file_size for f in i); print(len(i), "files", total, "bytes", len(bad), "bad names"); sys.exit(1 if bad or total > 512 * 1024**2 else 0)' "$d/jolpica-f1-csv.zip" && echo zip ok
   sudo rm -f /srv/f1/jolpica/formula_one_*.csv
   sudo python3 -I -m zipfile -e "$d/jolpica-f1-csv.zip" /srv/f1/jolpica/
   rm -r "$d"
   sudo ls -ld /srv/f1/jolpica && sudo ls -l /srv/f1/jolpica | head -n 4
   ```

   Extract only after `zip ok`: the check refuses more than 512 MB uncompressed in total (the 2026-10-27 dump is 18 files, 45 MB) and any name with `/`, `\` or `..`, before anything is written. (`unzip` extracts the same.) Expected: the directory is `root:62532 0750` and the files are `0644` (root's umask 022), so the job's group can read them. A different mode or owner means `f1-install` did not run: run it again. The job refuses a symlink in place of a file (`not_file`), so do not link the files from elsewhere.
3. **Run** it. The years are optional (none means every year in the dump); all of them took 33 s and 439 MB on the build's real dump.

   ```bash
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
     --profile jobs run --rm jolpica jolpica
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env \
     --profile jobs run --rm jolpica jolpica 1996 2005
   ```

   It logs one `jolpica` line per session and a `jolpica_done` line, counts and codes only. Check that `jolpica_done` has `failed` 0 and no `error`, and that `bad_time`, `bad_pit_time` and `no_year` are 0: a value of another shape there (a duration, a pit stop's time of day, a season without a year) is read as null or skipped, so a nonzero count is a format change in the dump.
4. **Verify [box]** after a run over every year, with the repository's `scripts/jolpica-counts.py` and `scripts/jolpica-facts.sql` copied to the VM (both print counts and keys only). The first counts the dump's own races, qualifyings, race entries without status 40/41, qualifying entries, race laps and pit stops per year 1950–2017, by the documented rules and independently of the job; the second counts the same from the `jolpica` rows, then the 1996–2017 races without laps and the 2018+ tier's fills and added laps (A§7):

   ```bash
   sudo python3 -I jolpica-counts.py /srv/f1/jolpica > dump-counts.tsv
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
     psql -U postgres -d f1 -X -q -v ON_ERROR_STOP=1 -f - < jolpica-facts.sql > facts.out
   sed -n '/^year/,/^TOTAL/p' facts.out | diff dump-counts.tsv - && echo counts equal
   sed -n '/^2\./,$p' facts.out
   ```

   The two count tables must be equal, row by row (`counts equal`); a difference names the year and the column to look into. The rest must show 0 races without laps, `lap_ms` as the only filled column, and added laps only in sessions where OpenF1 or the archive lost laps (on the build's dev database: 395 races, 0 without laps; 90 `lap_ms` fills; 449 added laps, 446 in 10033 and 3 in 11234. On the VM on 2026-11-13: 395 races, 0 without laps; 81 `lap_ms` fills; 552 added laps in 9 races, 446 in 10033 and 94 in 5744; A§7, "VM run"). The diff of every set `lap` value before and after (A§7) ran on the build machine and once on the VM; it is not part of this check.
5. **Exit codes:** 0 when the dump was read and no session failed. 1 when it was not or one failed: `bad_dump` (in `jolpica_done`, with `code` and `file`: a missing or renamed file, a changed header, a file over the caps; `too_large` is a file over 64 MiB, and the cap in `jolpica/csv.ts` and the service's `mem_limit` are raised together), `busy` (another run holds the lock: wait for it), and per session `bad_key` (a round number outside 1–99), `not_jolpica` (the meeting or session key already exists with another source: nothing is written for it), `stale_lap` (a 2018+ session whose `lap` row lacks its own candidate, after an image rollback: refetch or re-archive that session, then run the job again) or `db`. 64 for a usage error (a year that is not four digits or outside 1950 to this year, an unknown flag, or `--dir` other than `/srv/f1/jolpica` or a path with a `fixtures-private` segment). 78 without the database secret.
6. **Rerun** after a newer dump: every session is replaced (idempotent), so a second run over the same dump changes nothing. A 2018+ round that has no session in the database yet is counted and skipped (`no_match`); run it again after the archive or OpenF1 has that session.
7. **Before an image rollback past P3c** (only after a `jolpica` run): the schema stays, as for every rollback (expand-only, above), but an image older than P3c throws in the merge on any session that holds jolpica candidates (A§7, "Rollback"). Delete them first, then roll the image back (`Manual rollback` above):

   ```bash
   sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec -T db \
     psql -U postgres -d f1 -c "DELETE FROM lap_source WHERE source = 'jolpica'"
   ```

   The 1950–2017 sessions stay readable. The old image's `fill` leaves them unchanged and counts them as `stale_lap`, and its ingest never touches them. Its next refetch of a 2018+ session drops the jolpica fills from that session's laps. After rolling forward again, run the job again (step 3).
8. **The dump stays on the VM.** It is CC BY-NC-SA 4.0 (ADR-0009): never copy it anywhere else, never commit it, and never put it in an image, a log or an issue. The site's attribution line (`third-party-licences.txt`, section 4) already names it.

## Check a recording [box]

After a session, plus 30 minutes (`<path>` is the `path` column, `<session_key>-<startedAt>`). These commands print counts and metadata only, never feed payloads:

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec db \
  psql -U postgres -d f1 -c "SELECT id, session_key, path, started_at, ended_at, bytes, complete FROM recording ORDER BY id DESC LIMIT 3"
sudo ls -l /srv/f1/live/<path> /srv/f1/live/<path>/snapshots | tail -n 5
sudo du -sh /srv/f1/live/<path>
sudo sh -c 'gzip -t /srv/f1/live/<path>/feed-*.jsonl.gz && zcat /srv/f1/live/<path>/feed-*.jsonl.gz | wc -l'
sudo docker logs f1-live-1 2>&1 | grep -c '"last_error"'
```

Pass:

- `complete = t`, and `ended_at` about 30 minutes after the `Ends` status, which comes some time after the session's end (`date_end` + 3 h at the latest), or at the next session's lead (`date_start` − 60 min) when that came first, with `handover` in the log (A§11.2).
- Every segment passes `gzip -t`, and the line count is not 0.
- A snapshot about every 30 s: the `snapshots` listing grows by two files a minute.
- `f1-live` on healthchecks.io is green (`f1-live/fail` turns it red at once for a recording that ended incomplete), and the status panel shows `idle` and the token expiry.

The last command counts the error log lines of the container, each one a fixed code (`feed_socket` after a drop, say). A few reconnects are normal; `complete = t` already says that no disconnect lasted over 60 s.

## `f1-tick` and the disk file

Every 10 minutes (`:05 :15 …`). It runs, in this order:

1. `nft list table inet f1`; if it is missing: `error: the f1 firewall (table inet f1) is missing: loading /etc/f1/nftables-f1.conf`, then the table is loaded again. If loading fails, f1-tick fails closed: it stops every f1 container, writes the marker `/srv/f1/state/firewall-stopped`, logs `error: loading /etc/f1/nftables-f1.conf failed: the f1 stack is stopped until the firewall loads` and exits 1. Once the table loads again (fix the cause, `sudo systemctl restart f1-firewall`), the next `f1-tick` or `f1-update` logs `table inet f1 is loaded again: starting the f1 stack (/srv/f1/state/current.env)` and starts the stack.
2. `f1-resolvers --quiet`: refreshes the DNS allowlist (`inet f1 resolvers4`) from `/etc/resolv.conf`.
3. Under `f1-update`'s lock: `restarting unhealthy container f1-<service>-1` for every f1 container Docker reports unhealthy (Docker only restarts a container that exited), and the file `/srv/f1/state/restarts`. A container restarted in 3 rounds in a row alerts `restart_loop <name>`.
   While `f1-update` or `f1-install` holds the lock, f1-tick logs `f1-update or f1-install is running: no container restarts this round` and skips this step. `warning: cannot write /srv/f1/state/restarts` means the file could not be written (the streak count starts again).
4. The recorder watch: `/etc/f1/recorder-watch.sql` in a read-only transaction in `f1-db-1`, as `f1_api` (20 s at most, and a 15 s `statement_timeout` in the server). It alerts `recorder_missing`, `recorder_stale` or `login_failed` with the session key. It fails open: `warning: cannot run the recorder watch: no recorder alert this round` (no db container, a db that does not answer in time, a missing file) does not fail the run.
5. `free disk: /srv/f1 N GiB, Docker data root <dir> N GiB` and the file `/srv/f1/state/disk` (written only when both are readable). Under 20 GiB on either alerts `disk_low`, even when the other cannot be read.

An alert that f1-tick sends shows in its journal as an `f1-alert:` line (`alert_sent <body>`, below). `warning: cannot write the alert state /srv/f1/state/alert-<code>` (any script) means the token was not saved, so the same alert is sent again on the next run.

```bash
sudo journalctl -u f1-tick -n 20 --no-pager
sudo cat /srv/f1/state/disk
sudo cat /srv/f1/state/restarts
sudo nft list set inet f1 resolvers4
sudo f1-resolvers
```

Expected: `disk` holds one line such as `2026-11-14T10:05:03Z 412345678901 398765432109` (free bytes, not a percentage); `restarts` is empty or missing when nothing was restarted; `f1-resolvers` logs `f1 container DNS allowed to N IPv4 resolver(s) from /etc/resolv.conf` (or the systemd-resolved file when `/etc/resolv.conf` has only a loopback stub). A line `warning: no IPv4 resolver … f1 containers have no DNS until the next f1-tick` means the set is empty.

`f1-tick` exits 1 when it could not load the firewall, could not start the stack again, or could not read the free disk space (`error: cannot read the free disk space of /srv/f1 and the Docker data root`). The unit then shows as failed in `systemctl --failed` and alerts `unit_failed f1-tick.service` through `f1-ingest/fail`.

## Alerts from the host (`f1-ingest/fail`)

`f1-alert <code> [<detail>]` (#104, A§14.5) POSTs the body `<code>` or `<code> <detail>` to `https://hc-ping.com/<ping key>/f1-ingest/fail` with the key of `/etc/f1/secrets/hc_ping_key`. That turns the `f1-ingest` check red at once. The body is a fixed code, never a key, URL or value.

**Reading one:** healthchecks.io, project F1, check `f1-ingest`: the ping log (events) lists the `/fail` ping with its body. **Clearing it:** the next daily success ping of `ingest` (00:30 UTC sync) turns the check green again; acting on the cause does not clear it earlier. Green does not mean fixed: the 00:30 UTC success ping turns `f1-ingest` green while `disk_low` or `restart_loop` still holds, and they do not alert again until they clear and come back (or `sudo rm /srv/f1/state/alert-<code>`). Every code but `unit_failed` is sent once per condition and not repeated while it lasts; `unit_failed` has no state and is sent on every failed run (pinging a check that is already red is harmless).

| Body | Sent by | Meaning | What to do |
|---|---|---|---|
| `unit_failed <unit>` | `f1-alert@.service`, the `OnFailure=` of `f1-update.service` and `f1-tick.service` | the unit exited 1 | `sudo journalctl -u <unit> -n 60 --no-pager`. For `f1-update.service`: "A deploy failed" above (a failed deploy was rolled back; no firewall table; a failed rollback means the site is down). For `f1-tick.service`: the firewall could not load (the stack is stopped: fix the cause, `sudo systemctl restart f1-firewall`), the stack could not start again, or the free disk was unreadable |
| `known_bad` | `f1-update` | the pair of the newest `:main` already failed and is skipped | "A deploy failed" above: fix it in a new PR, or `sudo rm /srv/f1/state/failed.env` for a transient failure. Once per pair; not sent by a drill |
| `hold_14h [<session>]` | `f1-update` | deploys were held for 14 h by a recorder that kept reporting, and the deploy went ahead | look at `recorder_status` and `sudo docker logs f1-live-1` (a stuck row, or a broken recorder that still ticks). Once per hold; not sent by a drill |
| `restart_loop <container>` | `f1-tick` | that container was restarted as unhealthy in 3 rounds in a row (the third round, about 20 minutes after the first restart); the name is the first of the looping ones | `sudo docker logs --tail 80 <container>` and `sudo docker inspect --format '{{json .State.Health}}' <container>`; fix the cause (a release rollback: "Manual rollback"). It alerts again when the set of looping containers changes and re-arms when none loops |
| `recorder_missing <key>` | `f1-tick`, recorder watch | from 55 minutes before the session's start until its end, no recording of session `<key>` has started since 65 minutes before the start, and no other recording is open or ended under 3 minutes ago | `/status`, section Recorder; `sudo docker logs --since 30m f1-live-1`; `sudo docker compose -p f1 ps live`. A `login_*` or `token_*` error: "F1 TV token by hand" above. Never restart `live` while it records |
| `recorder_stale <key>` | `f1-tick`, recorder watch | no `recorder_status` row is under 5 minutes old, and session `<key>` starts within 2 hours or is running: `live` is down or not reporting | `sudo docker ps -a --filter name=f1-live` and `sudo docker logs --tail 80 f1-live-1`; if it is down and nothing records, `sudo docker restart f1-live-1` |
| `login_failed <key>` | `f1-tick`, recorder watch | the recorder's F1 TV login failed and a session `<key>` starts within 24 hours or is running | "F1 TV token by hand" above, and `docs/runbooks/weekend.md`, "Manual token fallback" |
| `disk_low` | `f1-tick` | under 20 GiB free on `/srv/f1` or on Docker's data root | `df -h /srv/f1`, `sudo docker system df`, `sudo cat /srv/f1/state/disk`; free space (old images, logs, never a recording you still want: they are kept for good, ADR-0007) |
| `test_alert` | `sudo f1-alert test_alert` | a drill (`docs/runbooks/install.md`, A6) | nothing |

The three recorder codes are once per session (`<key>`) and again after the query stops returning that code, so a stale recorder that recovers and fails again in the same session alerts again. `disk_low` re-arms when both disks are readable and above 20 GiB again.

**`f1-alert` journal lines** (prefix `f1-alert:`, in the journal of the unit that ran it: `-u f1-tick`, `-u f1-update`, or `-u 'f1-alert@*'` for an `OnFailure=` alert; `sudo f1-alert …` prints them on the terminal):

| Log line | Meaning | Exit |
|---|---|---|
| `alert_sent <body>` | healthchecks.io answered 2xx | 0 |
| `alert_no_key <body>` | `hc_ping_key` is missing, empty or only whitespace: no request was made. It counts as sent, so it is not retried | 0 |
| `alert_key_invalid <body>` | the file is not 22 characters of `A-Za-z0-9_-` (a second line or a space fails this): no request. Like `alert_no_key`, it counts as sent: after fixing the key, a condition that still holds alerts again only once it clears and comes back (or `sudo rm /srv/f1/state/alert-<code>`) | 0 |
| `alert_failed <body> (curl <rc>, http <status>)` | no 2xx (`http 000` is no answer: DNS, egress, timeout 10 s); retried by the next run | 1 |
| `usage: f1-alert <code> [<detail>]` | a code or detail of the wrong shape | 64 |

**Alert again:** the alert state is `/srv/f1/state/alert-<code>` (`alert-known_bad`, `alert-hold_14h`, `alert-restart_loop`, `alert-recorder_missing`, `alert-recorder_stale`, `alert-login_failed`, `alert-disk_low`). `sudo rm /srv/f1/state/alert-<code>` makes the next run send it again while its condition holds.

**Not covered:** with Docker itself down, `f1-update.service` and `f1-tick.service` fail their `Requires=docker.service` as a dependency, not as failed, so no `unit_failed` is sent. The missed daily ping of `ingest` still turns `f1-ingest` red within 25 hours.

## Cloudflare ranges

`cf4` and `cf_tunnel4` change rarely. Refresh them as described in `docs/runbooks/cloudflare.md`.
