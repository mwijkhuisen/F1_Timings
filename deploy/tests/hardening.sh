#!/usr/bin/env bash
# hardening (CI: ci / deploy, step `hardening`; D13, invariants 1, 2, 5 and 7).
# Renders deploy/compose.yaml with `docker compose config` (dummy image refs; no root, no
# /etc/f1 needed: the secret files and f1.env are never read by `config`) and checks the
# result with one jq program: every check is named, and a failure prints the names.
# Then the negative cases: the same program over a broken copy must fail, naming the check.
# Then the host files (#104): the GIDs in f1-lib.sh's F1_SECRETS match the program's $gid map; no
# f1 unit runs as another user or adds a group (User=, Group=, DynamicUser=, SupplementaryGroups=);
# and f1-alert@.service keeps its sandbox. Three negative cases on broken copies. The root:<gid>
# 0440 modes come from f1-install and are asserted by e2e, not here.
# Usage: bash deploy/tests/hardening.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

printf 'F1_SERVER_IMAGE=f1-server:ci\nF1_WEB_IMAGE=f1-web:ci\n' >"$tmp/images.env"
# --profile jobs: `config` leaves out the migrate job otherwise.
docker compose -f "$repo/deploy/compose.yaml" --env-file "$tmp/images.env" --profile jobs \
  config --format json >"$tmp/config.json"

# The secret GIDs (A§14.2, D5), as <name>:<gid>: the jq program's $gid map, and the pairs that
# f1-lib.sh's F1_SECRETS must list (the host section).
readonly SECRET_GIDS='db_postgres:62001 db_f1_migrator:62002 db_f1_ingest:62003 db_f1_api:62004
  cf_tunnel_token:62005 hc_ping_key:62006 f1tv_username:62007 f1tv_password:62008'

# shellcheck disable=SC2016 # a jq program, not shell
program='
([$gids | splits("\\s+") | select(. != "") | split(":") | {(.[0]): .[1]}] | add) as $gid
| . as $c
| ($c.services | to_entries) as $s
| ($c.networks // {}) as $n
| {
  services: (($c.services | keys) == ["api", "archive", "caddy", "cloudflared", "db", "fill", "ingest", "jolpica", "live", "migrate"]),
  read_only: all($s[]; .value.read_only == true),
  cap_drop_all: all($s[]; .value.cap_drop == ["ALL"]),
  no_new_privileges: all($s[]; any(.value.security_opt[]?; . == "no-new-privileges:true")),
  user_62532: all($s[]; .value.user == "62532:62532"),
  limits: all($s[]; .value.mem_limit != null and .value.cpus != null and .value.pids_limit != null),
  # `config` leaves out a 0, so soft: 0, hard: 0 renders as core: {}. e2e sees the 0s on the running containers.
  no_core_dumps: all($s[]; .value.ulimits.core | . != null and (.soft // 0) == 0 and (.hard // 0) == 0 and (.single // 0) == 0),
  not_privileged: all($s[]; .value.privileged != true and (.value.cap_add // []) == [] and (.value.devices // []) == []),
  no_host_namespaces: all($s[]; all(.value.network_mode, .value.pid, .value.ipc, .value.uts, .value.userns_mode; . != "host")),
  no_docker_sock: ([$s[].value.volumes[]? | .source // "" | select(test("docker\\.sock"))] == []),
  only_bind_allowlist: ([$s[] | .key as $k | .value.volumes[]? | select(.type == "bind")
      | {svc: $k, source, target, read_only: (.read_only // false)}] | sort_by(.svc, .source)
    == [{svc: "api", source: "/srv/f1/live", target: "/srv/f1/live", read_only: true},
        {svc: "archive", source: "/srv/f1/archive", target: "/srv/f1/archive", read_only: false},
        {svc: "archive", source: "/srv/f1/state/live", target: "/srv/f1/state", read_only: true},
        {svc: "db", source: "/etc/f1/postgres/roles.sql", target: "/docker-entrypoint-initdb.d/10-roles.sql", read_only: true},
        {svc: "fill", source: "/srv/f1/archive", target: "/srv/f1/archive", read_only: true},
        {svc: "fill", source: "/srv/f1/live", target: "/srv/f1/live", read_only: true},
        {svc: "jolpica", source: "/srv/f1/jolpica", target: "/srv/f1/jolpica", read_only: true},
        {svc: "live", source: "/srv/f1/live", target: "/srv/f1/live", read_only: false},
        {svc: "live", source: "/srv/f1/state/live", target: "/srv/f1/state", read_only: false}]),
  only_port_127_0_0_1_8180: ([$s[] | .key as $k | .value.ports[]? | {svc: $k, host_ip, published, target, protocol}]
    == [{svc: "caddy", host_ip: "127.0.0.1", published: "8180", target: 80, protocol: "tcp"}]),
  no_database_url: all($s[]; (.value.environment // {}) | has("DATABASE_URL") | not),
  secret_env_only_file_paths: all($s[]; all((.value.environment // {}) | to_entries[];
    (.key | test("PASSWORD|TOKEN|SECRET|KEY"; "i") | not)
    or ((.key | endswith("_FILE")) and ((.value // "") | startswith("/run/secrets/"))))),
  no_token_argument: all($s[]; all((.value.command // [])[], (.value.entrypoint // [])[];
    (startswith("--token") | not) or . == "--token-file")),
  tunnel_token_file: any($c.services.cloudflared.command[]?; . == "--token-file"),
  # http2 over tcp/7844 only (P2f): QUIC fails on the VM and the firewall has no udp/7844 (nft-check.sh).
  tunnel_http2: (($c.services.cloudflared.command // []) | index(["--protocol", "http2"]) != null),
  healthchecks: all($s[] | select(.key != "migrate" and .key != "archive" and .key != "fill" and .key != "jolpica"); .value.healthcheck.test != null and .value.healthcheck.disable != true),
  images_pinned: all($s[]; .value.image | test("@sha256:[0-9a-f]{64}$") or . == "f1-server:ci" or . == "f1-web:ci"),
  networks_named_f1: ($n != {} and all($n | to_entries[]; (.key | test("^f1-[a-z-]+$")) and .value.name == .key
    and .value.driver_opts["com.docker.network.bridge.name"] == .key)),
  subnets_10_62: all($n[]; [.ipam.config[]?.subnet] | length == 1 and (.[0] | test("^10\\.62\\.[0-9]{1,3}\\.0/24$"))),
  subnets_distinct: ([$n[].ipam.config[]?.subnet] | (unique | length) == length),
  ipv4_only: all($n[]; .enable_ipv6 != true),
  icc_off_unless_internal: all($n[]; .internal == true or .driver_opts["com.docker.network.bridge.enable_icc"] == "false"),
  network_members: (([$n | keys[] as $k | {($k): ([$s[] | select((.value.networks // {}) | has($k)) | .key] | sort)}] | add) == {
    "f1-db": ["api", "archive", "db", "fill", "ingest", "jolpica", "live", "migrate"], "f1-edge": ["api", "caddy"],
    "f1-egress": ["archive", "ingest", "live"],
    "f1-api-egress": ["api"], "f1-tunnel": ["cloudflared"], "f1-tunnel-edge": ["caddy", "cloudflared"],
    "f1-publish": ["caddy"]}),
  one_external_network: all($s[]; [(.value.networks // {}) | keys[] | select($n[.].internal != true)] | length <= 1),
  secret_files: ((($c.secrets // {}) | keys) == ($gid | keys)
    and all($c.secrets | to_entries[]; .value.file == "/etc/f1/secrets/" + .key)),
  secret_consumers: (([$s[] | {(.key): ([.value.secrets[]?.source] | sort)}] | add) == {
    api: ["db_f1_api"], archive: ["db_f1_ingest"], caddy: [], cloudflared: ["cf_tunnel_token"],
    db: ["db_f1_api", "db_f1_ingest", "db_f1_migrator", "db_postgres"], fill: ["db_f1_ingest"],
    ingest: ["db_f1_ingest", "hc_ping_key"], jolpica: ["db_f1_ingest"], live: ["db_f1_ingest", "f1tv_password", "f1tv_username", "hc_ping_key"],
    migrate: ["db_f1_migrator"]}),
  gids_only_for_own_secrets: all($s[]; ([.value.group_add[]? | tostring] | sort) == ([.value.secrets[]?.source | $gid[.]] | unique)),
  gids_62001_62099: all($s[]; all(.value.group_add[]?; tonumber | . >= 62001 and . <= 62099)),
  no_rws: ($c | tojson | test("rws|172\\.30\\.") | not)
}
| [to_entries[] | select(.value != true) | .key] as $failed
| if $failed == [] then length else ("failed: " + ($failed | join(", ")) + "\n" | halt_error(1)) end
'

if ! n=$(jq -e --arg gids "$SECRET_GIDS" "$program" "$tmp/config.json"); then
  echo "hardening: deploy/compose.yaml does not pass (the check names are above)" >&2
  exit 1
fi
echo "hardening: deploy/compose.yaml passes $n checks"

# The negative cases: the program must catch each of these, and name the failed check. The second is
# the O1 rule: live and archive may mount /srv/f1/state/live but never /srv/f1/state itself.
negative() {
  local label=$1 check=$2 filter=$3 err
  jq "$filter" "$tmp/config.json" >"$tmp/broken.json"
  if err=$(jq -e --arg gids "$SECRET_GIDS" "$program" "$tmp/broken.json" 2>&1 >/dev/null); then
    echo "hardening: the negative case passed: the check does not catch $label" >&2
    exit 1
  fi
  [[ $err == *"$check"* ]] || {
    echo "hardening: the negative case ($label) failed for another reason: $err" >&2
    exit 1
  }
  echo "hardening: the negative case ($label) fails as expected: ${err%$'\n'}"
}
negative "api without read_only" read_only 'del(.services.api.read_only)'
negative "live without the core limit" no_core_dumps 'del(.services.live.ulimits)'
negative "caddy with a core size" no_core_dumps '.services.caddy.ulimits.core = {soft: 1, hard: 1}'
negative "live with /srv/f1/state as a source" only_bind_allowlist \
  '(.services.live.volumes[] | select(.target == "/srv/f1/state") | .source) = "/srv/f1/state"'
negative "archive with /srv/f1/state as a source" only_bind_allowlist \
  '(.services.archive.volumes[] | select(.target == "/srv/f1/state") | .source) = "/srv/f1/state"'
negative "archive with the token directory read-write" only_bind_allowlist \
  '(.services.archive.volumes[] | select(.target == "/srv/f1/state") | .read_only) = false'
negative "api with /srv/f1/live read-write" only_bind_allowlist \
  '(.services.api.volumes[] | select(.target == "/srv/f1/live") | .read_only) = false'
negative "fill with /srv/f1/live read-write" only_bind_allowlist \
  '(.services.fill.volumes[] | select(.target == "/srv/f1/live") | .read_only) = false'
negative "jolpica with /srv/f1/jolpica read-write" only_bind_allowlist \
  '(.services.jolpica.volumes[] | select(.target == "/srv/f1/jolpica") | .read_only) = false'
negative "api with an extra bind" only_bind_allowlist \
  '.services.api.volumes += [{type: "bind", source: "/srv/f1/state/live", target: "/srv/f1/state", read_only: true}]'
negative "cloudflared without --protocol http2" tunnel_http2 \
  '.services.cloudflared.command |= map(select(. != "--protocol" and . != "http2"))'

# ------------------------------------------------------------------ the host (#104)
# host_checks <f1-lib.sh> <unit…>: F1_SECRETS's name:gid pairs are SECRET_GIDS (f1-install applies
# them as root:<gid> 0440; e2e checks the modes); no unit sets User=, Group=, DynamicUser= or
# SupplementaryGroups= (anchored, so a comment cannot trip it; spaces around = allowed, as systemd
# does); and the f1-alert@.service among the units keeps an empty CapabilityBoundingSet=,
# ProtectSystem=strict, NoNewPrivileges=yes and its RestrictAddressFamilies= line.
host_checks() {
  local lib=$1 failed=() pairs
  shift
  # A bash of its own sources the file: f1-lib.sh sets readonly names and shell options.
  pairs=$(bash -c '. "$1" && printf "%s\n" "${F1_SECRETS[@]}"' f1-lib "$lib" | sort)
  [[ $pairs == "$(tr -s ' \n' '\n' <<<"$SECRET_GIDS" | sort)" ]] || failed+=(f1_secrets_gids)
  if grep -qE '^[[:space:]]*(User|Group|DynamicUser|SupplementaryGroups)[[:space:]]*=' "$@"; then
    failed+=(units_root)
  fi
  local unit alert=''
  for unit; do [[ ${unit##*/} != f1-alert@.service ]] || alert=$unit; done
  if [[ -z $alert ]] || ! grep -qxF 'CapabilityBoundingSet=' "$alert" ||
    ! grep -qxF 'ProtectSystem=strict' "$alert" || ! grep -qxF 'NoNewPrivileges=yes' "$alert" ||
    ! grep -qxF 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK' "$alert"; then
    failed+=(alert_unit_sandbox)
  fi
  if ((${#failed[@]})); then
    echo "failed: ${failed[*]}"
    return 1
  fi
}
units=("$repo"/deploy/systemd/* "$repo"/deploy/host/*.service)
if ! err=$(host_checks "$repo/deploy/bin/f1-lib.sh" "${units[@]}"); then
  echo "hardening: the host files do not pass: $err" >&2
  exit 1
fi
echo "hardening: the host files pass 3 checks (f1_secrets_gids, units_root over ${#units[@]} units, alert_unit_sandbox)"

host_negative() {
  local label=$1 check=$2 err
  shift 2
  if err=$(host_checks "$@"); then
    echo "hardening: the negative case passed: the check does not catch $label" >&2
    exit 1
  fi
  [[ $err == *"$check"* ]] || {
    echo "hardening: the negative case ($label) failed for another reason: $err" >&2
    exit 1
  }
  echo "hardening: the negative case ($label) fails as expected: $err"
}
mkdir "$tmp/host"
cp "$repo/deploy/systemd/f1-alert@.service" "$tmp/host/"
printf 'User = nobody\n' >>"$tmp/host/f1-alert@.service"
host_negative "f1-alert@.service with User = nobody" units_root "$repo/deploy/bin/f1-lib.sh" "$tmp/host/f1-alert@.service"
grep -vxF 'CapabilityBoundingSet=' "$repo/deploy/systemd/f1-alert@.service" >"$tmp/host/f1-alert@.service"
host_negative "f1-alert@.service without CapabilityBoundingSet=" alert_unit_sandbox \
  "$repo/deploy/bin/f1-lib.sh" "$tmp/host/f1-alert@.service"
sed 's/hc_ping_key:62006/hc_ping_key:62099/' "$repo/deploy/bin/f1-lib.sh" >"$tmp/host/f1-lib.sh"
host_negative "F1_SECRETS with hc_ping_key:62099" f1_secrets_gids "$tmp/host/f1-lib.sh" "${units[@]}"
