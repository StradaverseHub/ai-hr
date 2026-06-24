#!/bin/bash
# Watch for approved feedback + notify (ADR-0045, the SAFE 24/7 trigger). Read-only: it polls the server for
# items reporters have approved and posts a macOS notification when there are any. It does NOT build, does NOT
# write code, does NOT release, and runs NO autonomous agent — the build/preview/release all happen later in
# an interactive Claude session. Run by launchd every 4h.
#
# Disable:  launchctl unload ~/Library/LaunchAgents/com.aihr.improve-build.plist
set -uo pipefail

REPO="/Users/zenlam/Projects/ai-hr"
# launchd gives a minimal environment — set an explicit PATH for node/pnpm/ssh.
export PATH="/Users/zenlam/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/zenlam"

cd "$REPO" || exit 1
mkdir -p "$REPO/.improve"
LOG="$REPO/.improve/watch.log"

# `improve:pull-approved` is a read-only SELECT on the server; count the returned JSON array with node (no jq).
COUNT=$(node --import tsx scripts/improve/cli.ts pull-approved 2>>"$LOG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log(0)}})')
COUNT="${COUNT:-0}"
echo "$(date): approved=$COUNT" >>"$LOG"

if [ "$COUNT" -gt 0 ]; then
  osascript -e "display notification \"$COUNT feedback item(s) approved — open Claude to build, preview & release\" with title \"ai-hr improvement loop\" sound name \"Glass\"" 2>>"$LOG" || true
fi
