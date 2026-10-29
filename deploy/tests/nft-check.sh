#!/usr/bin/env bash
# nft-check (CI: ci / deploy, step `nft-check`; D13, A§14.3).
# Proves deploy/host/nftables-f1.conf in a throw-away Debian 13 container (NET_ADMIN there only:
# nft touches the container's own network namespace, never the runner's): `nft -c`, two loads
# in a row (the `table` + `delete table` idiom makes a reload idempotent), f1-resolvers filling
# the resolver set, and the listed table. Also: the file never contains `flush ruleset`.
# The container is on the default bridge because apt needs deb.debian.org.
# Usage: bash deploy/tests/nft-check.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)
conf=$repo/deploy/host/nftables-f1.conf
# debian:trixie-20261020-slim (2026-10-21), the multi-arch index digest.
readonly IMAGE=debian:trixie-20261020-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

if grep -nE 'flush[[:space:]]+ruleset' "$conf"; then
  echo "nft-check: $conf contains 'flush ruleset' (it would delete Docker's and Waterheight's tables)" >&2
  exit 1
fi

# shellcheck disable=SC2016 # runs in the container
docker run --rm --cap-add NET_ADMIN \
  -v "$conf:/f1/nftables-f1.conf:ro" -v "$repo/deploy/bin:/f1/bin:ro" \
  "$IMAGE" bash -c '
    set -euo pipefail
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nftables >/dev/null
    nft --version
    nft -c -f /f1/nftables-f1.conf
    nft -f /f1/nftables-f1.conf
    /f1/bin/f1-resolvers
    nft -f /f1/nftables-f1.conf
    /f1/bin/f1-resolvers
    nft list table inet f1
    [[ $(nft list tables) == "table inet f1" ]] || { echo "nft-check: unexpected tables: $(nft list tables)" >&2; exit 1; }
    for set in resolvers4 cf4 cf_tunnel4; do nft list set inet f1 "$set" >/dev/null; done
    echo "nft-check: nft -c, two loads and f1-resolvers pass; only table inet f1 exists"
  '
