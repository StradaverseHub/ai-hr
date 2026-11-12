#!/usr/bin/env bash
# Re-run the populated production upgrade rehearsal (test/production-upgrade-rehearsal.test.ts) against any release SHA
# on a standard GitHub-hosted runner. Fictional data on a disposable CI database; it never connects to an installation.
#
# USAGE
#   scripts/production-upgrade-rehearsal.sh <release-sha> [rehearsal-source-ref]
#
#   release-sha           the exact 40-character release candidate (for example the next version's final SHA)
#   rehearsal-source-ref  where the rehearsal files come from when <release-sha> lacks them
#                         (default origin/claude/production-prep-20261112)
#
# It pushes branch rehearsal/prod-upgrade-<sha12>: <release-sha> itself when it already contains the rehearsal, or
# <release-sha> plus ONE commit adding only the rehearsal files and a target.json naming <release-sha>. The test refuses a
# candidate that differs from target.json's SHA by anything else, so the verdict is about that release's migrations and
# deploy scripts byte for byte. It then dispatches alpha-focused-checks with the rehearsal as the only selected test,
# prints the run URL and exits; watch with `gh run watch <id>`. The verdict is in the run's focused-development-evidence
# artifact as production-upgrade-rehearsal.json. A focused pass is its own claim, never release authority.
#
# Production baseline inputs (installed source, ledger length, watermark, digest, purpose owners) live in
# test/fixtures/production-upgrade/rehearsal.json. Update them from the owner's read-only preflight when production
# moves; never from a guess.
set -euo pipefail
TARGET="${1:?usage: $0 <release-sha> [rehearsal-source-ref]}"
SOURCE="${2:-origin/claude/production-prep-20261112}"
REPO=StradaverseHub/ai-hr
FILES=(scripts/production-upgrade-rehearsal.sh test/production-upgrade-rehearsal.test.ts test/helpers/installed-role-topology.ts
  test/fixtures/production-upgrade/populate-baseline.mts test/fixtures/production-upgrade/rehearsal.json)
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "release-sha must be a full 40-character SHA" >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" fetch --quiet origin "$TARGET" 2>/dev/null || git -C "$ROOT" fetch --quiet origin
git -C "$ROOT" cat-file -e "$TARGET^{commit}" || { echo "unknown commit $TARGET" >&2; exit 2; }
BRANCH="rehearsal/prod-upgrade-${TARGET:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
git -C "$ROOT" worktree add --quiet --detach "$WORK" "$TARGET"
cd "$WORK"
TARGET_IN_FILE=""
if git cat-file -e "$TARGET:test/fixtures/production-upgrade/target.json" 2>/dev/null; then
  TARGET_IN_FILE="$(git show "$TARGET:test/fixtures/production-upgrade/target.json" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).releaseTarget))')"
fi
if [ "$TARGET_IN_FILE" != "$TARGET" ]; then
  git fetch --quiet origin "${SOURCE#origin/}" || true
  git checkout --quiet "$SOURCE" -- "${FILES[@]}"
  # The DBA prerequisite and cleanup are release files: rehearse the release's own copy when it has one.
  for SQL in deploy/runner-control/release-rewards-roles-prerequisite.sql deploy/runner-control/release-rewards-roles-cleanup.sql; do
    if ! git cat-file -e "$TARGET:$SQL" 2>/dev/null; then git checkout --quiet "$SOURCE" -- "$SQL"; git add -- "$SQL"; fi
  done
  mkdir -p test/fixtures/production-upgrade
  printf '{"releaseTarget":"%s","note":"Overlay written by scripts/production-upgrade-rehearsal.sh; the candidate may differ from this SHA only by the rehearsal files."}\n' "$TARGET" > test/fixtures/production-upgrade/target.json
  git add -- "${FILES[@]}" test/fixtures/production-upgrade/target.json
  git -c user.name="$(git config user.name || echo rehearsal)" -c user.email="$(git config user.email || echo rehearsal@example.invalid)" \
    commit --quiet -m "Overlay the populated production upgrade rehearsal on ${TARGET:0:12}" -m "Adds only the rehearsal files; release bytes unchanged."
fi
HEAD_SHA="$(git rev-parse HEAD)"
git push --quiet origin "HEAD:refs/heads/$BRANCH"
echo "candidate: $BRANCH @ $HEAD_SHA (release target $TARGET); controller ${AIHR_REHEARSAL_CONTROLLER_REF:-$BRANCH}"
# The controller (workflow and .github/ci) comes from AIHR_REHEARSAL_CONTROLLER_REF, default the candidate branch;
# docs/SCALE-AND-RELEASE-RULES.md rule 16 dispatches focused runs from main.
CONTROLLER="${AIHR_REHEARSAL_CONTROLLER_REF:-$BRANCH}"
gh workflow run alpha-focused-checks.yml --repo "$REPO" --ref "$CONTROLLER" \
  -f candidate_ref="$BRANCH" -f expected_sha="$HEAD_SHA" -f selected_tests='["test/production-upgrade-rehearsal.test.ts"]'
sleep 8
gh run list --repo "$REPO" --workflow alpha-focused-checks.yml --branch "$CONTROLLER" --limit 1 --json databaseId,url,status \
  --jq '.[0] | "run \(.databaseId) \(.status) \(.url)"'
