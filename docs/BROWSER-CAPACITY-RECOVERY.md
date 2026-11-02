# Exact-source Firefox capacity recovery

The v2 verifier (retaining the original read-only v1 evidence) implements the owner's failed-area-only recovery
policy for a complete frozen gate whose sole failed application unit is Firefox admission below
the existing 20 GiB disk guard. The failed process must have executed zero batches. Failed tests,
other engines, compiler/build/migration/controller failures and changes to source or runtime refuse.
Installation additionally requires an exact reviewed operator controller, both hosted controller diagnostics, independently authenticated original/fresh evidence and revalidation, the current queue lease and the existing fixed-format original-build grant. Normal source, security/data, live profile, ordered ledger, preserved baseline, source/build arrival and owned cleanup checks remain mandatory. Source verification alone cannot install a build.

Freeze an owned controller descended from the original trusted controller. Only the recovery
adapter/policy/tests, operator verification routing, existing grant construction, their preflight/refusal regressions, two workflow files and this document may differ;
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
  '{"browserRunId":123,"candidateBranch":"codex/source","controllerBranch":"codex/controller","browserProducerController":"FULL_ORIGINAL_BROWSER_CONTROLLER","browserProducerBranch":"codex/producer","producerDiagnosticRunId":456,"auxiliaryRunIds":[]}'
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

## Reviewed v2 installation admission

The original passing Firefox producer retains its actual controller, branch, hosted diagnostic and
plan fingerprint; a later operator/grant repair never relabels it. The current operator controller
gets its own controller-only validation. Reconstruct and authenticate all original and replacement
metadata/archives against the unchanged application source before verification and again immediately
before pending/transfer and launch. Both producer and verifier changes are bounded to reviewed CI
recovery/grant files; application, unit runner, dependencies and resource guards stay unchanged.

After source review, set AIHR_BROWSER_REVIEWED_CONTROLLER to the exact operator SHA. V2 grants refuse
v1 read-only certificates, pending review, missing or mismatched producer/verifier diagnostics,
changed source/build identity or original conclusions. deploy-browser-recovery uses the existing
lease and operator spine, unchanged fixed-format installation grant, original successful build and
actual baseline/environment binding. No receiver compatibility decoder or new grant format is added.
Set AIHR_STAGING_LEASE_FILE to the claimed exact-source lease and retain it through automated safe
acceptance and handback. Deployment authorization does not enable Microsoft sign-in, provisioning,
worker services, tenant consent or directory permissions. Those remain explicitly commissioned IT
operations. No production or package publication is authorized by this staging-only admission.

## Review draft for the executed Firefox assertion on a028

The separate `aihr-browser-executed-assertion-recovery/v1` policy is closed to source and MAIN
controller `a02845ba82a530ddd264f6eff1466bc106704052`, original run 41526423926, original Firefox job
125556067102 and stock MAIN replay 41529495273. The original controller-tests job and prerequisite
stop identify the original producer and derived verification failure. Both runs use the original
controller's pinned browser image, setup action, runner and candidate. The independently reviewed
verifier has its own exact SHA and successful hosted controller-only run with refusal tests.

The policy compares the authenticated original and replay file and case inventories. It requires
35 files, 516 executed cases, the named Assignment rules matcher failure in the original, and a
passing status for every replay case. Vitest reports the pre-existing Tailwind expected-failure
fixture as passing. That case remains in both inventories. The inventory hash uses a sorted array
of JSON strings encoding relative file, full name, title and ancestor titles, preserving each
occurrence. The complete report and standalone batch and health JSON members must agree. The
certificate retains the original failed job, artifact and report hash alongside the replay
producer and the 74 original successful units. The original compiler, migrations and build
remain bound by the existing source, history and build checks.

For review, the existing verify-browser-recovery options require the explicit recoveryPolicy above,
browserProducerBranch main, the exact a028 browserProducerController, and the unchanged candidate
branch codex/board-nine-final-repair-20261103. The original controller job supplies the producer
proof for this case. Set the verifier's independent review and hosted diagnostic identities
through the existing AIHR_BROWSER_REVIEWED_CONTROLLER and AIHR_RECOVERY_CONTROLLER_RUN_ID inputs.
The existing browser operator path revalidates the same policy before transfer and launch and
uses the original format 2 grant and staging lease. This draft awaits independent review and
hosted qualification. The capacity v2 route continues to reject executed failures.
