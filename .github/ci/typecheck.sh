#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || exit 2
swapfile="$RUNNER_TEMP/aihr-tsc-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.swap"
owned_swap=0
owned_file=0
cleanup() {
  if [[ "$owned_swap" == 1 ]]; then sudo swapoff "$swapfile"; fi
  if [[ "$owned_file" == 1 ]]; then sudo rm -f -- "$swapfile"; fi
}
trap cleanup EXIT
free -b
cat /proc/swaps
physical_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
swap_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
if (( physical_kib < 12582912 && swap_kib < 4194304 )); then
  available_kib=$(df -Pk "$RUNNER_TEMP" | awk 'END {print $4}')
  (( available_kib >= 20971520 )) || { echo 'Need20GiBheadroom before bounded4GiBswap' >&2; exit 2; }
  [[ ! -e "$swapfile" ]] || exit 2
  owned_file=1
  sudo fallocate -l 4G "$swapfile"
  sudo chmod 600 "$swapfile"
  sudo mkswap "$swapfile"
  sudo swapon "$swapfile"
  owned_swap=1
fi
free -b
export NODE_OPTIONS=--max-old-space-size=8192
# Whole repository, same strict config; no file exclusions or ignored build errors.
/usr/bin/time -v pnpm exec tsc --noEmit
