#!/usr/bin/env bash
# Only unused SDKs on a disposable GitHub VM; never a developer or staging machine.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || { echo 'Disposable GitHub-hosted Linux VM required' >&2; exit 2; }
profile="${AIHR_CI_CAPACITY_PROFILE:-legacy}"
policy="$(dirname "$0")/runner-capacity.mjs"
available_kib() { df -Pk "$GITHUB_WORKSPACE" "$RUNNER_TEMP" | awk 'NR>1 { if (n==0 || $4<minimum) minimum=$4; n++ } END { if (n>0) print minimum }'; }
capacity_decision() {
  local available
  available="$(available_kib)" || return 2
  node "$policy" "$profile" "$available"
}
echo "Capacity profile: $profile; before optional SDK cleanup"
df -Pk "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
# Measured in diagnostic40177686785: 5.74+11.03+3.66GiB; these jobs use no .NET/Android/Haskell SDK.
for sdk in /usr/share/dotnet /usr/local/lib/android /usr/local/.ghcup; do
  decision="$(capacity_decision)" || exit 2
  case "$decision" in
    enough) echo 'Measured capacity is sufficient; skip unused SDK deletion.'; break ;;
    clean) ;;
    *) echo 'Unknown capacity decision' >&2; exit 2 ;;
  esac
  if [[ -d "$sdk" && ! -L "$sdk" ]]; then
    sudo du -sx -B1 "$sdk"
    sudo rm -rf -- "$sdk"
  fi
done
if [[ "$profile" != legacy ]]; then
  decision="$(capacity_decision)" || exit 2
  [[ "$decision" == enough ]] || { echo 'Insufficient capacity after fixed disposable SDK cleanup' >&2; exit 2; }
fi
echo 'Capacity after preparation; Node, pnpm, Docker, browsers and source retained'
df -Pk "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
