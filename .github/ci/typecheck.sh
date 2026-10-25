#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || exit 2
case "${1:-}" in ""|--incremental-diagnostic|--state-transport-producer|--state-transport-consumer) (( $# <= 1 )) || exit 2 ;; *) exit 2 ;; esac
compiler_mode="${1:-}"
swapfile="$RUNNER_TEMP/aihr-tsc-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.swap"
owned_swap=0
owned_file=0
cleanup() {
  local entry_exit=$?
  if [[ "$compiler_mode" == --state-transport-producer || "$compiler_mode" == --state-transport-consumer ]]; then
    local cleanup_exit=0 swap_absent=true file_absent=true active_state
    if [[ "$owned_swap" == 1 ]]; then
      sudo swapoff "$swapfile" || cleanup_exit=1
    fi
    if active_state=$(awk -v path="$swapfile" '$1==path { found=1 } END { print found ? 1 : 0 }' /proc/swaps); then
      case "$active_state" in 0) ;; *) swap_absent=false; cleanup_exit=1 ;; esac
    else
      swap_absent=false
      cleanup_exit=1
    fi
    # Never unlink an active or unobserved swap file, even when its creation was ours.
    if [[ "$owned_file" == 1 && "$swap_absent" == true ]]; then
      sudo rm -f -- "$swapfile" || cleanup_exit=1
    fi
    [[ ! -e "$swapfile" ]] || { file_absent=false; cleanup_exit=1; }
    (
      umask 077
      set -o noclobber
      printf '{"kind":"OWNED_COMPILER_SWAP_CLEANUP","runId":"%s","attempt":"%s","mode":"%s","ownedSwap":%s,"ownedFile":%s,"swapAbsent":%s,"fileAbsent":%s,"originalCommandExit":%s,"cleanupExit":%s}\n' \
        "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$compiler_mode" "$owned_swap" "$owned_file" "$swap_absent" "$file_absent" "$entry_exit" "$cleanup_exit" \
        > "$RUNNER_TEMP/compiler-transport-swap-cleanup.json"
    ) || cleanup_exit=1
    if (( entry_exit != 0 )); then return "$entry_exit"; fi
    return "$cleanup_exit"
  fi
  if [[ "$owned_swap" == 1 ]]; then sudo swapoff "$swapfile"; fi
  if [[ "$owned_file" == 1 ]]; then sudo rm -f -- "$swapfile"; fi
}
trap cleanup EXIT
minimum_swap_kib=20971520
if [[ "${AIHR_CI_CAPACITY_PROFILE:-legacy}" == bounded-compiler-diagnostic ]]; then
  [[ "$compiler_mode" == --state-transport-consumer ]] || exit 2
  minimum_swap_kib=$(node "$(dirname "$0")/runner-capacity.mjs" compiler-swap-floor bounded-compiler-diagnostic)
fi
echo "Compiler storage floor before owned swap: ${minimum_swap_kib} KiB"
df -Pk "$RUNNER_TEMP"
free -b
cat /proc/swaps
physical_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
swap_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
if (( physical_kib < 12582912 && swap_kib < 4194304 )); then
  available_kib=$(df -Pk "$RUNNER_TEMP" | awk 'END {print $4}')
  (( available_kib >= minimum_swap_kib )) || { echo "Need ${minimum_swap_kib} KiB free before bounded4GiBswap" >&2; exit 2; }
  [[ ! -e "$swapfile" ]] || exit 2
  owned_file=1
  sudo fallocate -l 4G "$swapfile"
  sudo chmod 600 "$swapfile"
  sudo mkswap "$swapfile"
  sudo swapon "$swapfile"
  owned_swap=1
fi
df -Pk "$RUNNER_TEMP"
free -b
export NODE_OPTIONS=--max-old-space-size=8192
# Whole repository, same strict config; no file exclusions or ignored build errors.
if [[ "${1:-}" == --state-transport-producer ]]; then
  node "$(dirname "$0")/diagnostics/compiler-transport.mjs" producer
elif [[ "${1:-}" == --state-transport-consumer ]]; then
  node "$(dirname "$0")/diagnostics/compiler-transport.mjs" consumer
elif [[ "${1:-}" == --incremental-diagnostic ]]; then
  node "$(dirname "$0")/diagnostics/compiler-incremental.mjs"
else
  /usr/bin/time -v pnpm exec tsc --noEmit
fi
