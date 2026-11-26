# Release recovery routes review — 24 November 2026

Independent review of two release-controller recovery routes built on 23 November 2026, and of two pre-existing recovery defects. Branch `claude/recovery-routes-review-20261124`, based on `origin/main` `933668246`.

| Route | Source branch | Commits | Policy | Modes |
|---|---|---|---|---|
| DB-unit recovery | `claude/db-unit-recovery-20261123` | `1e989e68f`, `09093a553` | `aihr-db-unit-recovery/v1` | `verify-db-unit-recovery`, `deploy-db-unit-recovery` |
| Build-capacity recovery | `claude/build-only-recovery-20261123` | `fafa6c704`, `243d4a63b` | `aihr-build-capacity-recovery/v1` | `verify-build-recovery`, `deploy-build-recovery` |

Both were merged into this branch. The conflicts in `operator-release.mjs`, `ci-install-grant.mjs`, `staging-preflight.test.mjs`, `alpha-staging.yml` and the CI policy document were resolved so that both modes coexist.

## Method

- I read both branches as built, the shared code they rely on (`focused-recovery*.mjs`, `resume-source.mjs`, `repair-recovery-policy.mjs`, `ci-install-grant.mjs`, `operator-release.mjs`, `build-heap.mjs`, `next-application-cache.mjs`) and the existing refusal tests.
- I queried the GitHub API for the runs used in the 23 November DB-unit release:
  - original gate `45191515984`
  - focused rerun `45201472834`
  - verifier controller diagnostic `45205259210`
  - cancelled later gate `45200846990`
  - earlier gate `45187793223` (build failed on the memory floor)
- I downloaded and inspected these artifacts: the original gate plan, the failed unit report, the focused DB packet and the real `next-application-build-failure` upload.

## Effect on the release already installed (candidate `9336682460`)

None of the confirmed DB-unit defects let anything unsafe through in that release. The actual inputs were checked one by one:

- **Original gate `45191515984`.** The controller was `13877b505`, on `main`, first attempt. Of the 111 jobs, only `test (db-ea8c926fb5a437f7)` and the dependent `verify` failed, and `runner-diagnostics` was skipped. The failed unit contains one file, `test/operational-visual-browser.test.ts`, with one case. The case and the file both failed, and the process exit code was 1.
- **Focused rerun `45201472834`.** It ran on the same controller (`13877b505`, `main`), first attempt, with candidate `9336682460ff8bad3c6b745d7cf8029c2b7e918f`. The file list was exactly that one file, in a homogeneous DB partition. The one case passed under the identical name. The database container was `aihr-ci-45201472834-1-db-1`, with `oom` and `oom_kill` both 0 and a peak of 886,050,816 bytes.
- **Verifier controller `09093a553`.** Its difference from the gate controller `13877b505` is exactly the route's own reviewed files and wiring (reviewed here). Nothing in the wiring weakens an existing check.
- **Cancelled later gate `45200846990`.** It ran on the same source and controller. Its jobs: 8 succeeded, 101 were cancelled, 1 was skipped, and only the dependent `verify` failed. No test, build or browser job failed.
- **Browser-tooling runs.** None ran for `claude/combined-board-3items-20261123` after the original gate.
- **Earlier gate `45187793223`.** It failed only in `build`, on the memory floor. It completed before the original gate finished and is recorded as overlapping. No failure evidence on the identical source was ignored.

## Confirmed defects (fixed on this branch, with refusal tests)

### DB-unit route (`aihr-db-unit-recovery/v1`)

**DB-1. A one-gate owner approval became a standing approval.**
- **Problem.** `DB_UNIT_OWNER_DECISION` (the 23 November quotes) was bound into every future certificate. Nothing tied it to the gate it approved. Any later DB-unit failure would have carried words the owner gave for gate `45191515984` ("Just use gate 4, re test the failed one…").
- **Fix.** The bound decision now names its gate and candidate, and refuses for any other gate. Any other gate needs a per-gate `ownerApproval` (`date` and `quotes`) in the options. That approval is bound verbatim and labelled `OPERATOR_RECORDED_OWNER_APPROVAL_NOT_AUTHENTICATED`.
- **Tests.** The 23 November decision reused for another gate; an approval for another gate or candidate; an approval with no words; a relabelled provenance; a missing decision. Each is refused both by the policy and at the grant.

**DB-2. The verifier controller could differ from the gate controller in security-critical files.**
- **Problem.** `validateDbUnitControllerDelta` allowed any content change, provided the changed paths stayed inside an allowlist. The allowlist included `operator-release.mjs`, `ci-install-grant.mjs`, `staging-preflight.test.mjs` and `alpha-staging.yml`. No reviewed-controller check applied, unlike the browser and repair routes. An unreviewed controller could therefore have weakened the grant and still been admitted, provided its controller-only diagnostic passed.
- **Fix.** Both the policy and the grant now require the verification controller to equal the original gate's controller. The adapter's ancestor check and path allowlist are removed.
- **Test.** A verifier that differs from the gate controller is refused.

**DB-3. A later cancelled gate on the same source was accepted without reading its jobs.**
- **Problem.** The history accepted that gate after proving its `gate-plan` source alone. A test, build or browser job that failed before the cancellation would have been ignored, even though it is contrary evidence on the identical source.
- **Fix.** The adapter now reads the gate's complete job inventory. The policy refuses any completed job that failed or timed out, other than the dependent `verify`. It also refuses an empty inventory or a rerun job. The certificate records the job-conclusion counts.
- **Tests.** A failed unit, a timed-out job, a failed build, a missing inventory and a rerun job are each refused.

**DB-4. The history did not read the browser-tooling workflow.**
- **Problem.** The history title set names `Tooling transport only · <branch>`, but the adapter listed runs only from `alpha-staging.yml` and focused-checks. A completed browser-tooling run was therefore invisible. Only active runs from the status queries could have been caught, and those queries were filtered to the same two workflows.
- **Fix.** The adapter now also lists the browser-tooling workflow (`BROWSER_WORKFLOW_ID`), as the build route does.
- **Test.** A later browser-tooling run is refused.

**DB-5. The operator options were spread into the adapter without parsing.**
- **Problem.** `{...JSON.parse(options), candidatePath, runId, baseline}` let an operator set `reuse` or `evidenceDirectory`. The archive digests are still checked against the authenticated API in reuse mode, so this could not forge evidence. It did let an operator skip downloads and choose the evidence directory.
- **Fix.** `dbUnitRecoveryOptions` accepts exactly `focusedRunIds`, `candidateBranch` and an optional `ownerApproval`.
- **Tests.** Extra keys, a wrong type or a missing key are refused. `requireOneRecoveryRoute` refuses any mixture of routes.

### Build-capacity route (`aihr-build-capacity-recovery/v1`)

**BR-1. A missing memory sample counted as a proven floor breach.**
- **Problem.** `validateMemoryFloorFailure` accepted `minMemAvailableKiB === null` and still issued `memoryFloor.proven: true`. The builder's test asserted this deliberately. A missing sample is a telemetry failure, not evidence of the narrow capacity case.
- **Fix.** An actual integer sample below the floor is now required.
- **Tests.** A `null` sample and a non-integer sample are each refused.
- **Real evidence.** The real diagnostic from gate `45187793223` (1,154,660 KiB available against a 1,572,864 KiB floor; peak RSS 10,799,396 KiB, at `warn`) still proves the floor breach under the hardened policy. This was checked locally against the downloaded artifact.

No other defect was found in the build route. It already enforced the following:
- the exact gate controller (the verifier must equal it);
- first attempts;
- the exact build-only job shape;
- one replacement only;
- complete history across `alpha-staging.yml`, focused-checks and browser-tooling, refusing any other run since the original started;
- reconstruction of the normal receipt for every retained unit;
- that the grant binds the replacement run.

### Pre-existing defects

**PRE-a. Focused recovery v1 bound the controller to the candidate.**
- **Problem.** `verifyRecoveredCi` set `controller=candidate`, and `validateFocusedMetadata` then required the focused run's `head_sha` to equal the candidate. Every genuine focused run dispatched with `--ref main` or `--ref alpha` (where `head_sha` is the gate controller) was refused.
- **Fix.** `focusedRecoveryIdentity` binds two things separately: the candidate (the frozen checkout) and the gate controller (the original run's `head_sha` on `main` or `alpha`). The plan, assessment, focused reports and build keep the candidate. The focused run must now also be on the gate's controller branch, which tightens the route. Nothing else changes.
- **Tests.** The identity derivation; a focused run on the candidate instead of the controller; a focused run on another branch; a missing expected branch.

**PRE-b. Recovery readers accepted the failed-build artifact only as JSON.**
- **Problem.** A real `next-application-build-failure` upload holds `comparison.json` plus `canonical-build.log` and `application-typegen.log`, as on gate `45187793223`. Two readers accepted that artifact only as JSON:
  - `extract-artifact.py`, which `collect` uses by default, and through it the focused, browser, repair and DB-unit routes;
  - `resume-source.mjs`.

  The old extractor refuses the real artifact ("Unsafe or duplicate artifact filename"). The repair route's own packet extractor (`repair-recovery-extract.py`) never receives that artifact; the repair route reached the refusal through `collect`.
- **Fix.** Both readers now pass that one artifact to `build-failure-extract.py`:
  - `comparison.json` is required;
  - each log is optional and at most 16 MiB, with 32 MiB in all;
  - every entry is validated before anything is written.

  Only `comparison.json` is parsed as JSON; the logs are read as text. `extract-artifact.py` is unchanged, because it is part of the compiler-cache code identity. The build route no longer hides the diagnostic from the shared assessor.
- **Tests.**
  - The real collector, through a fake `gh`, with both logs;
  - `assessResumeSource` with both logs and with one log;
  - refusal of extra, nested, traversal, script and renamed members, and of a missing report;
  - the extractor's partial-upload case.

### Grant dispatch

The grant dispatch was not a defect: each validator already rechecks its own policy and kind. It is now an explicit policy table in `ci-install-grant.mjs`, which sets both the validator and whether the grant binds the original failed gate or the fresh build run. An unknown policy refuses explicitly. Tests relabel DB-unit and build-capacity certificates to every other policy, and to an unknown one, under both run conclusions; every case refuses.

## Observations (not changed)

1. **The DB-unit route only covers units in which every file failed.** It refuses a unit in which only some files failed. This is conservative: it fits infrastructure-wide unit failures, not ordinary test failures in multi-file units.
2. **The two histories cover different windows.**
   - DB-unit records runs that completed before the original gate finished as `overlapping`, and refuses only on later or active runs. It ignores `CI controller checks` and `Runner diagnostics` titles.
   - Build-capacity refuses any run since the original gate started.

   Both behaviours are documented. Earlier failures on the same source are not consulted by the normal route either.
3. **Both histories are keyed on the candidate branch's run titles, not on the SHA.** A gate on the same SHA under another branch name is invisible. The branch-ref check stops the branch moving, but not a second branch.
4. **The browser route also spreads its options without parsing them.** This is the same class as DB-5 and is outside this review. A strict parser is recommended.
5. **A recorded per-gate owner approval is operator testimony.** The controller does not authenticate it, and its label says so. If the owner wants this route available without a per-gate statement, a standing owner decision should replace it. That is an owner decision, not a code fix.
6. **The "browser test" in the 23 November quote** is `test/operational-visual-browser.test.ts`, a DB-classified unit. The quote matches the gate it approved.
7. **Extractors.**
   - `db-unit-recovery-extract.py` writes only the two fixed result names. Its diagnostic pattern admits top-level names and two fixed nested prefixes, none of which is ever extracted. It allows at most 512 entries and 128 MiB, with result files up to 64 MiB and other members up to 16 MiB. It refuses links, encrypted entries, directories and duplicates.
   - `build-failure-extract.py` admits fixed names only and is bounded as described in PRE-b.
   - `zipfile.read` enforces the declared size and the CRC.
   - All archives are digest-checked against the authenticated API before extraction.
8. **Some local tests fail on macOS for environment reasons.** The local Mac run of the controller suite (1,058 tests) fails 2 Linux-only tests: `ci.test.mjs` needs `/proc` and `compiler-wrapper.test.mjs` needs swap. It also skips 1 Docker/cgroup test. The `scripts/staging` coordinator tests error there too. None of these files changed. The hosted controller-only run is authoritative.

## Before merge (owner)

- **The gate controller on `main` changes.** Merging changes the controller that every later gate runs on. The next release needs a fresh whole gate on that `main`. Neither recovery route can be used for gates run on an older controller, because both now require the verifier to be the exact gate controller.
- **DB-unit approval model.** Decide between a per-gate recorded approval (as implemented) and a standing owner decision. The 23 November words no longer apply to any gate but `45191515984`.
- **Build-capacity route.** It has never been used. It needs explicit owner approval before first use.
- **Behaviour changes to confirm:**
  - v1 now admits a gate controller that differs from the candidate (as requested);
  - a missing memory sample is refused;
  - the DB-unit route requires the exact controller and reads complete history including browser-tooling runs.
- **Controller-only diagnostic.** `verify-recovery`, `verify-repair` and `verify-db-unit-recovery` each require a controller-only diagnostic of the verifier controller from the last 24 hours, dispatched on the merged `main`.
