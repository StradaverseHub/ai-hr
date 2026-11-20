# Exact-source recovery for failed test units (v6)

This is an independently reviewed operator controller, not a new application gate or automatic deployment.
It adapts the existing exact-source v3 architecture from `7bc5b7d5` to the current published controller.
The application checkout, original failed run, successful compiled build and original unit reports remain immutable.

After every original job has finished, rerun each complete failed Node/database unit on its unchanged source.
The focused workflow must run through an authenticated published controller, with the original runtime,
classifier, complete file/case inventory, healthy runner and fresh owned PostgreSQL evidence. Database capacity,
JIT, actual PostgreSQL patch level and capture chronology must reconcile. Missing, skipped, duplicate,
changed, failed or zero-case replacements refuse. Failed processes supply case inventories, never inferred passes.
Successful unaffected units retain their original producing jobs, artifact digests and report hashes.
Complete execution history rejects unaccounted, later-failed, pending or rerun attempts.

The focused workflow accepts up to 64 files. A larger failed no-database unit
is rerun in disjoint partitions. Each partition belongs to one failed unit and
the union must account for every original file and assertion exactly once.
Database units still rerun as a single unit. The focused route refuses PDF
tooling units, which require their original environment evidence.

Focused runs can use bound aliases named `<candidate-ref>-recovery-<original-run-id>-<1–64>`.
Before verification the aliases must still resolve to the frozen candidate.
Recovery checks the execution history for the original ref and every reserved
alias, including active runs and failed runs missing from the supplied IDs.

The distinct certificate is `aihr-exact-source-recovery/v6`. It records the original producing controller
separately from the verification controller and each focused producer. It does not rewrite the original failure,
issue a fabricated original PASS or reuse a compiled build on another source. The operator validates the new
certificate before creating the existing format-2 installation grant. The receiver's policy, exact grant shape,
target, source/build identity, capacity and original 24-hour/30-minute time bounds are unchanged.
Hosted controls load the real baseline receiver to prove this transport boundary.

## Interrupted System Labels job

The payroll gate 44653948000 has a failed no-database unit with its original
report and one interrupted System Labels database job with no report. The
dedicated recovery workflow runs the complete System Labels unit on the same
application source. It recreates the original database, font and test steps.
Verification compares its assertions against authenticated prior evidence with
the identical test file. The prior result establishes the assertion inventory.
The replacement run must independently pass the complete database unit.

Supply the dedicated run ID in `AIHR_EXACT_MISSING_RUN_ID`. The verifier binds
its producing controller, archive and host receipts alongside the focused
runs. The original interrupted unit has no result in the certificate.

## Pinned documentation advance

An explicit `AIHR_EXACT_RECOVERY_DOCS_HEAD` may name one independently reviewed canonical commit after the
original producer. Both freshly queried main and alpha must equal that exact pin. The immutable Git delta must
modify only the two existing regular non-executable documents `docs/adr/0024-multi-cycle-payroll.md` and
`docs/architecture/STATUTORY-SOURCES.md`, in one commit. The proof records both trees, blob identities,
byte hashes and complete diff hash. No application, test, migration, controller or runtime input may change.
The focused producer keeps its actual documentation-advance SHA; it is never relabelled as the original producer.
The built candidate keeps its original SHA. Revalidation repeats this proof before installation.
Later integration preserves both histories through normal merges; a resulting merge is not called the gated build.

## Operator use

Freeze the recovery-only controller. Its controller-only Actions diagnostic must execute the refusal tests and
extractor tests, and an independent reviewer must approve that exact controller SHA. Set
`AIHR_RECOVERY_CONTROLLER_RUN_ID`, `AIHR_EXACT_RECOVERY_REVIEWED_CONTROLLER` and, when needed, the exact
documentation head. Invoke `operator-release.mjs verify-exact-recovery` with the unchanged candidate directory,
original full run ID and JSON focused run IDs. `deploy-exact-recovery` additionally requires the authorized
matching staging lease. Existing environment, migration prefix, build-byte, source-arrival, service-health and
cleanup checks remain mandatory. Failed or unsupported recovery remains blocked.

Focused archives retain bounded declared PostgreSQL, setup, timing and native Carry diagnostics inside their
authenticated original ZIP. Only the two core JSON result/identity members are extracted as accounting inputs.
Diagnostics do not replace assertions or enlarge any runtime/dataset/deadline allowance.
