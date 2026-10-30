# Cross-source recovery v2 — proposed, not release authority

The owner requires failed-area recovery after every planned job of a frozen gate finishes.
The existing v1 route handles unchanged-source failed no-DB units. It cannot admit a source
repair or replace a failed compiler or canonical build. This separate route must preserve
that refusal, the original failed run, and the identity of every retained success.

## Evidence flow

```text
terminal original full gate + immutable original source
                |
exact descendant repair + independently reconstructed impact
                |
unchanged valid units retained / failed or invalidated units replaced
                |
fresh whole compiler + fresh canonical Linux byte packet
                |
complete versioned certificate + reviewed verifier diagnostic
                |
fresh API/archive/source/baseline revalidation -> existing guarded installer
```

## Boundaries

- Keep normal full-gate and focused-recovery/v1 admission unchanged. Never issue a receipt
  claiming the original failed workflow passed.
- Authenticate complete first-attempt original GitHub run/job/artifact inventories and ZIP
  digests before consuming reports. Require a terminal complete plan. Preserve failed build
  diagnostics in their existing bounded, explicitly non-release namespace.
- Reconstruct both full plans from frozen Git sources, prove ancestry and exact repair tree
  delta, and independently run the existing impact policy. Changed execution infrastructure,
  test/classifier inventory, runtime, lock/package or migration prefix refuses the bounded
  route. A full impact decision invalidates all affected coverage; never downgrade it.
- Retain only successful original units whose complete membership and inputs remain valid.
  Replace the entire failed process, not its apparently passing assertions. Preserve original
  assertion inventories and producing run/job/artifact/digest identities.
- Fresh evidence names the repaired source and its real execution controller. Focused tests
  remain FOCUSED_ONLY; only the new composite verifier can account for them. A whole compiler
  must actually run. A normal focused `pnpm build` is not a canonical byte packet: use the
  existing canonical build-only route and validate its System Testing source binding.
- Unsupported affected units, incomplete failures, changed or dropped assertions, unknown
  artifacts, missing prerequisites and diagnostic/build substitution refuse. A bounded v2
  implementation must report unsupported coverage instead of declaring it unaffected.
- The certificate records original and replacement provenance separately, exact candidate,
  controller, baseline, policy/runtime/classifier, impact and complete coverage. Its digest
  binds the existing private installation grant to the replacement build's actual producer.
- Reauthenticate source, current APIs, complete archive digests and target baseline before
  transfer and launch. Keep shared lease, ordered migration ledger, source checksum, compiled
  inventory, cleanup, health, human acceptance and separate production authorization intact.

## Validation and adoption

Run dependency-free controller regressions on standard hosted Actions. Include successful
mixed-origin accounting and refusals for nonterminal originals, unauthenticated provenance,
omitted impact invalidations, source drift, altered runtime/classifier/migrations, assertion
loss, missing whole compiler, foreign build bytes and diagnostic artifact substitution.
Review the frozen controller and its hosted result before any adoption. Unit fixtures prove
the verifier's behavior; they do not prove an application release. Actual Onboarding repair
coverage cannot be decided until its original run is terminal and repaired source is frozen.

The trade-off is more provenance bookkeeping and bounded initial coverage in exchange for
retaining authenticated successes without weakening admission. Extend supported execution
types only with their real environment and evidence controls; do not turn an unsupported
case into an implicit whole-gate retry or a release exception.

## Initial implementation contract

The first v2 implementation supports modified existing product TypeScript files only, with
unchanged test inventory, SQL, security owners, dependencies and execution infrastructure.
It replaces whole affected no-DB processes using authenticated focused packets, requires at
least one fresh whole compiler, and uses a separate actual canonical build-only run. Affected
DB, browser or PDF-environment units refuse; their successful original results can be retained
only when independently unaffected. This is a limitation, not permission to reduce impact.

After the exact controller passes its hosted controls and independent review, set
`AIHR_RECOVERY_CONTROLLER_RUN_ID` to that controller-only run and
`AIHR_REPAIR_REVIEWED_CONTROLLER` to the reviewed full controller SHA. Existing SSH configuration
and, for deployment only, the shared private lease file remain required. Read-only admission:

```sh
node --import tsx .github/ci/operator-release.mjs verify-repair /ABS/CANDIDATE ORIGINAL_RUN \
  '{"originalPath":"/ABS/FROZEN_ORIGINAL","candidateBranch":"FROZEN_BRANCH","focusedRunIds":[FOCUSED_RUN],"buildRunId":CANONICAL_BUILD_ONLY_RUN}'
```

`deploy-repair` uses the same options and existing guarded installer only under the release
owner's staging authority. The original failed run is recorded separately; the installation
grant names the replacement build's actual successful run. Every original and replacement
archive is checked again before source transfer and detached launch. Latest execution history
must contain exactly the supplied successful replacement runs for the frozen candidate branch;
unaccounted failed, pending or superseding executions refuse. This route does not dispatch tests,
change branches, claim a lease, accept staging or authorize production.
