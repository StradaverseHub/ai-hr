#!/usr/bin/env bash
# Only unused SDKs on a disposable GitHub VM; never a developer or staging machine.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || { echo 'Disposable GitHub-hosted Linux VM required' >&2; exit 2; }
profile="${AIHR_CI_CAPACITY_PROFILE:-legacy}"
policy="$(dirname "$0")/runner-capacity.mjs"
capacity_paths=("$GITHUB_WORKSPACE" "$RUNNER_TEMP")
sdk_paths=(/usr/share/dotnet /usr/local/lib/android /usr/local/.ghcup)
if [[ "$profile" == bounded-suite-setup || "$profile" == bounded-suite-ready ]]; then
  node "$policy" "$profile" 0 >/dev/null # Validate scope before any Docker/SDK action.
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  [[ "$docker_root" = /* && "$docker_root" != / && "$docker_root" != *$'\n'* && -d "$docker_root" ]] || { echo 'Actual Docker filesystem unavailable' >&2; exit 2; }
  capacity_paths+=("$docker_root")
  sdk_paths=(/usr/local/lib/android /usr/local/.ghcup /usr/share/dotnet)
fi
available_kib() { df -Pk "${capacity_paths[@]}" | awk 'NR>1 { if (n==0 || $4<minimum) minimum=$4; n++ } END { if (n>0) print minimum }'; }
capacity_decision() {
  local available
  available="$(available_kib)" || return 2
  node "$policy" "$profile" "$available"
}
echo "Capacity profile: $profile; before optional SDK cleanup"
df -Pk "${capacity_paths[@]}"
# Measured in diagnostic40177686785: 5.74+11.03+3.66GiB; these jobs use no .NET/Android/Haskell SDK.
for sdk in "${sdk_paths[@]}"; do
  decision="$(capacity_decision)" || exit 2
  case "$decision" in
    enough) echo 'Measured capacity is sufficient; skip unused SDK deletion.'; break ;;
    clean) ;;
    *) echo 'Unknown capacity decision' >&2; exit 2 ;;
  esac
  if [[ -d "$sdk" && ! -L "$sdk" ]]; then
    sdk_started=$SECONDS
    echo "Unused SDK cleanup begins: $sdk"
    sudo du -sx -B1 "$sdk"
    sudo rm -rf -- "$sdk"
    echo "Unused SDK cleanup completed: $sdk; wall-seconds=$((SECONDS-sdk_started))"
  fi
done
if [[ "$profile" != legacy ]]; then
  decision="$(capacity_decision)" || exit 2
  [[ "$decision" == enough ]] || { echo 'Insufficient capacity after fixed disposable SDK cleanup' >&2; exit 2; }
fi
echo 'Capacity after preparation; Node, pnpm, Docker, browsers and source retained'
df -Pk "${capacity_paths[@]}"
