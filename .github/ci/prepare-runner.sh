#!/usr/bin/env bash
# Only unused SDKs on a disposable GitHub VM; never a developer or staging machine.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || { echo 'Disposable GitHub-hosted Linux VM required' >&2; exit 2; }
echo 'Capacity before removing unused preinstalled SDKs'
df -Pk "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
# Measured in diagnostic40177686785: 5.74+11.03+3.66GiB; these jobs use no .NET/Android/Haskell SDK.
for sdk in /usr/share/dotnet /usr/local/lib/android /usr/local/.ghcup; do
  if [[ -d "$sdk" && ! -L "$sdk" ]]; then
    sudo du -sx -B1 "$sdk"
    sudo rm -rf -- "$sdk"
  fi
done
echo 'Capacity after SDK cleanup; Node, pnpm, Docker, browsers and source retained'
df -Pk "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
