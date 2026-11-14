#!/usr/bin/env bash
# e2e (CI only, as root: ci / deploy, step `e2e`; D13). The only run of the deploy path before the
# box: the real f1-install, f1-update and f1-tick on the runner's Docker, with the f1 table loaded.
# CI never calls OpenF1, F1, Cloudflare or healthchecks.io (invariant 4): deploy/tests/ci.override.yaml
# keeps ingest and cloudflared out (profile "off"), nothing here enables a timer, and live runs only
# because without ingest the session table is empty, so it idles and calls nothing (asserted here);
# step 11a's synthetic session exists only while live is stopped.
# hc-ping.com is pinned to 127.0.0.1 in /etc/hosts and the dummy ping key is malformed, so every alert
# logs alert_key_invalid (or alert_no_key) and sends nothing; the one request, in step 12, goes to
# loopback (asserted at the end). It needs the images f1-server:ci and f1-web:ci (built by the job)
# and nft, curl, flock, getent, journalctl, systemd-analyze, ip netns, python3, groupadd and useradd.
# The edge checks (1b, 3f, 3g, 3h) log every miss as an ::error:: line and go on, so one run shows
# them all; the run fails at the end of 3h if any was missed. Their set-up failures fail at once.
#   1. f1-install twice: the second run makes 0 changes; systemd-analyze verify on the units (the
#      template f1-alert@.service too); f1-update.service and f1-tick.service have OnFailure=
#      f1-alert@<unit>.service; /srv/f1/live, /srv/f1/archive and /srv/f1/state/live are 62532:62532 0700,
#      /srv/f1/jolpica is root:62532 0750 and /srv/f1/state stays root 0700.
#  1b. f1-install's guards, before any deploy: a Docker network on 10.62.3.0/24, a blackhole route
#      10.62.5.0/24 (table 62999, which no rule uses), a host group 62005, a host group 62532 (the
#      container gid) and a host user 62532 each make it exit 1 with its conflict line and leave
#      /etc/f1/compose.yaml as it was; then a clean run installs the checkout's file again.
#   2. Dummy cf_tunnel_token, f1tv_username and f1tv_password, and f1.env with CF_ACCESS_TEAM=ci and a
#      64-hex AUD. With hc_ping_key still empty, f1-update --server f1-server:ci --web f1-web:ci
#      exits 0 with "not configured": no f1 container, no current.env. Then hc_ping_key (malformed on
#      purpose); 127.0.0.1 hc-ping.com in /etc/hosts, and getent resolves it to 127.0.0.1 only.
#   3. f1-update --server f1-server:ci --web f1-web:ci: exit 0, current.env, /healthz 200 on
#      127.0.0.1:8180 (caddy, api and db as 62532; the publish through f1-publish; local tags),
#      every container healthy when it returns (the smoke test waits for that); live is idle on an
#      empty schedule.
#  3a. The app's files (#121): /sw.js a 200 of text/javascript or application/javascript (a service
#      worker takes either; Go defers to the image's mime.types) with Cache-Control no-cache,
#      /manifest.webmanifest application/manifest+json and /icon-512.png image/png.
#  3b. The archive job (profile jobs) without a token file: exit 1 with token_file, after its f1_ingest
#      login and before any request (it never reaches the Index: invariant 4).
#  3c. The fill job (profile jobs) on the migrated, empty database: exit 0 with fill_done.
#  3d. The jolpica job (profile jobs) on the empty /srv/f1/jolpica: exit 1 with jolpica_done error bad_dump.
#  3e. F1_REVISION (#98): the f1-server:ci image's ENV equals its revision label, and the f1-web:ci build
#      embeds it under /srv/www/assets.
#  3f. What Caddy serves on 127.0.0.1:8180 (deploy/web/Caddyfile): 13 requests (the SPA, /healthz, a
#      missing file, POST, a 2 KB body to the api and to /healthz, a dotfile, two missing assets (one
#      with an extension, one without), an unknown /api path, a dot segment under /api (--path-as-is),
#      OPTIONS on the api, the api's own 401); each has its status, each of the 8 site headers exactly
#      once and no Server or Via; GET / has Cache-Control no-cache, the 405 Allow GET, HEAD, the asset
#      miss no immutable Cache-Control.
#  3g. The firewall (A§14.3), with table inet f1 and without it: a veth into the netns e2e-fw holds a
#      /30 in each private range (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16; not 127/8) and in
#      TEST-NET-3 (203.0.113.0/24, the public stand-in), with python3 listeners there (:443 and :53)
#      and on the gateways of f1-egress and f1-publish. `ip route get` puts every target on e2e-fw0 or
#      on the host before any probe. Two test addresses go into the resolvers4 set. A node probe
#      (f1-server:ci in the container's network namespace, read-only, no capabilities) from live: every
#      private :443 and the f1-egress gateway dropped, 203.0.113.2:443 open (the positive control),
#      203.0.113.2:53 and 10.255.62.2:53 open (the DNS accept comes before the private drop; f1-egress
#      otherwise allows 443 only); from caddy: 203.0.113.2:443, 203.0.113.2:53 and the f1-publish
#      gateway dropped; from api: 203.0.113.2:443 dropped (not in cf4). Without the table all 13 are
#      open, so the drops are the table's. f1-firewall.service loads it again and the restart empties
#      resolvers4 of the test address.
#  3h. The recreate path: caddy labelled through an extra compose file, then f1-install with a changed
#      /etc/f1/compose.yaml recreates the stack and smoke-tests it (caddy has a new Id and no label);
#      a second run makes 0 changes. The edge checks fail here if any was missed.
#  4b. f1-measure 60s 2 in the background; after 8 s `docker restart f1-live-1`, then SIGTERM: exit 0
#      and the summary (the signal path), stats rows for db, api, caddy and live, the disk rows
#      live-recordings and db-volume, a die and a restart event row for live, the TSV root 0600.
#  4c. The deploy hold: with live stopped and recorder_status fresh and not idle, f1-update --server
#      f1-server:broken exits 0 with "deploy deferred", current.env, the api container and
#      candidate.env untouched, held-since written. Then the row is made 10 minutes old (live is down:
#      no hold).
#   5. f1-update --server f1-server:broken (migrate passes, api and live exit): exit 1, "rolled back",
#      current.env unchanged, failed.env written, /healthz 200 again; the same pair again is
#      skipped as known-bad, with no alert (a drill). The stale row of 4c did not hold this deploy.
#  5a. The 14 h cap: live stopped, recorder_status recording and fresh, held-since 15 h old (fresh
#      mtime): f1-update --server f1-server:broken deploys anyway (the "held for over 14 h" error, no
#      alert: a drill), fails, rolls back (exit 1, current.env unchanged, failed.env written) and
#      removes held-since.
#  5b. After the rollback live runs, is healthy and writes recorder_status idle again.
#   6. docker inspect of db, api, caddy and live: read-only root, CapDrop ALL, user 62532:62532,
#      no-new-privileges, core size 0; caddy's 127.0.0.1:8180 is the only published port.
#   7. f1-tick restores a deleted table inet f1, runs the recorder watch on the migrated schema and
#      writes the disk file (free bytes of /srv/f1 and of the Docker data root).
#   8. A local tag with a registry host (localhost/f1-server:ci) is pulled, never recorded as given.
#   9. f1-tick skips the container restarts while the update lock is held (the recorder watch and
#      the disk file still run).
#  10. Without its firewall (table deleted, conf moved away) f1-tick stops the stack and f1-update
#      refuses to deploy; with the conf back, f1-tick reloads the table and starts the stack.
#  11. The restart loop: a throw-away unhealthy f1-e2e-sick-1 (label project f1) restarted in 4 ticks
#      in a row alerts restart_loop on the third only; once it is gone, a tick clears the alert.
# 11a. The recorder watch's positive path through the real f1-tick: live stopped first (invariant 4),
#      then a synthetic session starting in 30 min and recorder_status 10 min old with login_failed:
#      the first tick alerts recorder_missing, recorder_stale and login_failed once each with the
#      session key and writes their state files, the second alerts none (dedupe); with a recording
#      and a fresh status a third clears the three. The rows are deleted before live starts again.
#  12. OnFailure: with an empty key and F1_SMOKE_TIMEOUT=bad (a runtime drop-in) f1-update.service
#      fails, and f1-alert@f1-update.service.service logs alert_no_key unit_failed f1-update.service;
#      with the malformed key the sandboxed f1-alert@e2e.service logs alert_key_invalid; with a
#      22-character fake key f1-alert test_alert exits 1, curl 7 on the pinned loopback; with the
#      key file moved away it exits 0 with alert_no_key.
# Invariant 4 at the end: no alert_sent anywhere, the only alert_failed is step 12's, and at least one
# alert_key_invalid or alert_no_key (so the check is not vacuous).
# Not here: f1-update's revision check (server and web :main from different commits) runs on the
# default ghcr.io refs only, which CI cannot pull.
# Usage: sudo bash deploy/tests/e2e.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
export F1_COMPOSE_OVERRIDE=$repo/deploy/tests/ci.override.yaml
readonly STATE=/srv/f1/state URL=http://127.0.0.1:8180/healthz BIN=/usr/local/bin
readonly DROPIN=/run/systemd/system/f1-update.service.d/e2e.conf
readonly KEY_AWAY=/etc/f1/secrets/hc_ping_key.e2e # step 12's absent key (a rename keeps owner and mode)
readonly WATCH_KEY=99104 # step 11a's synthetic meeting and session
watch_rows=0             # 1 while step 11a's rows may exist: on_exit deletes them before live starts
umask 022

proofs=()
proof() {
  proofs+=("$*")
  echo "PROOF: $*"
}
group=0
step() {
  ((group == 0)) || echo "::endgroup::"
  group=1
  echo "::group::$*"
}
fail() {
  echo "::error::e2e: $*"
  exit 1
}
missed=() # misses of the edge checks (1b, 3f, 3g, 3h): logged at once; the run fails at the end of 3h
miss() {
  missed+=("$*")
  echo "::error::e2e: $*"
}
fw_pids=() # step 3g's listeners
on_exit() {
  local rc=$?
  ((group == 0)) || echo "::endgroup::"
  if ((rc != 0)); then
    echo "::group::diagnostics"
    docker compose -p f1 ps -a 2>&1 || true
    for s in db api caddy live; do docker logs --tail 60 "f1-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    nft list table inet f1 2>&1 | head -n 80 || true
    journalctl -u 'f1-alert@*' --no-pager -n 40 2>&1 || true
    echo "::endgroup::"
  fi
  docker rm -f f1-e2e-sick-1 >/dev/null 2>&1 || true
  ((${#fw_pids[@]} == 0)) || kill "${fw_pids[@]}" 2>/dev/null || true
  ip netns del e2e-fw 2>/dev/null || true
  # Best effort, for a run that failed inside an edge check: never leave the stack unfiltered or the host changed.
  nft list table inet f1 >/dev/null 2>&1 || systemctl restart f1-firewall.service >/dev/null 2>&1 || true
  docker network rm e2e-overlap >/dev/null 2>&1 || true
  ip route del blackhole 10.62.5.0/24 table 62999 >/dev/null 2>&1 || true
  groupdel e2e-gid >/dev/null 2>&1 || true
  groupdel e2e-cgid >/dev/null 2>&1 || true
  userdel e2e-uid >/dev/null 2>&1 || true
  # Invariant 4: live starts again only once step 11a's session is gone.
  if ((watch_rows)) && docker exec f1-db-1 psql -U postgres -d f1 -v ON_ERROR_STOP=1 -tAc "DELETE FROM recording WHERE session_key = $WATCH_KEY; DELETE FROM session WHERE session_key = $WATCH_KEY; DELETE FROM meeting WHERE meeting_key = $WATCH_KEY" >/dev/null 2>&1; then
    docker start f1-live-1 >/dev/null 2>&1 || true
  fi
  [[ ! -f $KEY_AWAY ]] || mv -f -- "$KEY_AWAY" /etc/f1/secrets/hc_ping_key
  if [[ -e $DROPIN ]]; then
    rm -f -- "$DROPIN"
    systemctl daemon-reload || true
  fi
  [[ ! -f ${tmp:-}/hosts ]] || cp "$tmp/hosts" /etc/hosts
  printf '\n%s\n' "== e2e evidence (${#proofs[@]} proofs, exit $rc) =="
  printf -- '- %s\n' "${proofs[@]}"
}
trap on_exit EXIT
((EUID == 0)) || fail "run as root"
for image in f1-server:ci f1-web:ci; do docker image inspect "$image" >/dev/null || fail "image $image is missing"; done
docker version --format 'Docker {{.Server.Version}} (API {{.Server.APIVersion}})'
docker compose version
tmp=$(mktemp -d)

# run <log> <command…>: the command's output goes to <log> and to the job log; its exit code to $rc.
rc=0
run() {
  local out=$1
  shift
  rc=0
  "$@" >"$out" 2>&1 || rc=$?
  cat "$out"
}
# must <command…>: a set-up step of an edge check; its failure fails the run at once.
must() { "$@" || fail "set-up failed: $*"; }

# ------------------------------------------------------------------ 1
step "1. f1-install twice (the second makes no change), systemd-analyze verify"
run "$tmp/install1" "$repo/deploy/bin/f1-install"
((rc == 0)) || fail "the first f1-install failed (exit $rc)"
run "$tmp/install2" "$repo/deploy/bin/f1-install"
((rc == 0)) || fail "the second f1-install failed (exit $rc)"
[[ $(tail -n 1 "$tmp/install2") == 'f1-install: 0 change(s)' ]] || fail "the second f1-install changed something"
nft list table inet f1 >/dev/null || fail "f1-install did not load table inet f1"
systemctl is-active --quiet f1-firewall.service || fail "f1-firewall.service is not active"
systemd-analyze verify /etc/systemd/system/f1-* || fail "systemd-analyze verify rejects an f1 unit"
for u in f1-update f1-tick; do
  on_failure=$(systemctl show -p OnFailure --value "$u.service")
  [[ $on_failure == "f1-alert@$u.service.service" ]] || fail "$u.service has OnFailure '$on_failure'"
done
# O1: the recorder's two directories belong to the container user; the state directory itself, which holds
# current.env, stays root-only.
for d in /srv/f1/live /srv/f1/state/live; do
  [[ $(stat -c '%a %u:%g' "$d") == '700 62532:62532' ]] || fail "$d is not 62532:62532 0700: $(stat -c '%a %u:%g' "$d")"
done
[[ $(stat -c '%a %u:%g' /srv/f1/archive) == '700 62532:62532' ]] || fail "/srv/f1/archive is not 62532:62532 0700: $(stat -c '%a %u:%g' /srv/f1/archive)"
[[ $(stat -c '%a %u:%g' /srv/f1/jolpica) == '750 0:62532' ]] || fail "/srv/f1/jolpica is not root:62532 0750: $(stat -c '%a %u:%g' /srv/f1/jolpica)"
[[ $(stat -c '%a %u:%g' /srv/f1/state) == '700 0:0' ]] || fail "/srv/f1/state is not root 0700: $(stat -c '%a %u:%g' /srv/f1/state)"
proof "f1-install ran twice, the second: '$(tail -n 1 "$tmp/install2")'; f1-firewall.service active, table inet f1 loaded (resolvers4 $(nft list set inet f1 resolvers4 | grep -o 'elements = {[^}]*}' || echo empty)); systemd-analyze verify passes: $(echo /etc/systemd/system/f1-*); OnFailure: f1-update.service -> $(systemctl show -p OnFailure --value f1-update.service), f1-tick.service -> $(systemctl show -p OnFailure --value f1-tick.service); /srv/f1/live, /srv/f1/archive and /srv/f1/state/live are 62532:62532 0700, /srv/f1/state is still root 0700"

# ------------------------------------------------------------------ 1b
step "1b. f1-install's guards: an overlapping subnet, a used GID or UID stops it before it installs anything"
n=${#missed[@]}
# refused <case> <text>: f1-install exits 1 with <text> and leaves /etc/f1/compose.yaml alone (it
# differs from the checkout here, so a guard that did not stop would install the file again).
refused() {
  local sha
  printf '# e2e: differs from the checkout\n' >>/etc/f1/compose.yaml
  sha=$(sha256sum </etc/f1/compose.yaml)
  run "$tmp/guard-$1" "$repo/deploy/bin/f1-install"
  ((rc == 1)) || miss "1b $1: f1-install exited $rc, not 1"
  grep -qF -- "$2" "$tmp/guard-$1" || miss "1b $1: f1-install did not log '$2'"
  [[ $(sha256sum </etc/f1/compose.yaml) == "$sha" ]] || miss "1b $1: f1-install changed /etc/f1/compose.yaml"
}
# Not f1-*: the guard skips f1's own networks and routes.
must docker network create --subnet 10.62.3.0/24 e2e-overlap
refused subnet 'conflict: 10.62.3.0/24 overlaps the Docker network e2e-overlap'
must docker network rm e2e-overlap
must ip route add blackhole 10.62.5.0/24 table 62999
refused route 'conflict: 10.62.5.0/24 overlaps the route 10.62.5.0/24 dev none'
must ip route del blackhole 10.62.5.0/24 table 62999
must groupadd -g 62005 e2e-gid
refused gid 'gid 62005 is already the host group e2e-gid'
must groupdel e2e-gid
# The container gid, which f1-install's loop checks too (useradd -N below makes no group of its own).
must groupadd -g 62532 e2e-cgid
refused cgid 'gid 62532 is already the host group e2e-cgid'
must groupdel e2e-cgid
must useradd -M -N -u 62532 -s /usr/sbin/nologin e2e-uid
refused uid 'uid 62532 is already the host user e2e-uid'
must userdel e2e-uid
run "$tmp/install3" "$repo/deploy/bin/f1-install"
((rc == 0)) || miss "1b: the clean f1-install after the guards exited $rc"
cmp -s "$repo/deploy/compose.yaml" /etc/f1/compose.yaml || miss "1b: the clean f1-install did not install the checkout's compose.yaml"
if ((${#missed[@]} == n)); then
  proof "f1-install refused 5 times with exit 1 and /etc/f1/compose.yaml unchanged: '$(grep -ohF 'conflict: 10.62.3.0/24 overlaps the Docker network e2e-overlap' "$tmp/guard-subnet")', '$(grep -ohF 'conflict: 10.62.5.0/24 overlaps the route 10.62.5.0/24 dev none' "$tmp/guard-route")', '$(grep -oh 'gid 62005 is already.*' "$tmp/guard-gid")', '$(grep -oh 'gid 62532 is already.*' "$tmp/guard-cgid")', '$(grep -oh 'uid 62532 is already.*' "$tmp/guard-uid")'; then a clean run: exit 0, '$(tail -n 1 "$tmp/install3")', the checkout's compose.yaml installed (no current.env, so nothing recreated)"
fi

# ------------------------------------------------------------------ 2
step "2. Dummy secrets (live reads the F1 TV ones only for a login, and none is due here), f1.env, 'not configured', the hc-ping.com pin"
printf 'ci-dummy-tunnel-token\n' >/etc/f1/secrets/cf_tunnel_token
printf 'ci-dummy-f1tv-user\n' >/etc/f1/secrets/f1tv_username
printf 'ci-dummy-f1tv-pass\n' >/etc/f1/secrets/f1tv_password
printf 'CF_ACCESS_TEAM=ci\nCF_ACCESS_AUD=%064d\n' 0 >/etc/f1/f1.env
# Every setting but one: f1-update must stop at its readiness check. The drill flags name local images,
# so a broken check deploys f1-server:ci and never pulls :main.
[[ -f /etc/f1/secrets/hc_ping_key && ! -s /etc/f1/secrets/hc_ping_key ]] || fail "hc_ping_key is not the empty file f1-install leaves"
run "$tmp/update0" "$BIN/f1-update" --server f1-server:ci --web f1-web:ci
((rc == 0)) || fail "f1-update with an empty hc_ping_key exited $rc, not 0"
grep -q 'not configured' "$tmp/update0" || fail "f1-update with an empty hc_ping_key did not log 'not configured'"
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=f1) ]] || fail "f1-update with an empty hc_ping_key created f1 containers"
[[ ! -e $STATE/current.env ]] || fail "f1-update with an empty hc_ping_key wrote current.env"
# Invariant 4, belt and braces: a ping key that fails healthchecks.ts's and f1-alert's 22-character
# check, so no alert and no ping of live sends a request; and hc-ping.com on loopback only.
printf 'ci.dummy.not.a.ping.key\n' >/etc/f1/secrets/hc_ping_key
cp /etc/hosts "$tmp/hosts"
printf '127.0.0.1 hc-ping.com\n' >>/etc/hosts
hc_ip=$(getent ahosts hc-ping.com | awk '{print $1}' | sort -u) || true
[[ $hc_ip == 127.0.0.1 ]] || fail "hc-ping.com resolves to '$hc_ip', not 127.0.0.1 only"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/cf_tunnel_token) == '440 0 62005' ]] || fail "cf_tunnel_token lost root:62005 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/hc_ping_key) == '440 0 62006' ]] || fail "hc_ping_key lost root:62006 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/f1tv_username) == '440 0 62007' ]] || fail "f1tv_username lost root:62007 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/f1tv_password) == '440 0 62008' ]] || fail "f1tv_password lost root:62008 0440"
proof "with only hc_ping_key empty, f1-update --server f1-server:ci --web f1-web:ci: exit 0, '$(grep -o 'not configured.*' "$tmp/update0")', no f1 container, no current.env; cf_tunnel_token, hc_ping_key (malformed: ci.dummy.not.a.ping.key), f1tv_username and f1tv_password hold dummies (root:<gid> 0440 kept), f1.env has CF_ACCESS_TEAM=ci and a 64-hex AUD; /etc/hosts pins hc-ping.com, getent ahosts: $hc_ip"

# ------------------------------------------------------------------ 3
step "3. First deploy: f1-update --server f1-server:ci --web f1-web:ci"
run "$tmp/update1" "$BIN/f1-update" --server f1-server:ci --web f1-web:ci
((rc == 0)) || fail "f1-update exited $rc"
grep -q 'deployed server f1-server:ci web f1-web:ci' "$tmp/update1" || fail "f1-update did not log the deploy"
[[ $(cat "$STATE/current.env") == $'F1_SERVER_IMAGE=f1-server:ci\nF1_WEB_IMAGE=f1-web:ci' ]] ||
  fail "current.env: $(cat "$STATE/current.env")"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200"
services=$(docker ps -a --filter label=com.docker.compose.project=f1 --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')
[[ $services == 'api caddy db live ' ]] || fail "the f1 containers are '$services', not 'api caddy db live'"
mapfile -t health < <(docker ps --filter label=com.docker.compose.project=f1 --format '{{.Names}} {{.Status}}')
for h in "${health[@]}"; do [[ $h == *'(healthy)' ]] || fail "not healthy when f1-update returned: $h"; done
[[ $(docker inspect -f '{{.State.Health.Status}}' f1-live-1) == healthy ]] || fail "f1-live-1 is not healthy"
# Invariant 4 rests on the empty schedule: an idle recorder has no session to log in for or to record.
live_status=$(docker exec f1-db-1 psql -U postgres -d f1 -tAc "SELECT state, (SELECT count(*) FROM session) FROM recorder_status")
[[ $live_status == 'idle|0' ]] || fail "recorder_status.state and the session count are '$live_status', not 'idle|0'"
proof "f1-update deployed the local tags f1-server:ci and f1-web:ci (exit 0, current.env written); $URL answers 200 through caddy, api and db (db as 62532 on a new f1_pgdata, roles.sql through initdb, migrate as f1_migrator) with table inet f1 loaded; containers: ${services% } (no ingest, no cloudflared), each healthy when f1-update returned; live idle on an empty schedule (state|sessions: $live_status)"

# ------------------------------------------------------------------ 3a
step "3a. The service worker, the manifest and the icon are served with their types (#121)"
# served <path> <type regexp>: a 200 with that Content-Type; the headers stay in $tmp/head.
served() {
  curl -sSI --max-time 5 "http://127.0.0.1:8180$1" | tr -d '\r' >"$tmp/head"
  [[ $(head -n 1 "$tmp/head") =~ ^HTTP/[0-9.]+\ 200 ]] || fail "$1 is not 200: $(head -n 1 "$tmp/head")"
  grep -qiE "^content-type: $2\$" "$tmp/head" || fail "$1: $(grep -i '^content-type' "$tmp/head" || echo 'no Content-Type')"
}
served /sw.js '(text|application)/javascript(; ?charset=utf-8)?'
grep -qix 'cache-control: no-cache' "$tmp/head" || fail "/sw.js: $(grep -i '^cache-control' "$tmp/head" || echo 'no Cache-Control')"
served /manifest.webmanifest 'application/manifest\+json'
served /icon-512.png 'image/png'
proof "HEAD on 127.0.0.1:8180: /sw.js 200 text/javascript or application/javascript with Cache-Control no-cache, /manifest.webmanifest 200 application/manifest+json, /icon-512.png 200 image/png"

# ------------------------------------------------------------------ 3b
step "3b. The archive job without a token file exits 1 before any request"
[[ ! -e /srv/f1/state/live/f1tv-token ]] || fail "a token file exists: the archive job would call F1"
run "$tmp/archive" docker compose -p f1 -f /etc/f1/compose.yaml -f "$F1_COMPOSE_OVERRIDE" --env-file "$STATE/current.env" \
  --profile jobs run --rm -T archive archive 2019
((rc == 1)) || fail "the archive job exited $rc, not 1"
done_line=$(grep '"msg":"archive_done"' "$tmp/archive" || true)
[[ $done_line == *'"error":"token_file"'* ]] || fail "the archive job did not stop on token_file: $done_line"
grep -q '"msg":"archive_start"' "$tmp/archive" && fail "the archive job got past the token check"
proof "compose --profile jobs run --rm archive archive 2019 without /srv/f1/state/live/f1tv-token: exit 1, archive_done error token_file (after the f1_ingest advisory lock, before the Index request)"

# ------------------------------------------------------------------ 3c
step "3c. The fill job (profile jobs) on the migrated, empty database exits 0"
run "$tmp/fill" docker compose -p f1 -f /etc/f1/compose.yaml -f "$F1_COMPOSE_OVERRIDE" --env-file "$STATE/current.env" \
  --profile jobs run --rm -T fill fill --all
((rc == 0)) || fail "the fill job exited $rc, not 0"
grep -q '"msg":"fill_done"' "$tmp/fill" || fail "the fill job did not finish: no fill_done line"
proof "compose --profile jobs run --rm fill fill --all: exit 0, fill_done (as f1_ingest on f1-db only, /srv/f1/archive and /srv/f1/live read-only; no session yet)"

# ------------------------------------------------------------------ 3d
step "3d. The jolpica job (profile jobs) on the empty /srv/f1/jolpica exits 1 with bad_dump"
run "$tmp/jolpica" docker compose -p f1 -f /etc/f1/compose.yaml -f "$F1_COMPOSE_OVERRIDE" --env-file "$STATE/current.env" \
  --profile jobs run --rm -T jolpica jolpica
((rc == 1)) || fail "the jolpica job exited $rc, not 1"
done_line=$(grep '"msg":"jolpica_done"' "$tmp/jolpica" || true)
[[ $done_line == *'"error":"bad_dump"'* ]] || fail "the jolpica job did not stop on bad_dump: $done_line"
proof "compose --profile jobs run --rm jolpica jolpica on the empty /srv/f1/jolpica (root 0750, group 62532): exit 1, jolpica_done error bad_dump (as f1_ingest on f1-db only, the directory read-only)"

# ------------------------------------------------------------------ 3e
step "3e. F1_REVISION reaches both builds (the api's ENV and the web's bundle)"
# Read from the label: sudo drops the job's environment.
rev=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' f1-server:ci)
[[ $rev =~ ^[0-9a-f]{40}$ ]] || fail "f1-server:ci has no 40-hex revision label (a dev build proves nothing): $rev"
env_lines=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' f1-server:ci)
grep -qx "F1_REVISION=$rev" <<<"$env_lines" || fail "f1-server:ci has no ENV F1_REVISION=$rev"
# BusyBox grep (the caddy image) has no --include: the assets directory holds the bundle only.
docker run --rm --entrypoint grep f1-web:ci -rlF "$rev" /srv/www/assets >/dev/null \
  || fail "f1-web:ci embeds no $rev under /srv/www/assets"
proof "F1_REVISION=$rev is the f1-server:ci ENV and sits in the f1-web:ci bundle (/srv/www/assets)"

# ------------------------------------------------------------------ 3f
step "3f. What Caddy serves: each status with the 8 site headers, each once, and no Server or Via"
n=${#missed[@]}
# deploy/web/Caddyfile's (site_headers), exactly.
readonly SITE_HEADERS=(
  "content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
  'strict-transport-security: max-age=31536000; includeSubDomains'
  'x-content-type-options: nosniff'
  'referrer-policy: strict-origin-when-cross-origin'
  'permissions-policy: geolocation=(), camera=(), microphone=()'
  'cross-origin-opener-policy: same-origin'
  'cross-origin-resource-policy: same-origin'
  'x-robots-tag: noindex'
)
head -c 2048 /dev/zero | tr '\0' x >"$tmp/2k" # over the api's 1 KB request_body limit
edge_seen=()
# edge <status> <path> [<curl args…>]: one request to 127.0.0.1:8180; its headers stay in $tmp/edge.h.
edge() {
  local want=$1 path=$2 what status h got
  shift 2
  what="$path${*:+ ${*//"$tmp/"/}}"
  : >"$tmp/edge.h"
  if ! curl -sS --max-time 5 -o "$tmp/edge.b" -D "$tmp/edge.raw" "$@" "http://127.0.0.1:8180$path"; then
    miss "3f $what: curl failed"
    return 0
  fi
  tr -d '\r' <"$tmp/edge.raw" >"$tmp/edge.h"
  status=$(head -n 1 "$tmp/edge.h")
  edge_seen+=("$what ${status#HTTP/* }")
  [[ $status =~ ^HTTP/[0-9.]+\ $want(\ |$) ]] || miss "3f $what: '$status', not $want"
  for h in "${SITE_HEADERS[@]}"; do
    grep -qixF -- "$h" "$tmp/edge.h" && continue
    got=$(grep -i "^${h%%:*}:" "$tmp/edge.h" || echo 'none')
    miss "3f $what ($want): ${h%%:*} is '$got'"
  done
  for h in "${SITE_HEADERS[@]}"; do
    got=$(grep -ci "^${h%%:*}:" "$tmp/edge.h" || true)
    ((got == 1)) || miss "3f $what ($want): ${h%%:*} occurs $got times, not once"
  done
  got=$(grep -iE '^(server|via):' "$tmp/edge.h" || true)
  [[ -z $got ]] || miss "3f $what ($want): names the software: ${got//$'\n'/; }"
}
edge 200 /
grep -qix 'cache-control: no-cache' "$tmp/edge.h" || miss "3f / (200): $(grep -i '^cache-control:' "$tmp/edge.h" || echo 'no Cache-Control'), not no-cache"
edge 200 /healthz
edge 404 /nope.txt # @missing_file, not the app
edge 405 / -X POST
grep -qix 'allow: GET, HEAD' "$tmp/edge.h" || miss "3f POST / (405): $(grep -i '^allow:' "$tmp/edge.h" || echo 'no Allow'), not GET, HEAD"
# GET with a body (a POST is the 405). The 413 is Caddy's, through handle_errors; the second is /healthz,
# the other route that imports to_api.
edge 413 /api/v1/seasons -X GET -H 'Expect:' --data-binary @"$tmp/2k"
edge 413 /healthz -X GET -H 'Expect:' --data-binary @"$tmp/2k"
edge 404 /.git/config
edge 404 /assets/nope.js
if grep -qiE '^cache-control:.*immutable' "$tmp/edge.h"; then miss "3f /assets/nope.js (404): $(grep -i '^cache-control:' "$tmp/edge.h")"; fi
# No extension: it reaches @assets_miss (/assets/nope.js is also answered by @missing_file).
edge 404 /assets/nope
if grep -qiE '^cache-control:.*immutable' "$tmp/edge.h"; then miss "3f /assets/nope (404): $(grep -i '^cache-control:' "$tmp/edge.h")"; fi
# The api answers any /api/* without an Access JWT with 401, so this 404 is Caddy's own.
edge 404 /api/x
# Pins the !{path}.contains('/.') clause: curl keeps the dot segment.
edge 404 /api/v1/./seasons --path-as-is
# A method other than GET or HEAD never reaches the api.
edge 405 /api/v1/seasons -X OPTIONS
# Caddy never builds a 401: this is the api, through the proxy.
edge 401 /api/v1/seasons
if ((${#missed[@]} == n)); then
  printf -v seen '%s; ' "${edge_seen[@]}"
  proof "127.0.0.1:8180, ${#edge_seen[@]} requests, each with the 8 site headers exactly once and no Server or Via: ${seen%; }; GET / Cache-Control no-cache, the 405 Allow GET, HEAD, the asset miss without immutable"
fi

# ------------------------------------------------------------------ 3g
step "3g. The firewall, with table inet f1 and without it: no private range, no host, no egress from f1-publish"
n=${#missed[@]}
# A /30 in each private range that from_f1 drops (127/8 cannot be routed off the host) and in TEST-NET-3,
# the public stand-in: <p>.1 on the host's e2e-fw0, <p>.2 in the netns. Not f1-*: no f1 rule names them.
readonly FW_PRIVATE=(10.255.62 172.31.62 192.168.62 100.127.62 169.254.62) FW_PUBLIC=203.0.113
must mkdir -p "$tmp/www"
must ip netns add e2e-fw
must ip link add e2e-fw0 type veth peer name e2e-fw1 netns e2e-fw
for p in "${FW_PRIVATE[@]}" "$FW_PUBLIC"; do
  must ip addr add "$p.1/30" dev e2e-fw0
  must ip -n e2e-fw addr add "$p.2/30" dev e2e-fw1
done
must ip link set e2e-fw0 up
must ip -n e2e-fw link set e2e-fw1 up
must ip -n e2e-fw link set lo up
must ip -n e2e-fw route add default via "$FW_PUBLIC.1"
# bridge_ip <bridge>: the bridge's IPv4 address, its containers' gateway. Not docker network inspect:
# Docker 28 leaves IPAM's Gateway empty for a network that compose gives only a subnet.
bridge_ip() { ip -o -4 addr show dev "$1" | awk '{ split($4, a, "/"); print a[1] }'; }
gw_egress=$(bridge_ip f1-egress) gw_publish=$(bridge_ip f1-publish)
# Safety (invariant 4): every target is the netns behind e2e-fw0 or an address of an f1 bridge on this host.
for p in "${FW_PRIVATE[@]}" "$FW_PUBLIC"; do
  route=$(ip -o route get "$p.2") || fail "3g: no route to $p.2"
  [[ $route == "$p.2 dev e2e-fw0 "* ]] || fail "3g: $p.2 does not go to e2e-fw0: $route"
done
[[ $gw_egress =~ ^10\.62\.3\.[0-9]+$ && $gw_publish =~ ^10\.62\.7\.[0-9]+$ ]] ||
  fail "3g: the bridges' addresses are '$gw_egress' (f1-egress) and '$gw_publish' (f1-publish), not one each in 10.62.3.0/24 and 10.62.7.0/24"
for gw in "$gw_egress" "$gw_publish"; do
  [[ $(ip -o route get "$gw") == "local $gw dev lo "* ]] || fail "3g: $gw is not local: $(ip -o route get "$gw")"
done
# The test addresses join the DNS accept (resolvers4): one public, one private (DNS comes before the private
# drop). Never the real resolver. The restart below empties the set again.
fw_dns_priv=${FW_PRIVATE[0]}.2
must nft add element inet f1 resolvers4 "{ $FW_PUBLIC.2, $fw_dns_priv }"
# fw_serve <addr> <port> <log>: a static file server, one process per (addr, port). Not http.server: its
# HTTPServer.server_bind calls socket.getfqdn, a PTR lookup of the bridge gateways.
readonly FW_SERVE='import functools, http.server, socketserver, sys
socketserver.TCPServer.allow_reuse_address = True
a, p, d = sys.argv[1], int(sys.argv[2]), sys.argv[3]
socketserver.TCPServer((a, p), functools.partial(http.server.SimpleHTTPRequestHandler, directory=d)).serve_forever()'
ip netns exec e2e-fw python3 -I -c "$FW_SERVE" 0.0.0.0 443 "$tmp/www" >"$tmp/fw-ns-443.log" 2>&1 &
fw_pids+=("$!")
ip netns exec e2e-fw python3 -I -c "$FW_SERVE" 0.0.0.0 53 "$tmp/www" >"$tmp/fw-ns-53.log" 2>&1 &
fw_pids+=("$!")
for gw in "$gw_egress" "$gw_publish"; do
  python3 -I -c "$FW_SERVE" "$gw" 18080 "$tmp/www" >"$tmp/fw-$gw.log" 2>&1 &
  fw_pids+=("$!")
done
fw_targets=("${FW_PRIVATE[@]/%/.2:443}" "$FW_PUBLIC.2:443" "$FW_PUBLIC.2:53" "$fw_dns_priv:53" "$gw_egress:18080" "$gw_publish:18080")
# The host's own output is not filtered (the table has no output hook): every listener answers it.
for t in "${fw_targets[@]}"; do
  for i in $(seq 10); do
    curl -fsS --max-time 2 -o /dev/null "http://$t/" 2>/dev/null && break
    ((i < 10)) || fail "3g: http://$t/ does not answer the host"
    sleep 1
  done
done
# One node process connects to every target at once: open, dropped (no answer in 3 s) or the error code.
readonly FW_PROBE="const net = require('node:net');
for (const t of process.argv.slice(1)) {
  const i = t.lastIndexOf(':');
  const s = net.connect({ host: t.slice(0, i), port: Number(t.slice(i + 1)), timeout: 3000 });
  s.on('connect', () => { console.log(t, 'open'); s.destroy(); });
  s.on('timeout', () => { console.log(t, 'dropped'); s.destroy(); });
  s.on('error', (e) => console.log(t, e.code));
}"
fw_seen=()
# fw_expect <container> <want> <target…>: the probe in <container>'s network namespace, so its packets
# leave on that container's own bridges; a miss for each target that is not <want>.
fw_expect() {
  local c=$1 want=$2 out t
  shift 2
  out=$(docker run --rm --pull never --read-only --cap-drop ALL --security-opt no-new-privileges \
    --network "container:$c" --entrypoint /nodejs/bin/node f1-server:ci \
    -e "$FW_PROBE" "$@" 2>"$tmp/fw-probe.err") || miss "3g $c ($fw_state): the probe failed: $(cat "$tmp/fw-probe.err")"
  printf '%s\n' "$out" | sed "s/^/$c ($fw_state)| /"
  for t in "$@"; do
    fw_seen+=("$fw_state: ${c%-1} -> $t $want")
    grep -qxF "$t $want" <<<"$out" || miss "3g $c ($fw_state): $t is not $want: '$(grep -F "$t " <<<"$out" || echo 'no result')'"
  done
}
live_open=("$FW_PUBLIC.2:443" "$FW_PUBLIC.2:53" "$fw_dns_priv:53")
fw_state='table loaded'
# live: the drops, then the positive controls: 443 to the public stand-in, and the DNS accept, which
# f1-egress allows for the resolvers only and which comes before the private drop.
fw_expect f1-live-1 dropped "${FW_PRIVATE[@]/%/.2:443}" "$gw_egress:18080"
fw_expect f1-live-1 open "${live_open[@]}"
fw_expect f1-caddy-1 dropped "$FW_PUBLIC.2:443" "$FW_PUBLIC.2:53" "$gw_publish:18080"
fw_expect f1-api-1 dropped "$FW_PUBLIC.2:443" # not in cf4
must nft delete table inet f1
fw_state='no table'
fw_expect f1-live-1 open "${FW_PRIVATE[@]/%/.2:443}" "$gw_egress:18080" "${live_open[@]}"
fw_expect f1-caddy-1 open "$FW_PUBLIC.2:443" "$FW_PUBLIC.2:53" "$gw_publish:18080"
fw_expect f1-api-1 open "$FW_PUBLIC.2:443"
must systemctl restart f1-firewall.service
nft list table inet f1 >/dev/null || fail "3g: f1-firewall.service did not load table inet f1 again"
# The restart resets the set and f1-resolvers refills it with the real resolver.
if nft list set inet f1 resolvers4 | grep -qwF "$FW_PUBLIC.2"; then miss "3g: resolvers4 still holds $FW_PUBLIC.2 after the restart"; fi
kill "${fw_pids[@]}" 2>/dev/null || true
wait "${fw_pids[@]}" 2>/dev/null || true
fw_pids=()
must ip netns del e2e-fw
if ((${#missed[@]} == n)); then
  printf -v seen '%s; ' "${fw_seen[@]}"
  proof "the f1 firewall, ${#fw_seen[@]} probes by node (read-only, no capabilities) in live's, caddy's and api's network namespaces, 13 targets per table state (targets behind e2e-fw0 or on the f1-egress and f1-publish bridges, by ip route get; $FW_PUBLIC.2 and $fw_dns_priv in resolvers4): ${seen%; }; f1-firewall.service loaded the table again and resolvers4 no longer held $FW_PUBLIC.2"
fi

# ------------------------------------------------------------------ 3h
step "3h. f1-install recreates a running stack whose compose.yaml changed, and smoke-tests it"
n=${#missed[@]}
printf '%s\n' 'services:' '  caddy:' '    labels: ["f1.e2e=stale"]' >"$tmp/label.yaml"
run "$tmp/label" docker compose -p f1 -f /etc/f1/compose.yaml -f "$F1_COMPOSE_OVERRIDE" -f "$tmp/label.yaml" \
  --env-file "$STATE/current.env" up -d caddy
((rc == 0)) || fail "3h: compose up -d caddy with the label exited $rc"
caddy_label() { docker inspect -f '{{with index .Config.Labels "f1.e2e"}}{{.}}{{end}}' f1-caddy-1; }
[[ $(caddy_label) == stale ]] || fail "3h: caddy has no label f1.e2e=stale: '$(caddy_label)'"
caddy_id=$(docker inspect -f '{{.Id}}' f1-caddy-1)
printf '# e2e: differs from the checkout\n' >>/etc/f1/compose.yaml
run "$tmp/install-recreate" "$repo/deploy/bin/f1-install"
((rc == 0)) || miss "3h: f1-install with a changed compose.yaml exited $rc"
grep -qx 'changed  the f1 stack recreated with the new compose.yaml' "$tmp/install-recreate" || miss "3h: f1-install did not recreate the stack"
grep -q 'smoke test passed' "$tmp/install-recreate" || miss "3h: f1-install did not pass its smoke test"
new_id=$(docker inspect -f '{{.Id}}' f1-caddy-1) || miss "3h: caddy is gone after the recreate"
[[ $new_id != "$caddy_id" ]] || miss "3h: caddy was not recreated (Id ${caddy_id:0:12})"
label=$(caddy_label) || miss "3h: caddy is gone after the recreate (no label to read)"
[[ -z $label ]] || miss "3h: caddy still has the label f1.e2e: '$label'"
run "$tmp/install-again" "$repo/deploy/bin/f1-install"
[[ $(tail -n 1 "$tmp/install-again") == 'f1-install: 0 change(s)' ]] || miss "3h: the next f1-install: '$(tail -n 1 "$tmp/install-again")'"
curl -fsS --max-time 5 -o /dev/null "$URL" || miss "3h: $URL is not 200 after the recreate"
if ((${#missed[@]} == n)); then
  proof "caddy labelled f1.e2e=stale (Id ${caddy_id:0:12}), compose.yaml changed: f1-install exit 0, 'changed  the f1 stack recreated with the new compose.yaml', '$(grep -o 'smoke test passed.*' "$tmp/install-recreate")', caddy now Id ${new_id:0:12} without the label; the next run '$(tail -n 1 "$tmp/install-again")'; $URL 200"
fi
((${#missed[@]} == 0)) || fail "${#missed[@]} edge check(s) failed (steps 1b, 3f, 3g, 3h): see the ::error:: lines above"

# ------------------------------------------------------------------ 4b
step "4b. f1-measure 60s 2 on the running stack: docker restart of live, then SIGTERM"
rm -f "$STATE"/measure-*.tsv
"$BIN/f1-measure" 60s 2 >"$tmp/measure" 2>&1 &
mpid=$!
sleep 8
docker restart f1-live-1 >/dev/null
sleep 4
kill -TERM "$mpid"
rc=0
wait "$mpid" || rc=$?
cat "$tmp/measure"
((rc == 0)) || fail "f1-measure exited $rc after SIGTERM, not 0"
tsvs=("$STATE"/measure-*.tsv)
((${#tsvs[@]} == 1)) && [[ -f ${tsvs[0]} ]] || fail "expected one $STATE/measure-*.tsv, found: ${tsvs[*]}"
tsv=${tsvs[0]}
[[ $(stat -c '%a %u:%g' "$tsv") == '600 0:0' ]] || fail "$tsv is not root 0600: $(stat -c '%a %u:%g' "$tsv")"
for s in db api caddy live; do
  awk -F'\t' -v s="$s" '$2 == "stats" && $3 == s { f = 1 } END { exit !f }' "$tsv" || fail "no stats row for $s in $tsv"
  grep -q "^| $s | " "$tmp/measure" || fail "the f1-measure summary does not list $s"
done
for w in live-recordings db-volume; do
  awk -F'\t' -v w="$w" '$2 == "disk" && $3 == w { f = 1 } END { exit !f }' "$tsv" || fail "no disk row for $w in $tsv"
done
for e in die restart; do
  awk -F'\t' -v e="$e" '$2 == "event" && $3 == "live" && $4 == e { f = 1 } END { exit !f }' "$tsv" ||
    fail "no '$e' event row for live in $tsv"
done
samples=$(awk -F'\t' '$2 == "stats" { n++ } END { print n + 0 }' "$tsv")
proof "f1-measure 60s 2, docker restart f1-live-1 after 8 s, SIGTERM 4 s later: exit 0 with the summary, $samples stats rows with one for each of db, api, caddy and live, disk rows live-recordings and db-volume, a die and a restart event row for live, the TSV root 0600"
rm -f "$tsv"

# ------------------------------------------------------------------ 4c
step "4c. Deploy hold: f1-update defers while live records"
printf '%s\n' 'FROM f1-server:ci' \
  "ENTRYPOINT [\"/nodejs/bin/node\",\"-e\",\"process.exit(process.argv[1]==='migrate'?0:1)\"]" |
  docker build -q -t f1-server:broken - >/dev/null
# live stopped, so that its 30 s tick cannot overwrite the row; step 3 asserted that the row exists.
docker stop f1-live-1 >/dev/null
docker exec f1-db-1 psql -U postgres -d f1 -tAc "UPDATE recorder_status SET state = 'recording', updated_at = now()" >/dev/null
env_sha=$(sha256sum <"$STATE/current.env")
api_id=$(docker inspect -f '{{.Id}}' f1-api-1)
run "$tmp/update-hold" "$BIN/f1-update" --server f1-server:broken
((rc == 0)) || fail "f1-update exited $rc while live was recording, not 0"
grep -q 'deploy deferred' "$tmp/update-hold" || fail "f1-update did not log 'deploy deferred'"
[[ $(sha256sum <"$STATE/current.env") == "$env_sha" ]] || fail "current.env changed during the hold"
[[ $(docker inspect -f '{{.Id}}' f1-api-1) == "$api_id" ]] || fail "the api container was recreated during the hold"
[[ ! -e $STATE/candidate.env ]] || fail "$STATE/candidate.env is left after the hold"
[[ $(cat "$STATE/held-since" 2>&1) =~ ^[0-9]+$ ]] || fail "$STATE/held-since after the hold: $(cat "$STATE/held-since" 2>&1)"
docker exec f1-db-1 psql -U postgres -d f1 -tAc "UPDATE recorder_status SET updated_at = now() - interval '10 minutes'" >/dev/null
proof "live stopped and recorder_status recording and fresh: f1-update --server f1-server:broken exit 0, '$(grep -o 'live is recording.*' "$tmp/update-hold")', current.env and the api container unchanged, no candidate.env, $STATE/held-since written; then the row was made 10 minutes old (live down)"

# ------------------------------------------------------------------ 5
step "5. Rollback: f1-update --server f1-server:broken"
cp "$STATE/current.env" "$tmp/current.before"
# 60: the rollback's smoke test waits for the new api container's first healthcheck (interval 30 s).
run "$tmp/update2" env F1_SMOKE_TIMEOUT=60 "$BIN/f1-update" --server f1-server:broken
broken_rc=$rc
((broken_rc != 0)) || fail "f1-update with the broken image exited 0"
grep -q 'rolled back' "$tmp/update2" || fail "f1-update did not log 'rolled back'"
cmp -s "$tmp/current.before" "$STATE/current.env" || fail "current.env changed"
[[ $(cat "$STATE/failed.env" 2>&1) == $'F1_SERVER_IMAGE=f1-server:broken\nF1_WEB_IMAGE=f1-web:ci' ]] ||
  fail "failed.env: $(cat "$STATE/failed.env" 2>&1)"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200 after the rollback"
run "$tmp/update3" "$BIN/f1-update" --server f1-server:broken
if ((rc != 0)) || ! grep -q 'skipping known-bad' "$tmp/update3"; then fail "the known-bad pair was not skipped (exit $rc)"; fi
# D1: a drill's known-bad skip sends no alert.
grep -q 'f1-alert:' "$tmp/update3" && fail "the drill's known-bad skip ran f1-alert"
[[ ! -e $STATE/alert-known_bad ]] || fail "the drill's known-bad skip left $STATE/alert-known_bad"
rm -f "$STATE/failed.env"
proof "f1-update --server f1-server:broken: exit $broken_rc, '$(grep -o 'rolled back.*' "$tmp/update2" | head -n 1)', current.env unchanged, failed.env = the broken pair, $URL 200 again; run again: exit 0, '$(grep -o 'skipping known-bad.*' "$tmp/update3")', no f1-alert line and no alert-known_bad (a drill); the row of 4c, 10 minutes old, did not hold this deploy"

# ------------------------------------------------------------------ 5a
step "5a. The 14 h cap: a hold that began 15 h ago does not hold the deploy"
docker stop f1-live-1 >/dev/null
docker exec f1-db-1 psql -U postgres -d f1 -tAc "UPDATE recorder_status SET state = 'recording', updated_at = now()" >/dev/null
printf '%s\n' "$(($(date +%s) - 15 * 3600))" >"$STATE/held-since" # its mtime is now: an unbroken chain
run "$tmp/update-cap" env F1_SMOKE_TIMEOUT=60 "$BIN/f1-update" --server f1-server:broken
cap_rc=$rc
((cap_rc == 1)) || fail "f1-update exited $cap_rc after the cap, not 1"
grep -q 'error: deploys held for over 14 h' "$tmp/update-cap" || fail "f1-update did not log the 14 h error"
grep -q 'rolled back' "$tmp/update-cap" || fail "f1-update did not roll back after the cap"
cmp -s "$tmp/current.before" "$STATE/current.env" || fail "current.env changed"
[[ $(cat "$STATE/failed.env" 2>&1) == $'F1_SERVER_IMAGE=f1-server:broken\nF1_WEB_IMAGE=f1-web:ci' ]] ||
  fail "failed.env: $(cat "$STATE/failed.env" 2>&1)"
[[ ! -e $STATE/held-since ]] || fail "$STATE/held-since is left after the deploy started"
grep -q 'f1-alert:' "$tmp/update-cap" && fail "the drill's 14 h cap ran f1-alert"
[[ ! -e $STATE/alert-hold_14h ]] || fail "the drill's 14 h cap left $STATE/alert-hold_14h"
rm -f "$STATE/failed.env"
proof "live stopped, recorder_status recording and fresh, held-since 15 h old: f1-update --server f1-server:broken exit $cap_rc, '$(grep -o 'error: deploys held for over 14 h.*' "$tmp/update-cap")', no f1-alert line and no alert-hold_14h (a drill), then the deploy ran and '$(grep -o 'rolled back.*' "$tmp/update-cap" | head -n 1)', current.env unchanged, held-since removed"

# ------------------------------------------------------------------ 5b
step "5b. live runs again after the rollback and writes idle (it ticks every 30 s)"
live_state=''
for _ in $(seq 40); do
  live_state=$(docker exec f1-db-1 psql -U postgres -d f1 -tAc "SELECT state FROM recorder_status" 2>/dev/null || true)
  [[ $live_state == idle && $(docker inspect -f '{{.State.Health.Status}}' f1-live-1 2>/dev/null || true) == healthy ]] && break
  sleep 3
done
[[ $(docker inspect -f '{{.State.Running}}' f1-live-1) == true ]] || fail "f1-live-1 is not running after the rollback"
[[ $(docker inspect -f '{{.State.Health.Status}}' f1-live-1) == healthy ]] || fail "f1-live-1 is not healthy after the rollback"
[[ $live_state == idle ]] || fail "recorder_status.state is '$live_state' within 120 s of the rollback, not 'idle'"
proof "after the rollback f1-live-1 is running and healthy, and recorder_status is idle again (the row 4c made 'recording' was overwritten by live)"

# ------------------------------------------------------------------ 6
step "6. docker inspect: the hardening flags of db, api, caddy and live, and the only publish"
for s in db api caddy live; do
  got=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}' "f1-$s-1")
  [[ $got == 'true [ALL] 62532:62532' ]] || fail "f1-$s-1: $got"
  [[ $(docker inspect -f '{{.HostConfig.SecurityOpt}}' "f1-$s-1") == *no-new-privileges:true* ]] || fail "f1-$s-1 lacks no-new-privileges"
  core=$(docker inspect -f '{{json .HostConfig.Ulimits}}' "f1-$s-1")
  [[ $core == *'"Name":"core","Hard":0,"Soft":0'* ]] || fail "f1-$s-1 does not limit core dumps to 0: $core"
done
mapfile -t ids < <(docker ps -q --filter label=com.docker.compose.project=f1)
ports=$(docker inspect -f '{{.Name}} {{json .HostConfig.PortBindings}}' "${ids[@]}" | grep -vE ' (\{\}|null)$' || true)
[[ $ports == '/f1-caddy-1 {"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8180"}]}' ]] || fail "published ports: $ports"
proof "db, api, caddy and live: ReadonlyRootfs true, CapDrop [ALL], User 62532:62532, no-new-privileges:true, core size 0; the only port binding: $ports"

# ------------------------------------------------------------------ 7
step "7. f1-tick restores a deleted table inet f1, runs the recorder watch, writes the disk file"
nft delete table inet f1
run "$tmp/tick" "$BIN/f1-tick"
((rc == 0)) || fail "f1-tick exited $rc"
nft list table inet f1 >/dev/null || fail "f1-tick did not restore table inet f1"
# The watch ran: recorder-watch.sql passed on the real migrated schema in f1-db-1.
grep -q 'cannot run the recorder watch' "$tmp/tick" && fail "f1-tick could not run the recorder watch"
[[ $(cat "$STATE/disk") =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z\ [0-9]{1,18}\ [0-9]{1,18}$ ]] || fail "disk: $(cat "$STATE/disk")"
grep -q 'free disk: /srv/f1 [0-9]* GiB, Docker data root /[^ ]* [0-9]* GiB' "$tmp/tick" || fail "f1-tick did not log the free disk space"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200 after the reload"
proof "f1-tick reloaded the deleted table inet f1, ran the recorder watch (no 'cannot run the recorder watch') and wrote $STATE/disk ($(cat "$STATE/disk")), '$(grep -o 'free disk: .*' "$tmp/tick")'; $URL still 200"

# ------------------------------------------------------------------ 8
step "8. A local tag with a registry host is pulled and recorded by digest, never as given"
docker tag f1-server:ci localhost/f1-server:ci
run "$tmp/update-host" "$BIN/f1-update" --server localhost/f1-server:ci
((rc == 1)) || fail "f1-update --server localhost/f1-server:ci exited $rc, not 1"
grep -q 'cannot resolve the images' "$tmp/update-host" || fail "f1-update did not log 'cannot resolve the images'"
cmp -s "$tmp/current.before" "$STATE/current.env" || fail "current.env changed"
proof "f1-update --server localhost/f1-server:ci (a local tag, no registry): exit 1, '$(grep -o 'cannot resolve the images.*' "$tmp/update-host")', current.env unchanged"

# ------------------------------------------------------------------ 9
step "9. f1-tick skips the container restarts while the update lock is held"
exec 8>/run/f1/update.lock
flock -n 8 || fail "cannot take /run/f1/update.lock"
run "$tmp/tick-busy" "$BIN/f1-tick"
exec 8>&-
((rc == 0)) || fail "f1-tick exited $rc while the lock was held"
grep -q 'no container restarts this round' "$tmp/tick-busy" || fail "f1-tick did not skip the restarts"
grep -q 'free disk: /srv/f1' "$tmp/tick-busy" || fail "f1-tick skipped the disk record"
grep -q 'cannot run the recorder watch' "$tmp/tick-busy" && fail "f1-tick could not run the recorder watch"
proof "f1-tick with /run/f1/update.lock held: exit 0, '$(grep -o 'f1-update or f1-install is running.*' "$tmp/tick-busy")', the recorder watch ran and the disk was still recorded"

# ------------------------------------------------------------------ 10
step "10. Fail closed: no f1 container runs, and no deploy starts, without table inet f1"
mv /etc/f1/nftables-f1.conf "$tmp/nftables-f1.conf"
nft delete table inet f1
run "$tmp/tick-closed" "$BIN/f1-tick"
((rc == 1)) || fail "f1-tick exited $rc without its firewall, not 1"
grep -q 'the f1 stack is stopped until the firewall loads' "$tmp/tick-closed" || fail "f1-tick did not log the stop"
[[ -z $(docker ps -q --filter label=com.docker.compose.project=f1) ]] || fail "f1 containers run without table inet f1"
run "$tmp/update-closed" "$BIN/f1-update" --server f1-server:ci --web f1-web:ci
((rc == 1)) || fail "f1-update exited $rc without table inet f1, not 1"
grep -q 'no deploy without the f1 firewall' "$tmp/update-closed" || fail "f1-update did not refuse the deploy"
[[ -z $(docker ps -q --filter label=com.docker.compose.project=f1) ]] || fail "f1-update started containers without table inet f1"
mv "$tmp/nftables-f1.conf" /etc/f1/nftables-f1.conf
run "$tmp/tick-open" "$BIN/f1-tick"
((rc == 0)) || fail "f1-tick exited $rc with the conf back"
nft list table inet f1 >/dev/null || fail "f1-tick did not reload table inet f1"
grep -q 'table inet f1 is loaded again: starting the f1 stack' "$tmp/tick-open" || fail "f1-tick did not start the stack"
for _ in $(seq 30); do
  curl -fsS --max-time 5 -o /dev/null "$URL" 2>/dev/null && break
  sleep 3
done
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200 after the stack started again"
[[ ! -e $STATE/firewall-stopped ]] || fail "$STATE/firewall-stopped is left"
proof "table deleted and conf moved away: f1-tick exit 1, '$(grep -o 'error: loading.*' "$tmp/tick-closed")', no f1 container runs; f1-update exit 1, '$(grep -o 'table inet f1 is not loaded.*' "$tmp/update-closed")'; conf back: f1-tick exit 0, table reloaded, '$(grep -o 'table inet f1 is loaded again.*' "$tmp/tick-open")', $URL 200"

# ------------------------------------------------------------------ 11
step "11. The restart loop: 3 rounds of restarts in a row alert restart_loop once; gone, the alert clears"
# f1-web:ci (busybox) for the health command's /bin/sh; --stop-timeout 1, as sleep ignores SIGTERM.
docker run -d --name f1-e2e-sick-1 --label com.docker.compose.project=f1 --network none --stop-timeout 1 \
  --health-cmd false --health-interval 1s --health-retries 1 --entrypoint sleep f1-web:ci 3600 >/dev/null
for round in 1 2 3 4; do
  # A restart resets the health to starting, which f1-tick does not restart: wait for unhealthy.
  for _ in $(seq 30); do
    [[ $(docker inspect -f '{{.State.Health.Status}}' f1-e2e-sick-1) == unhealthy ]] && break
    sleep 1
  done
  [[ $(docker inspect -f '{{.State.Health.Status}}' f1-e2e-sick-1) == unhealthy ]] || fail "f1-e2e-sick-1 is not unhealthy before round $round"
  run "$tmp/tick-sick$round" "$BIN/f1-tick"
  ((rc == 0)) || fail "f1-tick exited $rc in round $round"
  grep -q 'restarting unhealthy container f1-e2e-sick-1' "$tmp/tick-sick$round" || fail "round $round did not restart f1-e2e-sick-1"
done
for round in 1 2 4; do
  if grep -q 'restart_loop' "$tmp/tick-sick$round"; then fail "round $round alerted restart_loop"; fi
done
grep -q 'f1-alert: alert_key_invalid restart_loop f1-e2e-sick-1$' "$tmp/tick-sick3" || fail "round 3 did not alert restart_loop f1-e2e-sick-1"
[[ $(cat "$STATE/restarts") == 'f1-e2e-sick-1 4' ]] || fail "restarts after round 4: $(cat "$STATE/restarts")"
[[ $(cat "$STATE/alert-restart_loop") == f1-e2e-sick-1 ]] || fail "alert-restart_loop: $(cat "$STATE/alert-restart_loop" 2>&1)"
docker rm -f f1-e2e-sick-1 >/dev/null
run "$tmp/tick-healed" "$BIN/f1-tick"
((rc == 0)) || fail "f1-tick exited $rc after f1-e2e-sick-1 was removed"
[[ ! -e $STATE/alert-restart_loop ]] || fail "$STATE/alert-restart_loop is left after the loop ended"
[[ ! -s $STATE/restarts ]] || fail "restarts after the loop ended: $(cat "$STATE/restarts")"
proof "f1-e2e-sick-1 (always unhealthy) restarted by 4 ticks in a row: only the third alerted, '$(grep -o 'alert_key_invalid restart_loop.*' "$tmp/tick-sick3")', restarts then 'f1-e2e-sick-1 4'; removed, the next tick cleared alert-restart_loop and emptied restarts"

# ------------------------------------------------------------------ 11a
step "11a. The recorder watch through f1-tick: a due session alerts its three codes once, then clears"
# psql_e2e <sql>: as postgres, the test's own writes (f1-tick reads as f1_api).
psql_e2e() { docker exec f1-db-1 psql -U postgres -d f1 -v ON_ERROR_STOP=1 -tAc "$1" >/dev/null; }
# Invariant 4: live stops before the session exists (SIGTERM writes idle), and starts only once it is gone.
watch_rows=1
docker stop f1-live-1 >/dev/null
[[ $(docker inspect -f '{{.State.Running}}' f1-live-1) == false ]] || fail "f1-live-1 still runs"
psql_e2e "INSERT INTO meeting (meeting_key, source, year) VALUES ($WATCH_KEY, 'openf1', 2026);
  INSERT INTO session (session_key, source, meeting_key, date_start, date_end)
    VALUES ($WATCH_KEY, 'openf1', $WATCH_KEY, now() + interval '30 minutes', now() + interval '90 minutes');
  UPDATE recorder_status SET updated_at = now() - interval '10 minutes', warning = 'login_failed'"
for round in 1 2 3; do
  if ((round == 3)); then
    psql_e2e "INSERT INTO recording (session_key, path, started_at) VALUES ($WATCH_KEY, '$WATCH_KEY-$(date +%s%3N)', now());
      UPDATE recorder_status SET updated_at = now(), warning = NULL"
  fi
  run "$tmp/tick-watch$round" "$BIN/f1-tick"
  ((rc == 0)) || fail "f1-tick exited $rc in watch round $round"
  grep -q 'cannot run the recorder watch' "$tmp/tick-watch$round" && fail "f1-tick could not run the recorder watch in round $round"
  for code in recorder_missing recorder_stale login_failed; do
    n=$(grep -c "f1-alert: alert_key_invalid $code $WATCH_KEY\$" "$tmp/tick-watch$round") || true
    if ((round == 1)); then
      ((n == 1)) || fail "watch round 1 logged alert_key_invalid $code $WATCH_KEY $n times, not once"
      [[ $(cat "$STATE/alert-$code" 2>&1) == "$WATCH_KEY" ]] || fail "alert-$code after round 1: $(cat "$STATE/alert-$code" 2>&1)"
    else
      grep -q "f1-alert: [a-z_]* $code " "$tmp/tick-watch$round" && fail "watch round $round alerted $code again"
    fi
    if ((round == 3)); then [[ ! -e $STATE/alert-$code ]] || fail "$STATE/alert-$code is left after round 3"; fi
  done
done
# ON DELETE RESTRICT: the recording before its session.
psql_e2e "DELETE FROM recording WHERE session_key = $WATCH_KEY; DELETE FROM session WHERE session_key = $WATCH_KEY;
  DELETE FROM meeting WHERE meeting_key = $WATCH_KEY"
[[ $(docker exec f1-db-1 psql -U postgres -d f1 -tAc "SELECT count(*) FROM session") == 0 ]] || fail "step 11a left a session"
watch_rows=0
docker start f1-live-1 >/dev/null
live_state=''
for _ in $(seq 40); do
  live_state=$(docker exec f1-db-1 psql -U postgres -d f1 -tAc "SELECT state FROM recorder_status" 2>/dev/null || true)
  [[ $live_state == idle && $(docker inspect -f '{{.State.Health.Status}}' f1-live-1 2>/dev/null || true) == healthy ]] && break
  sleep 3
done
[[ $(docker inspect -f '{{.State.Health.Status}}' f1-live-1) == healthy ]] || fail "f1-live-1 is not healthy after step 11a"
[[ $live_state == idle ]] || fail "recorder_status.state is '$live_state' after step 11a, not 'idle'"
proof "live stopped, a synthetic session $WATCH_KEY starting in 30 min, recorder_status 10 min old with login_failed: tick 1 logged '$(grep -o "alert_key_invalid recorder_missing $WATCH_KEY" "$tmp/tick-watch1")', '$(grep -o "alert_key_invalid recorder_stale $WATCH_KEY" "$tmp/tick-watch1")' and '$(grep -o "alert_key_invalid login_failed $WATCH_KEY" "$tmp/tick-watch1")' once each and wrote alert-recorder_missing, alert-recorder_stale and alert-login_failed ($WATCH_KEY); tick 2 none (dedupe); with a recording and a fresh status, tick 3 cleared all three; the rows deleted, f1-live-1 healthy and idle again"

# ------------------------------------------------------------------ 12
step "12. OnFailure: a failed f1-update.service alerts through the sandboxed f1-alert@; one request, to loopback"
# journal_has <unit> <text>: the unit's journal shows the text within 30 s (OnFailure is asynchronous).
journal_has() {
  local _ out
  for _ in $(seq 30); do
    out=$(journalctl -u "$1" --no-pager -o cat 2>/dev/null) || true
    [[ $out == *"$2"* ]] && return 0
    sleep 1
  done
  return 1
}
: >/etc/f1/secrets/hc_ping_key # keeps root:62006 0440; f1-update also says "not configured" with it
mkdir -p "${DROPIN%/*}"
printf '[Service]\nEnvironment=F1_SMOKE_TIMEOUT=bad\n' >"$DROPIN"
systemctl daemon-reload
[[ $(systemctl show -p Environment --value f1-update.service) == *F1_SMOKE_TIMEOUT=bad* ]] || fail "the drop-in did not take"
# f1-update exits 64 on the bad timeout, before its lock, readiness or any pull.
systemctl start f1-update.service && fail "f1-update.service did not fail with F1_SMOKE_TIMEOUT=bad"
journal_has f1-alert@f1-update.service.service 'alert_no_key unit_failed f1-update.service' ||
  fail "f1-alert@f1-update.service.service did not log alert_no_key unit_failed f1-update.service"
rm -f -- "$DROPIN"
systemctl daemon-reload
systemctl reset-failed f1-update.service
printf 'ci.dummy.not.a.ping.key\n' >/etc/f1/secrets/hc_ping_key
systemctl start f1-alert@e2e.service || fail "f1-alert@e2e.service failed"
journal_has f1-alert@e2e.service 'alert_key_invalid unit_failed e2e' || fail "f1-alert@e2e.service did not log alert_key_invalid unit_failed e2e"
# The one request of this run: a well-formed fake key, to hc-ping.com pinned on 127.0.0.1 (refused).
hc_ip=$(getent ahosts hc-ping.com | awk '{print $1}' | sort -u) || true
[[ $hc_ip == 127.0.0.1 ]] || fail "hc-ping.com resolves to '$hc_ip', not 127.0.0.1 only"
printf 'ci-fake-ping-key-00000\n' >/etc/f1/secrets/hc_ping_key
run "$tmp/alert-loopback" "$BIN/f1-alert" test_alert
((rc == 1)) || fail "f1-alert test_alert exited $rc on loopback, not 1"
grep -q 'f1-alert: alert_failed test_alert (curl 7, http 000)$' "$tmp/alert-loopback" || fail "f1-alert did not log curl 7 on loopback"
mv -- /etc/f1/secrets/hc_ping_key "$KEY_AWAY"
run "$tmp/alert-nokey" "$BIN/f1-alert" test_alert
((rc == 0)) || fail "f1-alert test_alert exited $rc without a key file, not 0"
grep -q 'f1-alert: alert_no_key test_alert$' "$tmp/alert-nokey" || fail "f1-alert did not log alert_no_key without a key file"
mv -- "$KEY_AWAY" /etc/f1/secrets/hc_ping_key
printf 'ci.dummy.not.a.ping.key\n' >/etc/f1/secrets/hc_ping_key
[[ $(stat -c '%a %u %g' /etc/f1/secrets/hc_ping_key) == '440 0 62006' ]] || fail "hc_ping_key lost root:62006 0440"
proof "F1_SMOKE_TIMEOUT=bad (runtime drop-in): f1-update.service failed and its OnFailure logged '$(journalctl -u f1-alert@f1-update.service.service --no-pager -o cat | grep -o 'alert_no_key.*' | head -n 1)'; the sandboxed f1-alert@e2e.service read the malformed key: '$(journalctl -u f1-alert@e2e.service --no-pager -o cat | grep -o 'alert_key_invalid.*' | head -n 1)'; a 22-character fake key: exit 1, '$(grep -o 'alert_failed.*' "$tmp/alert-loopback")' (hc-ping.com -> $hc_ip); the key file moved away: exit 0, '$(grep -o 'alert_no_key.*' "$tmp/alert-nokey")'; hc_ping_key root:62006 0440 again"

# ------------------------------------------------------------------ invariant 4
journalctl -u 'f1-alert@*' --no-pager -o cat >"$tmp/journal-alert" 2>&1 || true
grep -rq 'alert_sent' "$tmp" && fail "an alert was sent: $(grep -rh 'alert_sent' "$tmp")"
alert_failed=$(grep -rho 'alert_failed.*' "$tmp" | sort -u) || true
[[ $alert_failed == 'alert_failed test_alert (curl 7, http 000)' ]] || fail "alert_failed lines other than step 12's: $alert_failed"
not_sent=$(grep -rhoE 'alert_(key_invalid|no_key) [a-z_]+' "$tmp" | sort | uniq -c |
  awk '{ printf "%s%s %s x%s", sep, $2, $3, $1; sep = ", " }') || true
[[ -n $not_sent ]] || fail "no alert_key_invalid or alert_no_key line: the alert checks prove nothing"
for t in f1-update.timer f1-tick.timer; do
  if systemctl is-enabled --quiet "$t" 2>/dev/null; then fail "$t is enabled"; fi
done
for s in ingest cloudflared; do
  [[ -z $(docker ps -aq --filter label=com.docker.compose.project=f1 --filter "label=com.docker.compose.service=$s") ]] ||
    fail "a $s container exists"
done
sessions=$(docker exec f1-db-1 psql -U postgres -d f1 -tAc "SELECT count(*) FROM session")
[[ $sessions == 0 ]] || fail "the session table has $sessions rows: live was not idle"
proof "no f1 timer is enabled; ingest and cloudflared never ran (no container of them exists); the session table is empty (step 11a's session existed only while live was stopped), so live never had a session to log in for; no alert_sent in the logs or the f1-alert@ journal, the only alert_failed is step 12's loopback one, and the alerts not sent: $not_sent"
