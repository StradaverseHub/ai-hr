#!/usr/bin/env bash
# Job-local swap for the isolated System Labels browser process on a disposable hosted VM.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
   "${GITHUB_JOB:-}" == test && "${GITHUB_RUN_ATTEMPT:-}" == 1 &&
   "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && $# == 3 &&
   "${AIHR_CI_HEAD:-}" == bee0a72b0cb2f14710d7b9f6897703074dfc3a58 &&
   "${AIHR_CI_CONTROL_HEAD:-}" =~ ^[a-f0-9]{40}$ &&
   "$1" == db-cc251cbe6920741e && "$2" == "$RUNNER_TEMP/aihr-ci" &&
   "$(uname -s)" == Linux ]]
controller_runner=$3
[[ "$controller_runner" == ../automation/.github/ci/run-unit.mjs && -f "$controller_runner" ]]
available_kib=$(df -Pk "$RUNNER_TEMP" | awk 'END {print $4}')
[[ "$available_kib" =~ ^[0-9]+$ && "$available_kib" -ge 12582912 ]]
swap_dir=$(mktemp -d "$RUNNER_TEMP/aihr-system-label-swap.XXXXXX")
swapfile="$swap_dir/host.swap"
owned_swap=0
cleanup() {
  local code=$? cleaned=false
  trap - EXIT
  if (( owned_swap )); then sudo swapoff "$swapfile" || { (( code != 0 )) || code=1; }; fi
  if ! awk -v file="$swapfile" '$1==file { found=1 } END { exit !found }' /proc/swaps; then
    if sudo rm -f -- "$swapfile" && rmdir -- "$swap_dir"; then cleaned=true; fi
  fi
  [[ "$cleaned" == true ]] || { (( code != 0 )) || code=1; }
  (
    umask 077
    set -o noclobber
    printf '{"kind":"OWNED_ISOLATED_SYSTEM_LABEL_BROWSER_HOST_SWAP","runId":%s,"attempt":1,"unit":"db-cc251cbe6920741e","source":"%s","controller":"%s","hostSwapBytes":4294967296,"databaseSwapChanged":false,"ownedSwap":%s,"cleanupVerified":%s,"exitCode":%s}\n' \
      "$GITHUB_RUN_ID" "$AIHR_CI_HEAD" "$AIHR_CI_CONTROL_HEAD" "$owned_swap" "$cleaned" "$code" \
      > "$2/system-label-host-swap.json"
  ) || { (( code != 0 )) || code=1; }
  exit "$code"
}
report_target=$2
trap 'cleanup "$1" "$report_target"' EXIT
mkdir -p "$report_target"
sudo fallocate -l 4G "$swapfile"
sudo chmod 600 "$swapfile"
sudo mkswap "$swapfile"
sudo swapon "$swapfile"
owned_swap=1
awk -v file="$swapfile" '$1==file && $3>=4194300 && $3<=4194304 { found=1 } END { exit !found }' /proc/swaps
node "$controller_runner" "$1" "$2"
