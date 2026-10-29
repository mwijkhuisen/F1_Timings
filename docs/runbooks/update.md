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

So an unhealthy `ingest` or `cloudflared` fails a deploy and rolls it back too.

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

`migrate` (dbmate in the server image, as `f1_migrator`) runs at every deploy, after `db` is healthy and before `api` and `ingest` are recreated. A failed deploy rolls the images back, never the schema. So:

- A migration must be expand-only for one release: add a table, column or view; never drop or rename what the previous release still reads. The old image then runs on the new schema, which is exactly what a rollback runs.
- The contract step (drop, rename, tighten) goes into a later release, once no release you could roll back to needs the old shape.
- An applied migration never changes. A mistake is fixed forward in a new migration.
- A failed migration is not retried by hand; dbmate runs each file in a transaction, so it leaves nothing behind. Fix it forward in a new PR.

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
