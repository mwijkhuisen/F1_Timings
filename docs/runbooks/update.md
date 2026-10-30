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
| `/srv/f1/state/disk` | `<UTC time> <disk use % of /srv/f1>`, written by `f1-tick` |
| `/srv/f1/state/live/` | the only part of the state directory the `live` container sees (as `/srv/f1/state`); `f1tv-token` lives here. `62532:62532 0700`; `/srv/f1/state` itself stays root `0700` |
| `/srv/f1/live/<session_key>-<startedAt>/` | one recording: `feed.jsonl` (current segment), `feed-<ms>.jsonl.gz` (finished ones), `snapshots/<ms>.json.gz`. `62532:62532`, files `0600` |
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
| `skipping known-bad … ; rm /srv/f1/state/failed.env to retry` | this pair already failed | 0 |
| `error: table inet f1 is not loaded: no deploy without the f1 firewall (systemctl restart f1-firewall)` | the firewall table is missing; nothing deployed | 1 |
| `error: cannot resolve the images (--server …, --web …)` | a drill ref could not be pulled (a ref with a registry host is always pulled and recorded by digest) | 1 |
| `smoke test failed: …` (two forms, below), `deploy of … failed: rolling back to …`, `rolled back to …` | the new pair failed migrate, `up` or the smoke test; the old pair runs again | 1 |
| `first deploy failed: … (fix the cause, then rm …)` | no previous deploy to go back to; containers left as they are | 1 |
| `error: the rollback to … failed its smoke test too: the site is down` | the old pair does not answer either | 1 |

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
- An applied migration never changes. A mistake is fixed forward in a new migration.
- A failed migration is not retried by hand; dbmate runs each file in a transaction, so it leaves nothing behind. Fix it forward in a new PR.

## Rolling out P2c (the `live` role) [owner]

P2c adds the `live` service, two secrets (`f1tv_username`, `f1tv_password`) and two host directories. The compose file and the image must arrive in this order:

1. Merge the PR.
2. Approve the release in GitHub (the `production` environment). **Not during a session**: a deploy restarts `live`, which closes the open `recording` row with `complete = false` and starts a new one on the next tick.
3. Wait until `f1-update` has deployed the new image: `sudo journalctl -u f1-update --since '-30min' --no-pager` shows `deployed …`, and `sudo cat /srv/f1/state/current.env` names the new digests. The old compose file is still installed, so there is no `live` yet.
4. Run `f1-install` from a fresh checkout (`docs/runbooks/install.md`, step 3; update the checkout first). It creates `/srv/f1/live` and `/srv/f1/state/live` (`62532:62532 0700`) and the two empty secret files, installs the new `compose.yaml` and, because a deploy is running, recreates the stack with the images of `current.env`, so `live` starts now. It ends with the two files to fill. Do this outside a session too.
5. Fill `f1tv_username` and `f1tv_password` straight away (`docs/runbooks/install.md`, step 4, A4). Until then `live` runs, records nothing and shows `no_credentials` on the status panel; it reads the files again on its next tick (within 30 s).

Why this order, and what the reverse does:

- **`f1-install` before the new image is deployed:** `live` starts on the old image, which exits 2 for a role it does not have. It restarts in a loop, the smoke test fails and `f1-install` stops with `the stack did not come back`. The same holds for a manual rollback (`f1-update --server …:sha-<old>`) to an image from before P2c: the smoke test fails and `f1-update` rolls back to `current.env`. While `compose.yaml` has `live`, only an image from P2c or later deploys.
- **Secrets still empty:** `f1-update` checks every entry of `F1_SECRETS` and, while one is empty, logs `not configured: run f1-install, then fill …` and exits 0. So no deploy happens, a new release included, until both `f1tv_*` files are filled. This is deliberate: nothing is deployed that is half configured.

The F1 TV password is changed after the Mexico City race (Sun 1 Nov 2026), per the P2a security review. Change it on formula1.com, then write the new one only into `/etc/f1/secrets/f1tv_password` on the VM (in place, keeping `root:62008 0440`); it goes nowhere else. `live` reads the file at its next login, so a token already on disk keeps working until it expires.

## F1 TV token by hand (when the automatic login fails) [owner]

The status panel then shows `login_failed` (or a `login_*` last error), and `live` keeps recording without a token: 17 of the 19 topics arrive anonymously, and `CarData.z` and `Position.z` need one. To give it a token yourself, copy the value of the `login-session` cookie from formula1.com (browser developer tools, Storage or Application, Cookies; a raw `subscriptionToken` JWT works too) and put it in the token file without it touching a command line or the shell history:

```bash
sudo install -o 62532 -g 62532 -m 0600 /dev/stdin /srv/f1/state/live/f1tv-token
```

Paste the value, press Enter, then Ctrl-D. The terminal shows what you paste: clear it afterwards (`clear`). The value must be one line.

`live` reads the file every 30 s, so a new token is used within that time, and it reconnects with it if a recording is running without one. The panel's last error says what is wrong with the file:

| Last error | Meaning |
|---|---|
| `token_file` | not a regular file, not readable by 62532, or any group or other permission bit set: check the owner (`62532:62532`) and the mode (`0600`) |
| `token_format` | not a JWT or a `login-session` cookie value on one line, or no expiry in it |
| `token_expired` | the token is past its expiry |
| `feed_unauthorized` | the feed refused the token; it is ignored until the file holds a different value |

The token lasts about 4 days. The panel warns 24 h before it expires, when a session is due within 48 h.

## Check a recording [box]

After a session, plus 30 minutes (`<path>` is the `path` column, `<session_key>-<startedAt>`). These commands print counts and metadata only, never feed payloads:

```bash
sudo docker compose -p f1 -f /etc/f1/compose.yaml --env-file /srv/f1/state/current.env exec db \
  psql -U postgres -d f1 -c "SELECT session_key, path, started_at, ended_at, bytes, complete FROM recording ORDER BY id DESC LIMIT 3"
sudo ls -l /srv/f1/live/<path> /srv/f1/live/<path>/snapshots | tail -n 5
sudo sh -c 'gzip -t /srv/f1/live/<path>/feed-*.jsonl.gz && zcat /srv/f1/live/<path>/feed-*.jsonl.gz | wc -l'
sudo docker logs f1-live-1 2>&1 | grep -c '"last_error"'
```

Pass:

- `complete = t`, and `ended_at` about 30 minutes after the session's end.
- Every segment passes `gzip -t`, and the line count is not 0.
- A snapshot about every 30 s: the `snapshots` listing grows by two files a minute.
- `f1-live` on healthchecks.io is green, and the status panel shows `idle` and the token expiry.

The last command counts the error log lines of the container, each one a fixed code (`feed_socket` after a drop, say). A few reconnects are normal; `complete = t` already says that no disconnect lasted over 60 s.

## `f1-tick` and the disk file

Every 10 minutes (`:05 :15 …`). It runs, in this order:

1. `nft list table inet f1`; if it is missing: `error: the f1 firewall (table inet f1) is missing: loading /etc/f1/nftables-f1.conf`, then the table is loaded again. If loading fails, f1-tick fails closed: it stops every f1 container, writes the marker `/srv/f1/state/firewall-stopped`, logs `error: loading /etc/f1/nftables-f1.conf failed: the f1 stack is stopped until the firewall loads` and exits 1. Once the table loads again (fix the cause, `sudo systemctl restart f1-firewall`), the next `f1-tick` or `f1-update` logs `table inet f1 is loaded again: starting the f1 stack (/srv/f1/state/current.env)` and starts the stack.
2. `f1-resolvers --quiet`: refreshes the DNS allowlist (`inet f1 resolvers4`) from `/etc/resolv.conf`.
3. Under `f1-update`'s lock: `restarting unhealthy container f1-<service>-1` for every f1 container Docker reports unhealthy (Docker only restarts a container that exited).
   While `f1-update` or `f1-install` holds the lock, f1-tick logs `f1-update or f1-install is running: no container restarts this round` and skips this step.
4. `disk use of /srv/f1: N%` and the file `/srv/f1/state/disk`.

```bash
sudo journalctl -u f1-tick -n 20 --no-pager
sudo cat /srv/f1/state/disk
sudo nft list set inet f1 resolvers4
sudo f1-resolvers
```

Expected: `disk` holds one line such as `2026-10-29T10:05:03Z 7`; `f1-resolvers` logs `f1 container DNS allowed to N IPv4 resolver(s) from /etc/resolv.conf` (or the systemd-resolved file when `/etc/resolv.conf` has only a loopback stub). A line `warning: no IPv4 resolver … f1 containers have no DNS until the next f1-tick` means the set is empty.

`f1-tick` exits 1 when it could not load the firewall, could not start the stack again, or could not read the disk use; the unit then shows as failed in `systemctl --failed`.

## Cloudflare ranges

`cf4` and `cf_tunnel4` change rarely. Refresh them as described in `docs/runbooks/cloudflare.md`.
