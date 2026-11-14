#!/usr/bin/env bash
# sse-check (CI: ci / deploy, e2e step 3f; #40, A§14.2). The real f1-web:ci Caddyfile in front of a stub
# api (node from f1-server:ci) on a throw-away Docker network. Three assertions on a playback stream
# of 6 events, 1 s apart: (1) no Content-Encoding; (2) each event arrives within 500 ms of its send
# time (unbuffered); (3) the 2 KB JSON control route is still compressed. Fail 0 is a route that is
# not a 200 of its type: a run that proves nothing. Then three negative cases that must fail by their
# own assertion, never by 0: encode without the @compress matcher (1), the exclusion widened to every
# route so that nothing is compressed (3), and a stub that buffers the stream (2).
# The stub sends Cache-Control: no-cache, never no-transform: Caddy 2.11's encode skips a response
# with no-transform (the real api sends it), which would hide a missing matcher. So the check tests
# the matcher alone. The stub's JSON route is over encode's 512 B minimum_length, with a Content-Length.
# Needs Docker and the two images, no root. Nothing leaves the local Docker network (invariant 4).
# Usage: bash deploy/tests/sse-check.sh
set -euo pipefail
export LC_ALL=C # $EPOCHREALTIME and awk use the locale's decimal point

net=f1-sse-check api=f1-sse-check-api web=f1-sse-check-caddy
tmp=
cleanup() {
  docker rm -fv "$api" "$web" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  [[ -z $tmp ]] || rm -rf -- "$tmp"
}
trap cleanup EXIT
cleanup # leftovers of a killed run
tmp=$(mktemp -d)

for image in f1-server:ci f1-web:ci; do docker image inspect "$image" >/dev/null || {
  echo "sse-check: image $image is missing" >&2
  exit 1
}; done

# The image is distroless: node only, as 62532. /playback/2 holds its events back and writes them at
# the end (a stand-in for a buffering layer, self-test of assertion 2).
stub=$(
  cat <<'JS'
const http = require('node:http');
const names = ['snapshot', 'tick', 'tick', 'tick', 'tick', 'end'];
const ev = (i) => `event: ${names[i]}\ndata: {"i":${i},"t":${Date.now()}}\n\n`;
const control = JSON.stringify({ pad: 'x'.repeat(2000) });
http.createServer((req, res) => {
  const m = /^\/api\/v1\/playback\/([12])\/stream$/.exec(req.url);
  if (m) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let held = '';
    let i = 0;
    const next = () => {
      const e = ev(i++);
      if (m[1] === '1') res.write(e);
      else held += e;
      if (i < names.length) setTimeout(next, 1000);
      else res.end(held);
    };
    next();
  } else if (req.url === '/api/v1/control') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(control) });
    res.end(control);
  } else {
    res.writeHead(404).end();
  }
}).listen(8080);
JS
)
docker network create "$net" >/dev/null
docker run -d --name "$api" --network "$net" --network-alias api --entrypoint /nodejs/bin/node f1-server:ci -e "$stub" >/dev/null

# start <Caddyfile|->: a fresh f1-web:ci, with the image's own Caddyfile or a mutated copy; sets $port.
start() {
  local mount=()
  [[ $1 == - ]] || mount=(-v "$1:/etc/caddy/Caddyfile:ro")
  docker rm -fv "$web" >/dev/null 2>&1 || true
  docker run -d --name "$web" --network "$net" --sysctl net.ipv4.ip_unprivileged_port_start=80 \
    -p 127.0.0.1::80 "${mount[@]}" f1-web:ci >/dev/null
  port=$(docker port "$web" 80/tcp | head -n 1) || true # a caddy that already exited: its logs below
  port=${port##*:}
  # The control route is a 502 until the stub listens.
  for _ in $(seq 20); do
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/v1/control" 2>/dev/null && return 0
    [[ $(docker inspect -f '{{.State.Running}}' "$web") == true ]] || break
    sleep 1
  done
  docker logs "$web" 2>&1 | sed 's/^/caddy| /' >&2 || true
  docker logs "$api" 2>&1 | sed 's/^/stub| /' >&2 || true
  echo "sse-check: caddy did not start, or the stub does not answer" >&2
  exit 1
}

# check <stream path>: one "fail <n>: <reason>" line per failed assertion (0: a route is not a 200 of
# its type), else one "pass: <evidence>" line.
check() {
  local url=http://127.0.0.1:$port head enc ev ctl fails=0
  rm -f "$tmp/stream.head" "$tmp/stream.lines"
  # No --compressed: curl must show what Caddy sent. Each line is stamped when it arrives.
  curl -sS -N --max-time 20 -H 'Accept-Encoding: gzip, zstd' -D "$tmp/stream.head" "$url$1" 2>/dev/null |
    while IFS= read -r line; do printf '%s %s\n' "$EPOCHREALTIME" "$line"; done >"$tmp/stream.lines" 2>/dev/null || true
  head=$(tr -d '\r' <"$tmp/stream.head" 2>/dev/null || true)
  if [[ ${head%%$'\n'*} != HTTP/*' 200'* ]] || ! grep -qi '^content-type: text/event-stream' <<<"$head"; then
    echo "fail 0: the stream is not a 200 text/event-stream: '${head%%$'\n'*}'"
    fails=1
  fi
  if enc=$(grep -i '^content-encoding:' <<<"$head"); then
    echo "fail 1: the stream has $enc"
    fails=1
  fi
  # A buffered event is at least 1 s late; 500 ms is slack for a loaded runner.
  if ! ev=$(awk '
    $2 == "data:" && match($0, /"t":[0-9]+/) {
      lat = $1 * 1000 - substr($0, RSTART + 4, RLENGTH - 4)
      if (n++) gaps = gaps sprintf(" %d", ($1 - prev) * 1000); else first = lat
      prev = $1
      if (lat > max) max = lat
    }
    END {
      if (n != 6 || max >= 500) { printf "%d events, first %d ms, largest latency %d ms\n", n, first, max; exit 1 }
      printf "first event %d ms, gaps%s ms, largest latency %d ms\n", first, gaps, max
    }' "$tmp/stream.lines"); then
    echo "fail 2: the stream is not on cadence: $ev"
    fails=1
  fi
  ctl=$(curl -sS -o /dev/null -D - --max-time 5 -H 'Accept-Encoding: gzip, zstd' "$url/api/v1/control" | tr -d '\r' || true)
  if [[ ${ctl%%$'\n'*} != HTTP/*' 200'* ]]; then
    echo "fail 0: the control route is not a 200: '${ctl%%$'\n'*}'"
    fails=1
  elif ! enc=$(grep -ioE '^content-encoding: (zstd|gzip)' <<<"$ctl"); then
    echo "fail 3: the control route is not compressed"
    fails=1
  fi
  ((fails)) || echo "pass: the stream has no Content-Encoding, $ev; the control route has ${enc,,}"
}

# negative <label> <fail n> <Caddyfile|-> <stream path>: check must fail on that assertion, with both
# routes up (no fail 0: a 404 or a 502 would fail any assertion for the wrong reason).
negative() {
  local label=$1 n=$2 out
  start "$3"
  if out=$(check "$4"); [[ $out == pass* ]]; then
    echo "sse-check: the negative case passed: the check does not catch $label" >&2
    exit 1
  fi
  [[ $out == *"fail $n:"* && $out != *"fail 0:"* ]] || {
    echo "sse-check: the negative case ($label) failed for another reason: $out" >&2
    exit 1
  }
  echo "sse-check: the negative case ($label) fails as expected: ${out//$'\n'/ | }"
}

# mutant <name> <sed expression>…: a copy of the image's own Caddyfile, so it derives from exactly what runs.
mutant() {
  sed "${@:2}" "$tmp/Caddyfile" >"$tmp/$1"
  ! cmp -s "$tmp/Caddyfile" "$tmp/$1" || {
    echo "sse-check: the $1 mutation changed nothing" >&2
    exit 1
  }
  chmod 0644 "$tmp/$1" # uid 62532 reads the bind mount
}

# The real check first: a regression in the Caddyfile shows as its failed assertion, not as a mutation error.
start -
out=$(check /api/v1/playback/1/stream)
echo "sse-check: $out"
[[ $out == pass* ]] || exit 1
docker run --rm --entrypoint cat f1-web:ci /etc/caddy/Caddyfile >"$tmp/Caddyfile"
mutant nomatcher -e '/^[[:space:]]*@compress /d' -e 's/encode @compress /encode /'
mutant widened -e 's|@compress not path_regexp .*|@compress not path_regexp ^/|'
negative "encode without the matcher" 1 "$tmp/nomatcher" /api/v1/playback/1/stream
negative "the exclusion widened to every route (nothing compressed)" 3 "$tmp/widened" /api/v1/playback/1/stream
negative "a buffering upstream" 2 - /api/v1/playback/2/stream
echo "sse-check: ${out}; 3 negative cases fail as expected"
