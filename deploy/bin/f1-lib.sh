# shellcheck shell=bash
# shellcheck disable=SC2034 # the constants are for the scripts that source this file
# Shared helpers of the f1-* host scripts (A§14.4, A§14.5). Sourced, never run. Every script runs
# as root, from a systemd unit or by the owner with sudo. The paths are fixed: CI runs as root on
# the real ones. No function here ever prints a secret value.
set -euo pipefail
umask 077
export LC_ALL=C

readonly F1_ETC=/etc/f1
readonly F1_STATE=/srv/f1/state
readonly F1_LOCK_DIR=/run/f1
readonly F1_SMOKE_URL=http://127.0.0.1:8180/healthz
# Each secret file and its GID (A§14.2, D5): /etc/f1/secrets/<name>, root:<gid> 0440, and only
# its consumers get the gid (compose.yaml group_add). P2c takes 62007 and up.
readonly F1_SECRETS=(db_postgres:62001 db_f1_migrator:62002 db_f1_ingest:62003 db_f1_api:62004
  cf_tunnel_token:62005 hc_ping_key:62006)
# An image reference f1-update may write into an env file: no space, quote, `$` or newline.
readonly F1_REF_RE='^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$'

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${0##*/}" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# lockfile <name>: a lock in the root-only /run/f1, never a shared 1777 directory such as
# /run/lock, where another user could pre-create the file.
lockfile() {
  mkdir -m 0700 -- "$F1_LOCK_DIR" 2>/dev/null || [[ -d $F1_LOCK_DIR ]]
  printf '%s/%s.lock' "$F1_LOCK_DIR" "$1"
}

# stdin -> a temporary file in the destination's directory -> rename (atomic).
write_atomic() {
  local dest=$1 mode=$2 tmp
  tmp=$(mktemp "${dest%/*}/.${dest##*/}.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# The owner's settings (A§12.2): /etc/f1/f1.env, read as KEY=VALUE lines, never sourced. Only
# CF_ACCESS_TEAM and CF_ACCESS_AUD; any other line fails, so nothing else reaches the api's
# environment through its env_file. True when both match what the api accepts (api/access.ts).
env_ready() {
  local file=$F1_ETC/f1.env line team='' aud=''
  [[ -r $file ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ $line =~ ^CF_ACCESS_TEAM=(.*)$ ]]; then
      team=${BASH_REMATCH[1]}
    elif [[ $line =~ ^CF_ACCESS_AUD=(.*)$ ]]; then
      aud=${BASH_REMATCH[1]}
    else
      return 1
    fi
  done <"$file"
  [[ $team =~ ^[a-z0-9][a-z0-9-]{0,62}$ && $aud =~ ^[0-9a-f]{64}$ ]]
}

# secret_matches <name> <regex>: the first line of /etc/f1/secrets/<name> matches. The value
# never leaves this function.
secret_matches() {
  local file=$F1_ETC/secrets/$1 value=''
  [[ -f $file ]] || return 1
  IFS= read -r value <"$file" || true
  [[ $value =~ $2 ]]
}

# f1_compose <env file> <compose args…>: docker compose on the installed file as project f1,
# with the image references of <env file> only (the caller's environment cannot override them).
# F1_COMPOSE_OVERRIDE adds a second file: CI only (deploy/tests/ci.override.yaml).
f1_compose() {
  local env_file=$1 files=(-f "$F1_ETC/compose.yaml")
  shift
  [[ -z ${F1_COMPOSE_OVERRIDE:-} ]] || files+=(-f "$F1_COMPOSE_OVERRIDE")
  env -u F1_SERVER_IMAGE -u F1_WEB_IMAGE -u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME \
    docker compose -p f1 "${files[@]}" --env-file "$env_file" "$@"
}

# smoke: /healthz through caddy (so caddy, api and db) answers 200 on the published port within
# F1_SMOKE_TIMEOUT seconds (default 120).
smoke() {
  local limit=${F1_SMOKE_TIMEOUT:-120} deadline
  [[ $limit =~ ^[0-9]{1,4}$ ]] || die "F1_SMOKE_TIMEOUT must be a number of seconds"
  deadline=$((SECONDS + 10#$limit))
  while ((SECONDS < deadline)); do
    if curl -fsS -o /dev/null --max-time 5 "$F1_SMOKE_URL" 2>/dev/null; then
      log "smoke test passed: $F1_SMOKE_URL 200"
      return 0
    fi
    sleep 3
  done
  log "smoke test failed: no 200 from $F1_SMOKE_URL within $limit s"
  return 1
}
