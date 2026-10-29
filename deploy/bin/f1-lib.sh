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

# unready: the f1 containers that are unhealthy, still starting or restarting, as
# "<name>: <status>, …" (empty when none). Exited ones, such as a finished job, do not count.
unready() {
  local name state status list=''
  while read -r name state status; do
    if [[ $state == restarting || $status == *'(unhealthy)'* || $status == *'(health: starting)'* ]]; then
      list+="${list:+, }$name: $status"
    fi
  done < <(docker ps -a --filter label=com.docker.compose.project=f1 --format '{{.Names}} {{.State}} {{.Status}}')
  printf '%s' "$list"
}

# smoke: /healthz through caddy (so caddy, api and db) answers 200 on the published port, and then
# no f1 container is unready (every one that runs is healthy), within F1_SMOKE_TIMEOUT seconds
# (default 120).
smoke() {
  local limit=${F1_SMOKE_TIMEOUT:-120} deadline up=0 sick=''
  [[ $limit =~ ^[0-9]{1,4}$ ]] || die "F1_SMOKE_TIMEOUT must be a number of seconds"
  deadline=$((SECONDS + 10#$limit))
  while ((SECONDS < deadline)); do
    if ((up)) || curl -fsS -o /dev/null --max-time 5 "$F1_SMOKE_URL" 2>/dev/null; then
      up=1
      sick=$(unready)
      if [[ -z $sick ]]; then
        log "smoke test passed: $F1_SMOKE_URL 200, no f1 container unhealthy, starting or restarting"
        return 0
      fi
    fi
    sleep 3
  done
  if ((up)); then
    log "smoke test failed: $F1_SMOKE_URL 200, but within $limit s not every f1 container is healthy: $sick"
  else
    log "smoke test failed: no 200 from $F1_SMOKE_URL within $limit s"
  fi
  return 1
}

# Fail closed (A§14.5): f1-tick stops the f1 containers when table inet f1 is missing and will not
# load, and leaves this marker. resume_stack, run by f1-tick and f1-update under the update lock
# once the table is loaded, starts current.env again and removes it.
readonly F1_FW_STOPPED=$F1_STATE/firewall-stopped
resume_stack() {
  [[ -f $F1_FW_STOPPED ]] || return 0
  if [[ -f $F1_STATE/current.env ]]; then
    log "table inet f1 is loaded again: starting the f1 stack ($F1_STATE/current.env)"
    if ! f1_compose "$F1_STATE/current.env" up -d --remove-orphans; then
      log "error: starting the f1 stack failed: trying again next run"
      return 1
    fi
  fi
  rm -f -- "$F1_FW_STOPPED"
}
