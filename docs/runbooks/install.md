# Runbook: install F1 Timings on the VM

Debian 13, Docker 29, the Waterheight VM (A§14.1). Every [box] command runs as root (`sudo`) from a checkout of this repository on the VM. Nothing here touches `/etc/rws`, `/srv/rws` or the `rws` project (invariant 5). Log lines start with a UTC time and the script name, e.g. `2026-10-29T10:00:00Z f1-update: deployed …`; the times are left out below.

## Prerequisites [owner]

| | |
|---|---|
| A1 | The VM is 6 vCPU / 12 GB (Hyper-V, VM off). |
| A2, A3 | Tunnel, token file and Access application: `docs/runbooks/cloudflare.md`. You need the tunnel token, the Access team name and the AUD tag. |
| A5 | After the first release run on `main`: GitHub, Packages, `f1-server` and `f1-web` → Package settings → Change visibility → Public (both). Dependabot is on (Settings → Code security). Branch protection on `main` stays as it is (A§12.4). |
| A5b | Before merging P1f: Settings → Environments → New environment `production`. Required reviewers = the owner, "Prevent self-review" unchecked, Deployment branches and tags = Selected branches and tags → `main`. From then on every merge to `main` waits in the Actions run for your approval before the `release` job touches GHCR; after you approve, `f1-update` picks the images up within 10 minutes. The environment must exist before the job first runs: otherwise GitHub creates it without protection. |
| A6 | healthchecks.io: see "A6" below. |
| A8 | **Hard precondition for step 6.** The fine-grained agent token, see "A8" below. |

Agents also cannot merge through `gh`: `.claude/settings.json` denies `gh api …/merge`, `gh api graphql` and `gh auth token`, on top of the branch protection and the environment approval.

Without A5 the first `docker pull` in `f1-update` fails and the timer retries quietly every 10 minutes.

## 1. Check out the repository [box]

```bash
git clone https://github.com/mwijkhuisen/F1_Timings.git ~/F1_Timings
cd ~/F1_Timings
```

## 2. Waterheight before-state [box]

```bash
sudo docker compose -p rws ps -q | sort > /tmp/rws.before
wc -l < /tmp/rws.before
```

Expected: the number of running rws containers, no error.

## 3. Install the host files [box]

```bash
sudo deploy/bin/f1-install
```

Expected on a new host (abridged; `ok` lines are checks that needed no change):

```
f1-install from /home/<you>/F1_Timings
ok       subnets 10.62.1.0/24 … 10.62.7.0/24 (no overlap with N routes and Docker networks)
ok       gids 62001-62006 and uid/gid 62532 are not used on the host
changed  /etc/f1 (root 0755)
changed  /etc/f1/secrets (root 0700)
…
changed  /etc/f1/secrets/db_postgres (empty, root:62001 0440)
changed  db_postgres generated
…
changed  /etc/f1/f1.env (template)
changed  /etc/f1/compose.yaml
changed  /usr/local/bin/f1-update
changed  /etc/f1/nftables-f1.conf
changed  /etc/systemd/system/f1-firewall.service
…
changed  f1-firewall.service enabled
changed  f1-firewall.service started (table inet f1)
fill these, then run 'systemctl enable --now f1-update.timer f1-tick.timer' (install runbook):
  /etc/f1/secrets/cf_tunnel_token
  /etc/f1/secrets/hc_ping_key
  /etc/f1/f1.env (CF_ACCESS_TEAM, CF_ACCESS_AUD)
f1-install: N change(s)
```

Exit 1 with `error: …` means nothing was installed. The causes: a subnet overlaps a route or a non-`f1` Docker network (`conflict: …`), a host group or user has one of the GIDs 62001-62006 or 62532, `nft -c` rejects the table, or `f1-update` is running (try again in a minute).

Check the firewall and the DNS allowlist:

```bash
sudo systemctl is-active f1-firewall.service
sudo nft list set inet f1 resolvers4
```

Expected: `active`, then a set with `elements = { <your resolver IPs> }`. Without IPv4 resolvers the set is empty and containers have no DNS until `f1-tick` runs again.

## 4. Fill the secrets and settings [box]

The values never go in a command line that is logged. The files keep `root:<gid> 0440`; edit them in place.

```bash
sudo nano /etc/f1/secrets/cf_tunnel_token   # the tunnel token, one line (cloudflare.md, A2)
sudo nano /etc/f1/secrets/hc_ping_key       # the healthchecks.io ping key, 22 characters (A6)
sudo nano /etc/f1/f1.env                    # CF_ACCESS_TEAM=<team>   CF_ACCESS_AUD=<64 hex>
sudo ls -l /etc/f1/secrets
```

Expected: six files, each `-r--r----- 1 root <gid>` with the groups `62001` to `62006` shown as numbers. `f1.env` holds exactly two lines (`CF_ACCESS_TEAM=…`, `CF_ACCESS_AUD=…`), no quotes, no other keys. The team is lowercase letters, digits and `-`; the AUD is 64 lowercase hex characters.

An editor that writes a new file (rather than in place) can reset the owner. Run `sudo deploy/bin/f1-install` again; it restores `root:<gid> 0440` and reports `changed`.

## 5. Idempotency and Waterheight unchanged [box]

```bash
sudo deploy/bin/f1-install | tail -n 1
sudo docker compose -p rws ps -q | sort > /tmp/rws.after
diff /tmp/rws.before /tmp/rws.after && echo rws-unchanged
```

Expected: `f1-install: 0 change(s)` (the list of files to fill is gone once they are filled), then `rws-unchanged`.

## 6. Enable the timers and run the first deploy [box]

**Do not enable the timers before A8: agents must use the fine-grained token without the Workflows permission; check `gh auth status` shows `github_pat_`.**

`f1-install` never enables the timers. Enable them once the secrets and `f1.env` are filled (until then `f1-update` logs `not configured … nothing to do` and exits 0).

```bash
sudo systemctl enable --now f1-update.timer f1-tick.timer
systemctl list-timers 'f1-*'
sudo systemctl start f1-update.service
sudo journalctl -u f1-update -n 30 --no-pager
```

Expected journal:

```
f1-update: deploying server ghcr.io/mwijkhuisen/f1-server@sha256:… web ghcr.io/mwijkhuisen/f1-web@sha256:…
f1-update: smoke test passed: http://127.0.0.1:8180/healthz 200, no f1 container unhealthy, starting or restarting
f1-update: deployed server ghcr.io/mwijkhuisen/f1-server@sha256:… web ghcr.io/mwijkhuisen/f1-web@sha256:…
```

The migrate job's own output sits between the first two lines. Then:

```bash
sudo docker compose -p f1 ps
curl -fsS 127.0.0.1:8180/healthz
sudo cat /srv/f1/state/current.env
```

Expected: `db`, `api`, `ingest`, `caddy` and `cloudflared` running, and healthy after about a minute, the health body from `/healthz`, and `current.env` with `F1_SERVER_IMAGE=…@sha256:…` and `F1_WEB_IMAGE=…@sha256:…`.

If the first deploy fails: `f1-update: first deploy failed: … is in /srv/f1/state/failed.env and is not retried automatically`, exit 1, containers left as they are. Read `journalctl -u f1-update`, `sudo docker compose -p f1 ps` and `sudo docker logs f1-db-1`; fix the cause; `sudo rm /srv/f1/state/failed.env`; start the service again. Common causes: the GHCR packages are private (A5), `cf_tunnel_token` empty (cloudflared restarts), a malformed `f1.env`.

## 7. Egress acceptance [box]

`ingest` may go out on tcp/443 only; `api` only to Cloudflare's ranges on tcp/443. Use a host that is not Cloudflare for the "blocked" probes (`www.google.com`).

```bash
sudo docker exec f1-ingest-1 /nodejs/bin/node -e "fetch('http://www.google.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
sudo docker exec f1-ingest-1 /nodejs/bin/node -e "fetch('https://www.google.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
sudo docker exec f1-api-1 /nodejs/bin/node -e "fetch('https://www.google.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
sudo docker exec f1-api-1 /nodejs/bin/node -e "fetch('https://<team>.cloudflareaccess.com/cdn-cgi/access/certs',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
```

Expected, in order: `blocked TimeoutError`, `open 200`, `blocked TimeoutError`, `open 200`. (The error name can differ, e.g. `TypeError`; what counts is `blocked` against `open 200`.)

## 8. Rollback drill [box]

Proves that a bad image rolls back. Build the broken image exactly as the CI end-to-end test does: the real server image, with an entrypoint whose `migrate` passes and every other role exits 1. Then deploy it.

```bash
sudo docker pull ghcr.io/mwijkhuisen/f1-server:main
printf '%s\n' 'FROM ghcr.io/mwijkhuisen/f1-server:main' \
  "ENTRYPOINT [\"/nodejs/bin/node\",\"-e\",\"process.exit(process.argv[1]==='migrate'?0:1)\"]" |
  sudo docker build -q -t f1-server:broken -
sudo cp /srv/f1/state/current.env /tmp/current.before
sudo F1_SMOKE_TIMEOUT=60 f1-update --server f1-server:broken; echo "exit $?"
```

Expected (the web image stays the one in `current.env`):

```
f1-update: deploying server f1-server:broken web ghcr.io/mwijkhuisen/f1-web@sha256:…
f1-update: smoke test failed: no 200 from http://127.0.0.1:8180/healthz within 60 s
f1-update: deploy of server f1-server:broken web … failed: rolling back to /srv/f1/state/current.env
f1-update: smoke test passed: http://127.0.0.1:8180/healthz 200, no f1 container unhealthy, starting or restarting
f1-update: rolled back to /srv/f1/state/current.env; server f1-server:broken web … is in /srv/f1/state/failed.env and is not retried automatically (rm /srv/f1/state/failed.env to retry)
exit 1
```

Verify, run the same command again (it must skip), and clean up:

```bash
sudo diff /tmp/current.before /srv/f1/state/current.env && echo current-unchanged
curl -fsS 127.0.0.1:8180/healthz
sudo f1-update --server f1-server:broken; echo "exit $?"
sudo rm /srv/f1/state/failed.env
sudo docker rmi f1-server:broken
```

Expected: `current-unchanged`, the health body, then `skipping known-bad server f1-server:broken web …; rm /srv/f1/state/failed.env to retry` and `exit 0`. The `rm` is required: it clears the known-bad pair.

## 9. Waterheight still works [owner]

Open the Waterheight site as usual and check that it loads and shows current data. Then:

```bash
sudo docker compose -p rws ps
```

Expected: the same containers as in `/tmp/rws.before`, all healthy.

## A6: healthchecks.io [owner]

Invariant 5: F1 shares no healthchecks group with Waterheight.

1. Create a separate project "F1" in healthchecks.io (not a check in Waterheight's project).
2. In that project's Settings, create a ping key (22 characters).
3. Create a check with slug `f1-ingest`, period 1 day, grace 1 hour.
4. Put the ping key in the secret file (a shell line is fine; the value is not logged):
   `sudo nano /etc/f1/secrets/hc_ping_key`
5. `ingest` pings `https://hc-ping.com/<ping key>/f1-ingest` once the schedule sync requested by the daily `30 0 * * *` (UTC) Cron, or by its 15-minute retry, has succeeded. The startup sync does not ping, so a crash-looping ingest cannot stay green. The check turns up after the first deploy and the first 00:30 UTC; period 1 day and grace 1 hour still fit.

`f1-live` is created by P2c.

## A8: before the first deploy from main [owner]

Agents move from the owner's admin token to a token without admin rights (A§12.4).

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:
   - Repository access: only `mwijkhuisen/F1_Timings`.
   - Repository permissions: Contents, Pull requests, Issues: read and write (Metadata read is implied). No Administration, no Secrets, no Workflows.
   - An expiry (for example 90 days). Put the renewal in your calendar.
2. In the agent environment, log in with it and set git to use it:

   ```bash
   gh auth login --with-token < /path/to/token-file
   gh auth setup-git
   ```

   Delete the token file afterwards.
3. Check:

   ```bash
   gh auth status
   ```

   Expected: logged in to github.com, `Token: github_pat_*****`. A token that starts with `gho_` is still the admin token.
4. Branch protection on `main` stays intact: `ci` and `security` required, enforced for admins, no force-push or deletion, a pull request before merging.
5. The token has no Workflows permission, so GitHub rejects a push that changes `.github/workflows`. A PR that touches those files is pushed by the owner after the line-by-line read.
