#!/usr/bin/env bash
# hardening (CI: ci / deploy, step `hardening`; D13, invariants 1, 2, 5 and 7).
# Renders deploy/compose.yaml with `docker compose config` (dummy image refs; no root, no
# /etc/f1 needed: the secret files and f1.env are never read by `config`) and checks the
# result with one jq program: every check is named, and a failure prints the names.
# Then the negative case: the same program over a copy without api's read_only must fail.
# Usage: bash deploy/tests/hardening.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

printf 'F1_SERVER_IMAGE=f1-server:ci\nF1_WEB_IMAGE=f1-web:ci\n' >"$tmp/images.env"
# --profile jobs: `config` leaves out the migrate job otherwise.
docker compose -f "$repo/deploy/compose.yaml" --env-file "$tmp/images.env" --profile jobs \
  config --format json >"$tmp/config.json"

# shellcheck disable=SC2016 # a jq program, not shell
program='
# The secret GIDs (A§14.2, D5).
{db_postgres: "62001", db_f1_migrator: "62002", db_f1_ingest: "62003", db_f1_api: "62004",
 cf_tunnel_token: "62005", hc_ping_key: "62006", f1tv_username: "62007", f1tv_password: "62008"} as $gid
| . as $c
| ($c.services | to_entries) as $s
| ($c.networks // {}) as $n
| {
  services: (($c.services | keys) == ["api", "caddy", "cloudflared", "db", "ingest", "live", "migrate"]),
  read_only: all($s[]; .value.read_only == true),
  cap_drop_all: all($s[]; .value.cap_drop == ["ALL"]),
  no_new_privileges: all($s[]; any(.value.security_opt[]?; . == "no-new-privileges:true")),
  user_62532: all($s[]; .value.user == "62532:62532"),
  limits: all($s[]; .value.mem_limit != null and .value.cpus != null and .value.pids_limit != null),
  not_privileged: all($s[]; .value.privileged != true and (.value.cap_add // []) == [] and (.value.devices // []) == []),
  no_host_namespaces: all($s[]; all(.value.network_mode, .value.pid, .value.ipc, .value.uts, .value.userns_mode; . != "host")),
  no_docker_sock: ([$s[].value.volumes[]? | .source // "" | select(test("docker\\.sock"))] == []),
  only_bind_allowlist: ([$s[] | .key as $k | .value.volumes[]? | select(.type == "bind")
      | {svc: $k, source, target, read_only: (.read_only // false)}] | sort_by(.svc, .source)
    == [{svc: "db", source: "/etc/f1/postgres/roles.sql", target: "/docker-entrypoint-initdb.d/10-roles.sql", read_only: true},
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
  healthchecks: all($s[] | select(.key != "migrate"); .value.healthcheck.test != null and .value.healthcheck.disable != true),
  images_pinned: all($s[]; .value.image | test("@sha256:[0-9a-f]{64}$") or . == "f1-server:ci" or . == "f1-web:ci"),
  networks_named_f1: ($n != {} and all($n | to_entries[]; (.key | test("^f1-[a-z-]+$")) and .value.name == .key
    and .value.driver_opts["com.docker.network.bridge.name"] == .key)),
  subnets_10_62: all($n[]; [.ipam.config[]?.subnet] | length == 1 and (.[0] | test("^10\\.62\\.[0-9]{1,3}\\.0/24$"))),
  subnets_distinct: ([$n[].ipam.config[]?.subnet] | (unique | length) == length),
  ipv4_only: all($n[]; .enable_ipv6 != true),
  icc_off_unless_internal: all($n[]; .internal == true or .driver_opts["com.docker.network.bridge.enable_icc"] == "false"),
  network_members: (([$n | keys[] as $k | {($k): ([$s[] | select((.value.networks // {}) | has($k)) | .key] | sort)}] | add) == {
    "f1-db": ["api", "db", "ingest", "live", "migrate"], "f1-edge": ["api", "caddy"], "f1-egress": ["ingest", "live"],
    "f1-api-egress": ["api"], "f1-tunnel": ["cloudflared"], "f1-tunnel-edge": ["caddy", "cloudflared"],
    "f1-publish": ["caddy"]}),
  one_external_network: all($s[]; [(.value.networks // {}) | keys[] | select($n[.].internal != true)] | length <= 1),
  secret_files: ((($c.secrets // {}) | keys) == ($gid | keys)
    and all($c.secrets | to_entries[]; .value.file == "/etc/f1/secrets/" + .key)),
  secret_consumers: (([$s[] | {(.key): ([.value.secrets[]?.source] | sort)}] | add) == {
    api: ["db_f1_api"], caddy: [], cloudflared: ["cf_tunnel_token"],
    db: ["db_f1_api", "db_f1_ingest", "db_f1_migrator", "db_postgres"],
    ingest: ["db_f1_ingest", "hc_ping_key"], live: ["db_f1_ingest", "f1tv_password", "f1tv_username", "hc_ping_key"],
    migrate: ["db_f1_migrator"]}),
  gids_only_for_own_secrets: all($s[]; ([.value.group_add[]? | tostring] | sort) == ([.value.secrets[]?.source | $gid[.]] | unique)),
  gids_62001_62099: all($s[]; all(.value.group_add[]?; tonumber | . >= 62001 and . <= 62099)),
  no_rws: ($c | tojson | test("rws|172\\.30\\.") | not)
}
| [to_entries[] | select(.value != true) | .key] as $failed
| if $failed == [] then length else ("failed: " + ($failed | join(", ")) + "\n" | halt_error(1)) end
'

if ! n=$(jq -e "$program" "$tmp/config.json"); then
  echo "hardening: deploy/compose.yaml does not pass (the check names are above)" >&2
  exit 1
fi
echo "hardening: deploy/compose.yaml passes $n checks"

# The negative cases: the program must catch each of these, and name the failed check. The second is
# the O1 rule: live may mount /srv/f1/state/live but never /srv/f1/state itself.
negative() {
  local label=$1 check=$2 filter=$3 err
  jq "$filter" "$tmp/config.json" >"$tmp/broken.json"
  if err=$(jq -e "$program" "$tmp/broken.json" 2>&1 >/dev/null); then
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
negative "live with /srv/f1/state as a source" only_bind_allowlist \
  '(.services.live.volumes[] | select(.target == "/srv/f1/state") | .source) = "/srv/f1/state"'
