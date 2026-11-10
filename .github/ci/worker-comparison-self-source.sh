#!/usr/bin/env bash
# Self-source admission for the parallel worker-build and worker-cell jobs. It mirrors the
# selected-tests measured-course check: the candidate is the workflow commit itself, both
# checkouts are clean at it, and the harness members are byte-identical in both.
set -euo pipefail
job="${1:?job}"
case "$job" in worker-build|worker-cell) ;; *) echo 'Unknown parallel worker job' >&2; exit 1 ;; esac
case "${AIHR_MEASURED_BROWSER_COURSE:-}" in parallel-2-4-8|parallel-smoke) ;; *) echo 'Parallel worker course refused' >&2; exit 1 ;; esac
test "$GITHUB_JOB" = "$job"
test "$GITHUB_EVENT_NAME" = workflow_dispatch
test "$GITHUB_RUN_ATTEMPT" = 1
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$RUNNER_OS" = Linux
test "$RUNNER_ARCH" = X64
[[ "$EXPECTED_SOURCE" =~ ^[a-f0-9]{40}$ ]]
test "$AIHR_CI_HEAD" = "$EXPECTED_SOURCE"
test "$GITHUB_WORKFLOW_SHA" = "$EXPECTED_SOURCE"
test "$AIHR_CI_CONTROL_HEAD" = "$EXPECTED_SOURCE"
test "$STAGING_ENABLED" = false
test "$PRODUCTION_ENABLED" = false
test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${AIHR_EVAL_OPENROUTER_KEY:-}"
for checkout in "$GITHUB_WORKSPACE/automation" "$GITHUB_WORKSPACE/source"; do
  test "$(git -C "$checkout" rev-parse HEAD)" = "$EXPECTED_SOURCE"
  test -z "$(git -C "$checkout" status --porcelain)"
  test "$(git -C "$checkout" remote get-url origin)" = https://github.com/StradaverseHub/ai-hr
done
git merge-base --is-ancestor 9e9db2e5453663a627217513299b0e8307141a74 "$EXPECTED_SOURCE"
git merge-base --is-ancestor b698f5d35b0cca12e2c1268f3bea08d0aa1d070e "$EXPECTED_SOURCE"
for member in .github/workflows/alpha-focused-checks.yml .github/actions/setup-alpha/action.yml \
  .github/ci/postgres.sh package.json pnpm-lock.yaml scripts/performance/system-runner.mjs \
  scripts/performance/system-load.mjs scripts/performance/system-fixture.mjs \
  .github/ci/owned-process.py .github/ci/worker-comparison-family.py .github/ci/worker-comparison-aggregate.py \
  .github/ci/worker-comparison-self-source.sh .github/ci/worker-comparison-build-aliases.py .github/ci/runtime_inventory.py \
  scripts/performance/worker-comparison.mjs scripts/performance/worker-comparison-build.mjs \
  scripts/performance/worker-comparison-build.test.mjs \
  scripts/performance/worker-comparison-custody.mjs scripts/performance/system-load-owner.mjs; do
  digest="$(git show "$EXPECTED_SOURCE:$member" | sha256sum | cut -d' ' -f1)"
  printf '%s  %s\n%s  %s\n' "$digest" "$member" "$digest" "../automation/$member" | sha256sum --check --status
done
# The existing navigation owner admits this exact canonical spelling.
git remote set-url origin https://github.com/StradaverseHub/ai-hr.git
