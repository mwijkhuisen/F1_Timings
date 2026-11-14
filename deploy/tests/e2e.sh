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
# and nft, curl, flock, getent, journalctl and systemd-analyze.
#   1. f1-install twice: the second run makes 0 changes; systemd-analyze verify on the units (the
#      template f1-alert@.service too); f1-update.service and f1-tick.service have OnFailure=
#      f1-alert@<unit>.service; /srv/f1/live, /srv/f1/archive and /srv/f1/state/live are 62532:62532 0700,
#      /srv/f1/jolpica is root:62532 0750 and /srv/f1/state stays root 0700.
#   2. Dummy cf_tunnel_token, hc_ping_key (malformed on purpose), f1tv_username and f1tv_password
#      (f1-update says "not configured" while one is empty), and f1.env with CF_ACCESS_TEAM=ci and a
#      64-hex AUD; 127.0.0.1 hc-ping.com in /etc/hosts, and getent resolves it to 127.0.0.1 only.
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
#  3f. The logs (#108): requests with a JWT-shaped Cf-Access-Jwt-Assertion (refused before any certs
#      fetch) and a marked query leave neither, nor the path, in caddy's or the api's log; the api
#      logs the 401's request line with its route pattern.
#  3g. The playback stream through the real Caddyfile (#40): deploy/tests/sse-check.sh (a stub api in
#      f1-server:ci, f1-web:ci on a throw-away network): uncompressed and on cadence, the control route
#      compressed; three negative cases fail.
#   4. Egress from api to a non-Cloudflare host is blocked.
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

# ------------------------------------------------------------------ 2
step "2. Dummy secrets (live reads the F1 TV ones only for a login, and none is due here), f1.env, the hc-ping.com pin"
printf 'ci-dummy-tunnel-token\n' >/etc/f1/secrets/cf_tunnel_token
# Invariant 4, belt and braces: a ping key that fails healthchecks.ts's and f1-alert's 22-character
# check, so no alert and no ping of live sends a request; and hc-ping.com on loopback only.
printf 'ci.dummy.not.a.ping.key\n' >/etc/f1/secrets/hc_ping_key
cp /etc/hosts "$tmp/hosts"
printf '127.0.0.1 hc-ping.com\n' >>/etc/hosts
hc_ip=$(getent ahosts hc-ping.com | awk '{print $1}' | sort -u) || true
[[ $hc_ip == 127.0.0.1 ]] || fail "hc-ping.com resolves to '$hc_ip', not 127.0.0.1 only"
printf 'ci-dummy-f1tv-user\n' >/etc/f1/secrets/f1tv_username
printf 'ci-dummy-f1tv-pass\n' >/etc/f1/secrets/f1tv_password
printf 'CF_ACCESS_TEAM=ci\nCF_ACCESS_AUD=%064d\n' 0 >/etc/f1/f1.env
[[ $(stat -c '%a %u %g' /etc/f1/secrets/cf_tunnel_token) == '440 0 62005' ]] || fail "cf_tunnel_token lost root:62005 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/hc_ping_key) == '440 0 62006' ]] || fail "hc_ping_key lost root:62006 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/f1tv_username) == '440 0 62007' ]] || fail "f1tv_username lost root:62007 0440"
[[ $(stat -c '%a %u %g' /etc/f1/secrets/f1tv_password) == '440 0 62008' ]] || fail "f1tv_password lost root:62008 0440"
proof "cf_tunnel_token, hc_ping_key (malformed: ci.dummy.not.a.ping.key), f1tv_username and f1tv_password hold dummies (root:<gid> 0440 kept), f1.env has CF_ACCESS_TEAM=ci and a 64-hex AUD; /etc/hosts pins hc-ping.com, getent ahosts: $hc_ip"

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
step "3f. The logs: the api's request line, and no Access JWT, query or path in caddy's or the api's log"
# JWT-shaped, but no RS256 header: the api refuses it before any certs fetch, so nothing leaves the runner.
jwt=eyJe2e108.marker.sig
for path in /api/v1/sessions/1/laps /api/v1/e2e108path /healthz /assets/e2e108path.js; do
  curl -s -o /dev/null --max-time 5 -H "Cf-Access-Jwt-Assertion: $jwt" "http://127.0.0.1:8180$path?q=e2e108query" \
    || fail "curl $path"
done
docker logs f1-caddy-1 >"$tmp/caddy.log" 2>&1
docker logs f1-api-1 >"$tmp/api.log" 2>&1
for s in caddy api; do
  ! grep -qF -e "$jwt" -e e2e108 "$tmp/$s.log" || fail "the $s log holds the request's JWT, query or path"
done
grep -qF '"method":"GET","route":"/api/v1/sessions/:key/laps","status":401' "$tmp/api.log" \
  || fail "the api logged no request line for the 401 on /api/v1/sessions/:key/laps"
proof "4 requests with a JWT-shaped Cf-Access-Jwt-Assertion and ?q=<marker>: neither the JWT nor the marked path or query is in caddy's or the api's log; the api's request line for the 401 names the route /api/v1/sessions/:key/laps"

# ------------------------------------------------------------------ 3g
step "3g. The playback stream passes Caddy uncompressed and unbuffered (#40)"
run "$tmp/sse" bash "$repo/deploy/tests/sse-check.sh"
((rc == 0)) || fail "sse-check exited $rc"
proof "$(tail -n 1 "$tmp/sse")"

# ------------------------------------------------------------------ 4
step "4. Egress from api to a non-Cloudflare host is blocked"
probe="fetch('https://www.google.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
result=$(docker exec f1-api-1 /nodejs/bin/node -e "$probe")
[[ $result == blocked* ]] || fail "api reached https://www.google.com: $result"
proof "api -> https://www.google.com: $result"

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
