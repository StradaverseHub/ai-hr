# Release performance goal

Owner decision, 25 October 2026: work toward completing **all required automated testing and a verified staging deployment in under ten minutes**. This goal has not been achieved.

Measure elapsed time from submission of a clean, frozen candidate through queueing, runner setup, checkout, dependencies, every required test, compiler/build/migration checks, authenticated evidence verification, deployment, restart, health, and verified source/build arrival. Parallel phases contribute their actual critical path. Also measure the **sum of occupied runner minutes per successful release**; faster parallel execution can consume more minutes.

Business, financial, authorization, tenant-isolation and data-integrity coverage remains mandatory. Include full regression whenever the validated release policy requires it. A focused development check is useful evidence about its selected scope, not proof of the complete release goal. Keep main/live deployment disabled until its separate installation is ready.

## Measured complete attempts

These are failed verification attempts, with no eligible release receipt or deployment. Times below end at the last workflow job; deployment has not been measured.

| Run | Candidate | Workflow elapsed | Observed runner minutes | Cases |
| --- | --- | --- | --- | --- |
| [40186100073](https://github.com/StradaverseHub/ai-hr/actions/runs/40186100073) | `ba2142` | 33m 58s | 281.07 | 27,821 passed; 2 failed |
| [40188791293](https://github.com/StradaverseHub/ai-hr/actions/runs/40188791293) | `3dd703` | 35m 04s | 293.37 | 27,821 passed; 2 failed |

Each inventory covers all 1,944 Node/DOM files and 16 browser files in three engines, for 48 browser file executions. The second run's 24 artifacts were authenticated against GitHub's API digests and their extracted bytes checked. No files or cases were missing or pending. All 32 database batch/terminal resource snapshots passed the strict checks.

The second run passed all 12,550 no-DB and 753 browser cases. Two database cases failed: an all-schema foreign-key catalog query exceeded 30 seconds, and a detached-deployment test did not receive the expected `MIXED TREE` warning. Board 3 owns those repairs. Neither failure permits relabelling the attempt as PASS.

The longest passing file in that run, `attendance-policy-storage.test.ts`, took 17m 12s. Parallel execution only between whole files cannot overcome that file's current duration.

## Included-minute constraint

A read-only GitHub billing observation on 25 October showed **1,672 Linux minutes used out of 3,000 included**, a displayed 56%. The arithmetic remainder was 1,328 minutes. Gross usage of $10.03 was fully discounted, with $0 billed; the panel displayed seven days until reset. Billing can lag running jobs. No billing settings or spending authorization changed.

The owner flagged the cost before any successful deployment. Root stopped new performance experiments, and Board 3 and AI dev 2 acknowledged a hold on automatic retries. Afterward, the owner separately authorized AI dev 2's reviewed, bounded walkthrough, run 40191431859. That narrow exception does not authorize new root performance experiments or another full gate.

An earlier timestamp audit of 31 runs estimated 1,307.05 occupied job-minutes, including partial active work. Four full attempts accounted for about 1,027.81 minutes; cancellation does not erase consumed time. These estimates are not the billing balance. The billing API lacked the current token's `admin:org` scope, so the authenticated browser view supplied the displayed usage.

For allowance A, reserve R and N expected monthly releases, the average available budget is `(A - R) / N`. Agree the release frequency before claiming a sustainable budget. Repeated full attempts costing roughly 280–293 minutes are unsuitable as routine development checks on this allowance. No paid larger runners or additional spending is authorized.

## Implemented in the isolated review branch

These changes are prepared in `codex/test-suite-efficiency-review-20261025`. They are not activated in the current release. Reconcile the actually released alpha baseline before integration.

| Change | Evidence and limit |
| --- | --- |
| Move pure personnel-search checks out of database fixtures | Same-controller comparison: resets 16 → 3; reset time 8.788s → 1.519s; DB file time 10.199s → 2.100s. Unique protections retained; complete TypeScript checks passed in both focused runs. See [coverage map](TEST-OPTIMIZATION-SEARCH.md). This is one group, not an end-to-end result. |
| Opt-in fixture profiling | Records reset, seed, close, template setup/migration and worker cloning. It records timings, not SQL, fixture records or error contents. Inclusive/parallel timings must not be summed as elapsed time. |
| Reduce planning setup | Planning and final report verification use shallow source checkouts and skip mobile SDK installation. All actual test/compiler jobs retain full history and native dependencies. Native sign-in tests execute installed Expo sources, so those dependencies cannot simply be removed everywhere. Cloud savings are unmeasured. |
| Refuse doomed aggregate verification early | Prerequisite failures are checked before checkout/install. In run 401861, verification spent 40s on source checkout and 87s on setup before refusing an already-failed prerequisite. Failed unit artifacts remain available; no receipt can be issued. |
| Suppress routine reset notices | Add `SET LOCAL client_min_messages = 'warning'` only inside the existing fixture-reset transaction. Preserve its 216-table TRUNCATE, identity reset, cascade, lock timeout, retry and isolation behavior. Local PostgreSQL semantics passed; runtime savings and Linux full-suite behavior remain unmeasured. |
| Offline cost reporting | `.github/ci/report-run-cost.mjs` separates aggregate job time from elapsed time and refuses missing pagination, duplicates or impossible timestamps. It never calls GitHub, dispatches work, infers billing, or authorizes release. |
| Exact-candidate resume assessment | Identifies complete passing units and units needing fresh execution, using the same strict unit validator as full verification. It has no release authority and cannot authenticate archives itself. See below. |

The review branch passed 139 lightweight integrity/refusal checks locally. These do not replace application tests, complete TypeScript/build checks, outcome walkthroughs or release validation.

### Fixture logging evidence

One authenticated 64-file job log contained 51,469,145 bytes and 751,464 lines, including 74,175 routine TRUNCATE CASCADE notices.

A tiny private local PostgreSQL 16.14 probe verified that the transaction-local setting suppresses cascade NOTICEs while preserving WARNINGs, ERRORs and nonzero error exits. The original level returned after commit and rollback; NOTICEs outside the transaction remained visible. The probe used a private Unix socket, 16 MB shared buffers and no shared application database or network listener. Its cluster was stopped and temporary data removed.

Notice-asserting migration tests retain their separate notice connection. This change affects fixture reset output, not product/server configuration. See PostgreSQL's [client message levels](https://www.postgresql.org/docs/16/runtime-config-client.html) and [SET LOCAL scope](https://www.postgresql.org/docs/16/sql-set.html).

### Dependency-free planning probe

A local shallow checkout of exact `ba2142`, without `node_modules` or local env files, reconstructed all 1,944 files, 23 units and 48 browser executions in 9.868s using Node's native type stripping. Coverage/execution fields matched the authenticated historical plan. This was Darwin arm64 Node 22.23.1, not Linux release proof. The opt-in cloud parity probe remains undispatched under the cost hold; the full workflow's classifier loader is unchanged by default.

## Resumable CI: prepared assessment and remaining work

`.github/ci/resume-assessment.mjs` assesses reports against a **complete plan independently reconstructed from source**. It preserves every required unit, schedules missing/red/skipped/incomplete/unhealthy units fresh, and refuses changed candidate, controller, baseline, environment or coverage fingerprints. It emits no PASS receipt. All six non-test prerequisites, including compiler, build and migration checks, remain fresh in this initial proposal.

Historical assessment results:

- Run 401861: 22 of 23 units, containing 24,247 passing assertions, were potentially reusable for that exact candidate; the failed 256-file no-DB unit still required fresh execution.
- Run 401887: 21 of 23 units, containing 25,905 passing assertions, were potentially reusable for that exact candidate; both failed database units still required fresh execution.

These are analyses of authenticated historical evidence, not permission to deploy failed attempts. **Reuse after a code repair remains unfinished**: a changed commit is refused by the current assessment. It requires independently validated impact/input provenance, not substitution of a new SHA into old reports.

Before activation, implement and validate a versioned resume workflow and independent operator revalidation binding repository/run/attempt/job/controller identities, archive digests, complete coverage, environment and freshness. Preserve original red observations and the full attempt history; never select an older green to hide a newer failure. Final assembly must revalidate every carried unit and fresh prerequisite. Existing unmerged ADR-0133/local checkpoint code is design context, not current GitHub v2 authority.

## Rejected shortcuts and diagnostic limits

**Naive batch balancing:** An offline model of all 981 database files in run 401861 retained 16 jobs and the 64-file cap. It reduced the predicted longest unit from 16.17 to 12.65 minutes but increased summed predicted job time from 129.74 to 141.66 minutes, about 9.2%. The single-file floor remained 12.65 minutes. Do not adopt this costlier reordering as a solution. These are models from contention-affected file durations; they exclude setup, queues and deployment and do not predict actual billing. New combinations may also change peak PostgreSQL memory.

**Blanket JIT changes:** The unchanged 88-case r395 suite passed with JIT on at 221.053s and off at 409.289s. The unchanged 100-case attendance suite passed with JIT on at 663.633s and off at 514.666s. Settings were authenticated, but separate standard VMs confound causal comparisons. The opposing results do not justify disabling JIT globally. Preserve the existing measured resource and default-JIT checks.

**Unbounded browser checks:** Development-only run 40188453726 was cancelled after exceeding 16 minutes without useful live phase progress. It had zero completed visit screenshots and no terminal resource proof; preserve it as incomplete. AI dev 2 prepared bounded product-outcome waits, progress evidence and an explicit risk/coverage map before the separately authorized replacement. Required HR correction/save/reopen outcomes remain unverified until demonstrated.

## Deployment-status review supporting the current repair

A file-only deterministic probe reproduced a torn status record. Independent review then found another handoff gap: `begin` cleared PENDING before publishing the new CURRENT record. A failed publish could leave an old matching current/last-good/build combination reporting old `ok` and `stale_build=0` after new source was announced.

Publishing CURRENT successfully before clearing PENDING retained conservative `incomplete`, the new ref and `stale_build=1` on failure, while clearing pending on success. Board 3 is incorporating this guard. These are reproduced product faults, not proof of the actual CI race. The probes used private files and no application/database runtime, Vitest, build or real process signals.

## Next validation sequence

1. Finish the concrete release repairs with focused local verification after the foreign REA gate releases the shared Mac resources. Do not touch its processes, database or locks.
2. Measure setup and fixture savings on comparable candidates; reduce actual work in the longest files before considering more parallelism.
3. Complete authenticated, input-aware evidence reuse and its independent release validator.
4. Assess build-once artifact promotion. Bind platform/runtime, compile-time environment, source, dependencies and artifact provenance; retain migrations, catalog work, restart, health and source/build arrival. Rebuilding identical output is a measured opportunity, but artifact promotion is not implemented.
5. Validate the complete representative release, including all required full coverage, within the elapsed-time and runner-minute budgets. Only then claim the ten-minute goal achieved.

Read [repository/environment ownership](https://github.com/StradaverseHub/ai-hr/blob/main/docs/REPOSITORY-AND-ENVIRONMENTS.md), [alpha Actions](https://github.com/StradaverseHub/ai-hr/blob/main/docs/ALPHA-STAGING-ACTIONS.md), [CI verification policy](https://github.com/StradaverseHub/ai-hr/blob/main/docs/CI-STAGING-VERIFICATION-POLICY.md) and [test assessment](https://github.com/StradaverseHub/ai-hr/blob/main/docs/TEST-SUITE-ASSESSMENT.md) before changing release authority. Private raw evidence is retained in the owning worktrees' ignored scratchpads; it is not committed to the repository.
