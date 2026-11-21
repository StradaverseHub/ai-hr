#!/usr/bin/env bash
# Operator entry point for the commissioned migration-free staging path.
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "$0")" && pwd)
controller=$(cd "$here/../.." && pwd)
actor=staging-cutover
: "${AIHR_SSH_CONFIG:?Set the private staging SSH configuration}"
ssh=(ssh -F "$AIHR_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 aihr-staging)
queue=(python3 "$controller/scripts/staging/release_queue.py" --actor "$actor" --ssh-config "$AIHR_SSH_CONFIG")
remote_queue=/var/tmp/aihr-deploy/staging-release-queue/staging.py
stamp() { printf '%s=%s\n' "$1" "$(date -u +%FT%TZ)"; }
mode=$1
shift
if [[ "$mode" == prepare ]]; then
  [[ "$#" == 7 ]]
  source=$1 baseline=$2 baseline_build=$3 ci_controller=$4 run=$5 work=$6 smoke_path=$7
  [[ "$smoke_path" =~ ^/[A-Za-z0-9/_-]+$ && "$smoke_path" != //* ]]
  test -d "$work" && test ! -e "$work/lease.json"
  observed=$("${queue[@]}" observe)
  jq -e --arg sha "$baseline" --arg build "$baseline_build" \
    '.runtime.state=="ok" and .runtime.backend=="canonical" and .runtime.ref==$sha and .runtime.build_id==$build' \
    >/dev/null <<< "$observed"
  node "$controller/.github/ci/staging-cutover-build.mjs" "$source" "$baseline" "$ci_controller" "$run" "$work/build"
  stamp artifact_verified_at
  packet=$("${ssh[@]}" 'mktemp -d /var/tmp/aihr-deploy/cutover-packet-XXXXXXXX')
  [[ "$packet" =~ ^/var/tmp/aihr-deploy/cutover-packet-[A-Za-z0-9]+$ ]]
  printf '%s\n' "$packet" > "$work/packet"
  (
    cd "$work/build"
    ln production-build-v1/bytes/build-bundle.tar.gz build.tar.gz
    ln production-build-v1/bytes/build-bundle-files.json build-manifest.json
    cp "$here"/prepare-runtime.sh "$here"/prepare-canonical.sh .
    tar -cf - verified.json source.tar.gz build.tar.gz build-manifest.json prepare-runtime.sh prepare-canonical.sh
  ) | "${ssh[@]}" "umask 077; tar -xf - -C '$packet'"
  stamp transfer_finished_at
  "${ssh[@]}" "bash -se -- '$packet'" <<'REMOTE'
packet=$1
bash "$packet/prepare-canonical.sh" "$packet" &
canonical=$!
trap 'kill "$canonical" 2>/dev/null || true; wait "$canonical" 2>/dev/null || true' EXIT
bash "$packet/prepare-runtime.sh" "$packet"
wait "$canonical"
trap - EXIT
REMOTE
  stamp runtime_warm_at
  "${ssh[@]}" "python3 -B '$remote_queue' prepare --packet '$packet' --smoke-path '$smoke_path' --smoke-status 307" > "$work/prepared.json"
  candidate=$(jq -er '.candidate.source' "$work/prepared.json")
  digest=$(jq -er '.candidate.artifact' "$work/prepared.json")
  ticket=$(python3 -c 'import uuid; print(uuid.uuid4())')
  jq -cn --arg id "$ticket" --arg candidate "$candidate" --arg baseline "$baseline" --arg run "$run" --arg smoke "$smoke_path" \
    '{spec:{id:$id,source:$candidate,base:$baseline,dependencies:[],risk:"ordinary",migrations:[],
      acceptance:("Signed-in feature walkthrough and signed-out redirect at "+$smoke),
      evidence:("Authenticated canonical GitHub build-only run "+$run)}}' > "$work/submit.json"
  jq -cn --arg id "$ticket" --arg candidate "$candidate" --arg baseline "$baseline" --arg build "$baseline_build" \
    '{tickets:[$id],candidate:$candidate,baseline:$baseline,baselineBuild:$build}' > "$work/prepare.json"
  "${queue[@]}" submit --request "$work/submit.json" > "$work/ticket.json"
  "${queue[@]}" prepare --worktree "$source" --request "$work/prepare.json" > "$work/batch.json"
  jq '{batch}' "$work/batch.json" > "$work/claim.json"
  printf '%s\n' "$digest" > "$work/artifact"
  stamp queue_prepared_at
  exit
fi

work=$1
shift
[[ -d "$work" && "$#" == 0 ]]
digest=$(cat "$work/artifact")
[[ "$digest" =~ ^[a-f0-9]{64}$ ]]
case "$mode" in
  activate)
    "${queue[@]}" claim --request "$work/claim.json" --lease-file "$work/lease.json" > "$work/claimed.json"
    stamp queue_claimed_at
    printf '%s\n' '{"phase":"installing"}' > "$work/installing.json"
    "${queue[@]}" phase --request "$work/installing.json" --lease-file "$work/lease.json"
    "${ssh[@]}" "python3 -B '$remote_queue' activate --artifact-digest '$digest' --lease-stdin" < "$work/lease.json" | tee "$work/activated.json"
    stamp switched_at
    ;;
  promote)
    "${ssh[@]}" "python3 -B '$remote_queue' promote --artifact-digest '$digest' --lease-stdin" < "$work/lease.json" | tee "$work/promoted.json"
    stamp canonical_verified_at
    ;;
  finish)
    test -s "$work/acceptance.json"
    observed=$("${queue[@]}" observe)
    candidate=$(jq -er .candidate.source "$work/prepared.json")
    jq -e --arg source "$candidate" '.runtime.backend=="canonical" and .runtime.ref==$source' >/dev/null <<< "$observed"
    "${ssh[@]}" "test "\$(readlink /var/lib/aihr-cutover/active.sock)" = /var/lib/aihr-cutover/canonical.sock && systemctl --user disable --now 'aihr-cutover-$digest.service' 'aihr-cutover-$digest.socket' && systemctl --user stop 'aihr-cutover-$digest-proxy.service'"
    build=$(jq -er .nextBuildId "$work/build/verified.json")
    jq -cn --arg build "$build" '{phase:"accepting",build:$build}' > "$work/accepting.json"
    "${queue[@]}" phase --request "$work/accepting.json" --lease-file "$work/lease.json"
    "${queue[@]}" finish --request "$work/acceptance.json" --lease-file "$work/lease.json" | tee "$work/finished.json"
    "${queue[@]}" observe | tee "$work/observed.json"
    stamp handed_back_at
    ;;
  *) printf 'Use prepare, activate, promote, or finish.\n' >&2; exit 2 ;;
esac
