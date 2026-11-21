#!/usr/bin/env bash
# Prepare the second, canonical-path materialization while the candidate warms.
set -euo pipefail
umask 077
root=/var/lib/aihr-cutover
[[ "$#" == 1 && "$1" =~ ^/var/tmp/aihr-deploy/cutover-packet-[A-Za-z0-9]+$ ]]
packet=$1
cd "$packet"
test "$(stat -c '%u:%a' "$packet")" = "$(id -u):700"
digest=$(jq -er .archiveSha256 verified.json)
manifest=$(jq -er .manifestSha256 verified.json)
producer=$(jq -er .buildSourcePath verified.json)
build=$(jq -er .nextBuildId verified.json)
[[ "$digest" =~ ^[a-f0-9]{64}$ && "$manifest" =~ ^[a-f0-9]{64}$ && "$producer" == /home/runner/work/* ]]
printf '%s  %s\n' "$digest" build.tar.gz "$manifest" build-manifest.json | sha256sum -c --status
stage=$root/prepared/$digest
mkdir -m 700 "$stage"
# The ingress root inherits a group for its sockets. The exchange requires
# the per-attempt directory to have exactly 0700 without the inherited bit.
chmod g-s "$stage"
test "$(stat -c '%a' "$stage")" = 700
PYTHONDONTWRITEBYTECODE=1 python3 /opt/ai-hr/.github/ci/build-bundle.py unpack-with-origin \
  "$packet/build.tar.gz" "$packet/build-manifest.json" "$stage/next" /opt/ai-hr "$producer"
test "$(cat "$stage/next/BUILD_ID")" = "$build"
