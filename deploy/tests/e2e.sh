#!/usr/bin/env bash
# e2e (CI only, as root: ci / deploy, step `e2e`; D13). The only run of the deploy path before the
# box: the real f1-install, f1-update and f1-tick on the runner's Docker, with the f1 table loaded.
# CI never calls OpenF1 or Cloudflare (invariant 4): deploy/tests/ci.override.yaml keeps ingest and
# cloudflared out (profile "off"), and nothing here enables a timer. It needs the images
# f1-server:ci and f1-web:ci (built by the job) and nft, curl, flock and systemd-analyze.
#   1. f1-install twice: the second run makes 0 changes; systemd-analyze verify on the units.
#   2. Dummy cf_tunnel_token and hc_ping_key, and f1.env with CF_ACCESS_TEAM=ci and a 64-hex AUD.
#   3. f1-update --server f1-server:ci --web f1-web:ci: exit 0, current.env, /healthz 200 on
#      127.0.0.1:8180 (caddy, api and db as 62532; the publish through f1-publish; local tags).
#   4. Egress from api to a non-Cloudflare host is blocked.
#   5. f1-update --server f1-server:broken (migrate passes, api exits): exit 1, "rolled back",
#      current.env unchanged, failed.env written, /healthz 200 again; the same pair again is
#      skipped as known-bad.
#   6. docker inspect of db, api and caddy: read-only root, CapDrop ALL, user 62532:62532,
#      no-new-privileges; caddy's 127.0.0.1:8180 is the only published port.
#   7. f1-tick restores a deleted table inet f1 and writes the disk file.
# Usage: sudo bash deploy/tests/e2e.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
export F1_COMPOSE_OVERRIDE=$repo/deploy/tests/ci.override.yaml
readonly STATE=/srv/f1/state URL=http://127.0.0.1:8180/healthz BIN=/usr/local/bin
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
    for s in db api caddy; do docker logs --tail 60 "f1-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    nft list table inet f1 2>&1 | head -n 80 || true
    echo "::endgroup::"
  fi
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
proof "f1-install ran twice, the second: '$(tail -n 1 "$tmp/install2")'; f1-firewall.service active, table inet f1 loaded (resolvers4 $(nft list set inet f1 resolvers4 | grep -o 'elements = {[^}]*}' || echo empty)); systemd-analyze verify passes: $(echo /etc/systemd/system/f1-*)"

# ------------------------------------------------------------------ 2
step "2. Dummy secrets for the services CI never starts, and f1.env"
printf 'ci-dummy-tunnel-token\n' >/etc/f1/secrets/cf_tunnel_token
printf 'ci-dummy-ping-key-0000\n' >/etc/f1/secrets/hc_ping_key
printf 'CF_ACCESS_TEAM=ci\nCF_ACCESS_AUD=%064d\n' 0 >/etc/f1/f1.env
[[ $(stat -c '%a %u %g' /etc/f1/secrets/cf_tunnel_token) == '440 0 62005' ]] || fail "cf_tunnel_token lost root:62005 0440"
proof "cf_tunnel_token and hc_ping_key hold dummies (root:<gid> 0440 kept), f1.env has CF_ACCESS_TEAM=ci and a 64-hex AUD"

# ------------------------------------------------------------------ 3
step "3. First deploy: f1-update --server f1-server:ci --web f1-web:ci"
run "$tmp/update1" "$BIN/f1-update" --server f1-server:ci --web f1-web:ci
((rc == 0)) || fail "f1-update exited $rc"
grep -q 'deployed server f1-server:ci web f1-web:ci' "$tmp/update1" || fail "f1-update did not log the deploy"
[[ $(cat "$STATE/current.env") == $'F1_SERVER_IMAGE=f1-server:ci\nF1_WEB_IMAGE=f1-web:ci' ]] ||
  fail "current.env: $(cat "$STATE/current.env")"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200"
services=$(docker ps -a --filter label=com.docker.compose.project=f1 --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')
[[ $services == 'api caddy db ' ]] || fail "the f1 containers are '$services', not 'api caddy db'"
proof "f1-update deployed the local tags f1-server:ci and f1-web:ci (exit 0, current.env written); $URL answers 200 through caddy, api and db (db as 62532 on a new f1_pgdata, roles.sql through initdb, migrate as f1_migrator) with table inet f1 loaded; containers: ${services% } (no ingest, no cloudflared)"

# ------------------------------------------------------------------ 4
step "4. Egress from api to a non-Cloudflare host is blocked"
probe="fetch('https://www.google.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('open',r.status),e=>console.log('blocked',e.name))"
result=$(docker exec f1-api-1 /nodejs/bin/node -e "$probe")
[[ $result == blocked* ]] || fail "api reached https://www.google.com: $result"
proof "api -> https://www.google.com: $result"

# ------------------------------------------------------------------ 5
step "5. Rollback: f1-update --server f1-server:broken"
printf '%s\n' 'FROM f1-server:ci' \
  "ENTRYPOINT [\"/nodejs/bin/node\",\"-e\",\"process.exit(process.argv[1]==='migrate'?0:1)\"]" |
  docker build -q -t f1-server:broken - >/dev/null
cp "$STATE/current.env" "$tmp/current.before"
run "$tmp/update2" env F1_SMOKE_TIMEOUT=30 "$BIN/f1-update" --server f1-server:broken
broken_rc=$rc
((broken_rc != 0)) || fail "f1-update with the broken image exited 0"
grep -q 'rolled back' "$tmp/update2" || fail "f1-update did not log 'rolled back'"
cmp -s "$tmp/current.before" "$STATE/current.env" || fail "current.env changed"
[[ $(cat "$STATE/failed.env" 2>&1) == $'F1_SERVER_IMAGE=f1-server:broken\nF1_WEB_IMAGE=f1-web:ci' ]] ||
  fail "failed.env: $(cat "$STATE/failed.env" 2>&1)"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200 after the rollback"
run "$tmp/update3" "$BIN/f1-update" --server f1-server:broken
if ((rc != 0)) || ! grep -q 'skipping known-bad' "$tmp/update3"; then fail "the known-bad pair was not skipped (exit $rc)"; fi
rm -f "$STATE/failed.env"
proof "f1-update --server f1-server:broken: exit $broken_rc, '$(grep -o 'rolled back.*' "$tmp/update2" | head -n 1)', current.env unchanged, failed.env = the broken pair, $URL 200 again; run again: exit 0, '$(grep -o 'skipping known-bad.*' "$tmp/update3")'"

# ------------------------------------------------------------------ 6
step "6. docker inspect: the hardening flags of db, api and caddy, and the only publish"
for s in db api caddy; do
  got=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}' "f1-$s-1")
  [[ $got == 'true [ALL] 62532:62532' ]] || fail "f1-$s-1: $got"
  [[ $(docker inspect -f '{{.HostConfig.SecurityOpt}}' "f1-$s-1") == *no-new-privileges:true* ]] || fail "f1-$s-1 lacks no-new-privileges"
done
mapfile -t ids < <(docker ps -q --filter label=com.docker.compose.project=f1)
ports=$(docker inspect -f '{{.Name}} {{json .HostConfig.PortBindings}}' "${ids[@]}" | grep -vE ' (\{\}|null)$' || true)
[[ $ports == '/f1-caddy-1 {"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8180"}]}' ]] || fail "published ports: $ports"
proof "db, api and caddy: ReadonlyRootfs true, CapDrop [ALL], User 62532:62532, no-new-privileges:true; the only port binding: $ports"

# ------------------------------------------------------------------ 7
step "7. f1-tick restores a deleted table inet f1"
nft delete table inet f1
run "$tmp/tick" "$BIN/f1-tick"
((rc == 0)) || fail "f1-tick exited $rc"
nft list table inet f1 >/dev/null || fail "f1-tick did not restore table inet f1"
[[ $(cat "$STATE/disk") =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z\ [0-9]{1,3}$ ]] || fail "disk: $(cat "$STATE/disk")"
curl -fsS --max-time 5 -o /dev/null "$URL" || fail "$URL is not 200 after the reload"
proof "f1-tick reloaded the deleted table inet f1 and wrote $STATE/disk ($(cat "$STATE/disk")); $URL still 200"

# ------------------------------------------------------------------ invariant 4
for t in f1-update.timer f1-tick.timer; do
  if systemctl is-enabled --quiet "$t" 2>/dev/null; then fail "$t is enabled"; fi
done
proof "no f1 timer is enabled; ingest and cloudflared never ran"
