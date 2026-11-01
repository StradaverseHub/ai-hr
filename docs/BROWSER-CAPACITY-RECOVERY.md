# Exact-source Firefox capacity recovery

This separately versioned, read-only verifier implements the owner's failed-area-only recovery
policy for a complete frozen gate whose sole failed application unit is Firefox admission below
the existing 20 GiB disk guard. The failed process must have executed zero batches. Failed tests,
other engines, compiler/build/migration/controller failures and changes to source or runtime refuse.
No installation-grant or deployment route is added. Normal source, security/data, live profile and
ordered migration-ledger checks remain mandatory. This certificate alone cannot install a build.

Freeze an owned controller descended from the original trusted controller. Only the recovery
adapter/policy/tests, operator verification routing, two workflow files and this document may differ;
application files, dependencies, unit runner, browser setup and resource guards must be unchanged.
Run `alpha-staging.yml` with controller_only=true, diagnostics_only=true and identical frozen
controller/candidate. All existing integrity checks plus recovery refusal tests must pass.

After every original gate chunk has finished, dispatch `alpha-staging-browser-checks.yml` from that
controller with the original frozen candidate_ref/expected_sha and
probe_scope=browser-image-suite-firefox. It runs the unchanged complete Firefox unit on a standard
GitHub-hosted Ubuntu24 runner in the same digest-pinned Playwright1.62.1 image, Node22.23.3,
Linuxx64, en_US.UTF-8 and Asia/Kuala_Lumpur. The unchanged 20 GiB admission guard applies before
execution; the independent verifier also requires healthy completion. Both full coverage and runtime
bindings are retained as bounded JSON-only artifacts with releaseAuthorized=false.

Use the read-only canonical operator route:

```
AIHR_RECOVERY_CONTROLLER_RUN_ID=<controller-only-run> \
AIHR_CI_PREFETCH_DIR=<optional-private-original-archives> \
node --import tsx .github/ci/operator-release.mjs verify-browser-recovery \
  <unchanged-candidate-worktree> <original-full-run> \
  '{"browserRunId":123,"candidateBranch":"codex/source","controllerBranch":"codex/controller","auxiliaryRunIds":[]}'
```

The verifier independently authenticates complete API inventories, repository/workflow/controller,
first attempts, source branches, producing job chronology, digests and bounded archive bytes. It
reconstructs the actual candidate classifier/complete inventory, validates every retained original
unit, verifies the full replacement with its own honest controller/plan fingerprint, binds the
original successful production build to candidate inputs, checks relevant run history and rereads
API identities before admission. List any overlapping successful focused runs in auxiliaryRunIds;
pending, failed, omitted or superseding relevant executions refuse. Main/alpha must still identify
the actual deployed baseline or the unchanged candidate.

The distinct AUTHENTICATED_BROWSER_CAPACITY_RECOVERY certificate records original failure,
original and fresh plan fingerprints, original successful unit/run/job/artifact digests, complete
fresh Firefox provenance and the verifier's hosted integrity run. It never creates a normal
ci-receipt.json, rewrites a report or changes the original workflow conclusion. The operator adds
its real read-only staging profile and baseline migration-ledger preflight. IT's Entra consent,
hybrid directory environment and physical-device acceptance remain separate from source checks.
