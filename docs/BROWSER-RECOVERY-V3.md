# Single-shot browser recovery v3 — proposed, review only, not release authority

[ADR-0175](adr/0175-first-time-right-releases.md) decision 4(a) and the owner's 30 October rule (rerun only failed areas after a complete frozen gate) apply to the case the existing routes refuse: **one browser engine unit that actually executed tests and failed**, while every other job passed.

| Route | Admits |
| --- | --- |
| `aihr-focused-recovery/v1` | failed no-DB units only |
| `aihr-browser-capacity-recovery/v2` | a Firefox unit that executed **zero** tests because of the 20 GiB disk guard |
| `aihr-cross-source-recovery/v2` | refuses every affected browser unit |
| **`aihr-browser-recovery/v3`** (this proposal) | one executed browser failure, rerun once, on the unchanged candidate |

## What v3 admits

All of the following must hold. Each one is a named check in `.github/ci/browser-recovery-v3-policy.mjs`.

1. **Original failure.** A completed, first-attempt, failed full gate. Exactly one failed area, and it is a browser engine unit with a single-engine scope (Firefox today). Every other required job succeeded; only `verify` failed as a consequence.
   - The failed report executed tests: it has batches, no process error, and `healthBefore.ok`. Capacity failures stay on v2.
   - Every unit file is enumerated with named cases.
2. **Fresh engine unit, once.** `alpha-staging-browser-checks.yml` with `probe_scope=browser-image-suite-firefox` reruns the **complete** original engine unit. It runs from the reviewed controller, in the same digest-pinned Playwright image, Node 22.23.3, `en_US.UTF-8` and `Asia/Kuala_Lumpur` as the gate's own `browser` job. It needs a successful first attempt, a healthy runner, the same files and the same case names.
3. **Single shot.** Every execution of that engine unit since the original run is read back, in both the gate and the browser workflow, from any branch. Its candidate comes from that run's own digest-verified artifact. The rules:
   - exactly one execution of the candidate is allowed: the supplied recovery;
   - a second execution refuses, including earlier diagnostics dispatched from another ref;
   - so does a pending execution, or one whose candidate can't be read;
   - after a refusal, fix the source; never retry.
4. **Outside the impact set.** On the immutable Git objects of baseline..candidate, the forward static import closure of each failing file (from the ADR-0114 classifier) must contain:
   - no changed path;
   - no global input: package or lock files, vitest/playwright/next/tsconfig/postcss/tailwind configs, CSS, `public/`, or test setup files;
   - no unresolvable dynamic load.

   A failing file with no resolved graph counts as inside.
5. **Registered flake.** Each failing file appears, backquoted, in the verification controller's `docs/FLAKY-TESTS.md`.
6. **Frozen identities.** The rules:
   - the verifier and producer controllers descend from the original gate controller and differ only in the v3 files, `alpha-staging.yml` (the integrity test list) and the register;
   - both have successful hosted controller-only diagnostics;
   - the recovery ref still points at the candidate, the controller branches at their SHAs, and main/alpha at the baseline or candidate;
   - every retained unit's report hash and provenance is unchanged.

## What v3 never does

- It never changes or relabels the original failed run.
- It never uses `gh run rerun`.
- It never re-runs a failed recovery.
- It never contacts staging or builds an installation grant.

The certificate always says `installationEligible:false` and `releaseAuthorized:false`. `ci-install-grant.mjs` and `operator-release.mjs` are unchanged and do not accept it. An installation route can be added only after independent review of this frozen controller, plus a fresh whole validation witness under CI policy change control.

## Read-only diagnosis

```sh
AIHR_RECOVERY_CONTROLLER_RUN_ID=<controller-only run of this controller> \
node --import tsx .github/ci/browser-recovery-v3.mjs diagnose /ABS/UNCHANGED/CANDIDATE <original run> \
  '{"baseline":"<plan migrationBase>","browserRunId":<fresh run>,"recoveryRef":"<owned ref at the candidate>","controllerBranch":"<this controller branch>","browserProducerController":"<sha>","browserProducerBranch":"<branch>","producerDiagnosticRunId":<controller-only run>}'
```

It returns either `AUTHENTICATED_BROWSER_SINGLE_SHOT_RECOVERY` with `RECOVERED_PENDING_ADOPTION`, or `BROWSER_SINGLE_SHOT_DIAGNOSTIC` with `REFUSED` and every check's outcome. It writes private evidence under the controller's ignored `scratchpad/`.

## Open review questions

- **Register location.** The register is read from the verification controller, so registering a new flake means a reviewed controller update. The alternative is reading it from main, which conflicts with the frozen-ref rule.
- **Other engines.** Chromium and WebKit need single-engine suite scopes that upload a runtime binding, which is a browser-workflow change.
- **Static closure limits.** The closure follows static and literal-dynamic imports. Files with computed loads anywhere in the closure refuse, rather than being resolved.
