# Release performance goal

Owner decision, 25 October 2026: work toward completing **all required automated testing and a verified staging deployment in under ten minutes**. This goal has not been achieved.

Measure elapsed time from submission of a clean, frozen candidate through queueing, runner setup, checkout, dependencies, every required test, compiler/build/migration checks, authenticated evidence verification, deployment, restart, health, and verified source/build arrival. Parallel phases contribute their actual critical path. Also measure the **sum of occupied runner minutes per successful release**; faster parallel execution can consume more minutes.

Business, financial, authorization, tenant-isolation and data-integrity coverage remains mandatory. Include full regression whenever the validated release policy requires it. A focused development check is useful evidence about its selected scope, not proof of the complete release goal. Keep main/live deployment disabled until its separate installation is ready.

## Root cloud execution authorization — 26 October MYT

The owner explicitly said in this chat, “You can continue your goal in github action”. This supersedes the older cloud-experiment hold for this chat's performance work, using included standard runners only. AI dev 2's latest direct “no you remain local” keeps its H release local; no H cloud run is dispatched. Root keeps its Mac resource handback and coordinates H before Mobile. Main/live deployment remains disabled.

The next bounded cloud check is the repaired four-file attendance split plus a complete compiler check, using an exact published performance candidate. All 100 cases, actual SQL/financial guards and per-case fixture resets remain. This is development/performance evidence; it cannot issue a release receipt or establish the under-ten-minute end-to-end goal. Do not automatically launch a full matrix or duplicate already completed H checks.

## Local optimization checkpoint — 26 October MYT

The finite Mac validation window is handed to AI dev 2; this work continues without reserving Mac resources. All owned private PostgreSQL clusters were stopped and deleted, the fresh process inventory found no remaining owned validation processes, and no commands targeted shared PostgreSQL 5433. A durable private handback record binds cleanup and the current source. AI dev 2 has separate direct human authorization for local verification with no Actions dispatch; its H release precedes Mobile. This is resource handback, not completion of the ten-minute goal.

At review source `d08aa22c5788cdce421a36542fb1999e0d06738c`, the complete cold repository TypeScript check passed in 192.892 seconds using an 8192 MiB heap, matching Board 3's actual configuration. The default and 6144 MiB attempts exhausted their V8 heap and remain recorded as failures. The passing command's reported peak memory footprint was 9,968,829,472 bytes (about 9.3 GiB). Its CPU profile is diagnostic only; no specific source optimization or standard-runner suitability has yet been proved. That pass predates the later weekday fixture change and is not a compiler receipt for every subsequent commit.

The actual r395 security suite passed 88/88 in 154.219 seconds and reset-error classification passed 12/12 in 0.560 seconds. The proposed split comparison stopped at its original baseline: performance-service 167/167 passed, attendance 81/100 passed with 19 temporal/weekday failures. Only the weekday case has a passing focused repair; 18 early-KL-day completed-work cases remain unresolved. An application-only fake-clock attempt was rejected by the database guard and removed. Optimized split runtime and savings remain unverified. See the three test-optimization documents for exact scope.

The supplied upgrade-rehearsal proposal addresses existing-data correctness but estimates an additional eight to fifteen minutes per deployment. Its estimated cost is not measured or activated. See [the design review](UPGRADE-REHEARSAL-REVIEW.md) for recommended corrections and a separately calibrated, impact-aware policy. Required rehearsal time must count toward the same complete release target.

## H local resume composition checkpoint

A proposed execution handoff was superseded by the owner's direct instruction to keep AI dev 2 local. Its original `final-02` was gracefully cancelled during DB batch 9; no-DB plus DB1–8 are retained, and the partial original ninth batch is excluded. The first cleanup failure remains recorded; a separately verified recovery retry restored the original shared state and removed the private data. The unchanged candidate now runs only DB9–16 in `resume-03`. This adds interruption/recovery time to the actual critical path; it is not a performance success.

The version-2 bounded exception policy now requires both actual run histories and all original raw membership, preserves the original FAIL/impact/in-progress receipt and INCOMPLETE_CANCELLED outcome, and refuses an active or unrestored resume. Independent source review found no further blocker. Five new private boundary groups plus two affected operator guards passed across recorded runs; one new variable-shadowing refusal error was corrected and only its failed check rerun. Actual collection/acceptance/deployment remains unexecuted and ineligible until the remaining reports, restoration and counter-only source boundary are verified. No cloud performance result can substitute for H release evidence.

## Failed-only repair during the H pilot

On 26 October MYT, the human explicitly authorized retaining completed passing checks and repairing/retesting failures only for AI dev 2's current H release. Every unexecuted required check still runs. The timing-dependent original attendance fixture was legitimately redesigned and passed all 100 cases at the early hour on `3c51317ea43ded103e782c37b55eccf9fdeae05c`; root independently checked the raw result, cleanup and exact committed diff. This fix has not yet been adopted into this branch's split fixture.

The current full H gate then exposed an ANSI-sensitive counter defect. The original no-DB raw report has 963 unique passing files and 12,620 passing cases; the counter failed to read the coloured footer and overwrote the actual process status. That original status remains UNKNOWN and the canonical result remains FAIL. The reviewed counter repair `29ee93b3` passed 21 small checks. No passing application tests were rerun to repair the counter.

A separate [bounded exception controller](LOCAL-COUNTER-EXCEPTION.md) is prepared in this isolated branch. It independently reconstructs complete report membership/counts, binds the exact counter-only final source transition, retained compiler/build/browser origins and actual restoration, and uses a fresh canonical staging build. Independent source review found no further blocking issue after correcting private SSH/rsync route consistency, receipt-image binding, the exact healthy DB teardown tail and a finite transfer timeout. This is source review, not an executed collector, exception acceptance, deployment or arrival proof. All 16 DB batches were still running at this checkpoint; any genuine failure needs its own reviewed failed-only repair evidence.

The exceptional path leaves the original failed receipt untouched and cannot establish a new full PASS baseline. It does not enable generic cross-commit reuse, the build-once pipeline, main/live deployment or a ten-minute release. All original failed/cancelled attempts, repair work, evidence processing and deployment time still count toward the goal.

## Measured complete attempts

These are failed verification attempts, with no eligible release receipt or deployment. Times below end at the last workflow job; deployment has not been measured.

| Run | Candidate | Workflow elapsed | Observed runner minutes | Cases |
| --- | --- | --- | --- | --- |
| [40186100073](https://github.com/StradaverseHub/ai-hr/actions/runs/40186100073) | `ba2142` | 33m 58s | 281.07 | 27,821 passed; 2 failed |
| [40188791293](https://github.com/StradaverseHub/ai-hr/actions/runs/40188791293) | `3dd703` | 35m 04s | 293.37 | 27,821 passed; 2 failed |

Each inventory covers all 1,944 Node/DOM files and 16 browser files in three engines, for 48 browser file executions. The second run's 24 artifacts were authenticated against GitHub's API digests and their extracted bytes checked. No files or cases were missing or pending. All 32 database batch/terminal resource snapshots passed the strict checks.

The second run passed all 12,550 no-DB and 753 browser cases. Two database cases failed: an all-schema foreign-key catalog query exceeded 30 seconds, and a detached-deployment test did not receive the expected `MIXED TREE` warning. Board 3 owns those repairs. Neither failure permits relabelling the attempt as PASS.

The longest passing file in that run, `attendance-policy-storage.test.ts`, took 17m 12s. Parallel execution only between whole files cannot overcome that file's current duration.

## Local frozen-candidate diagnostic

Board 3's completed local attempt 080 on `f20275f` took **112m 09s inside its verification wrapper**, ending FAIL solely on the canonical-port Reports guard in batch 11. Independent source/classifier reconstruction, raw logs and terminal commands/exits verified all 1,944 files: 963 no-DB plus 981 DB. All other 15 DB batches passed. Whole TypeScript took 162.7s, the production build 82.3s, and the three browser invocations 34.1s in total. The serial full gate took 6,333.1s, about 94.1% of wrapper elapsed time.

This is not an end-to-end deployment result or a comparable A/B against the GitHub runs: the candidate, operating system, execution layout and resources differ. Queueing before the wrapper, the repair, deployment and verified arrival are still excluded from this diagnostic and must be included in the goal measurement. Its controller's `peak-disk` output reads the foreign RAM mount; it does not measure the owned SSD cluster's peak use.

The owner explicitly authorized retaining all passing work and rerunning only original batch 11 on canonical port 5433. A separate, independently reviewed [local environment-repair controller](https://github.com/StradaverseHub/ai-hr/tree/codex/local-port-repair-controller-20261025) binds the exact frozen candidate, all original completed batches, fresh original 61-file/774-case batch 11, unchanged compiler/build/browser claims, actual endpoint/JIT proof and preservation/restoration of the foreign cluster. All 66 policy/reader/actual-helper flow checks passed, and the collector validated the real original FAIL record. The subsequent fresh original batch 11 passed all 61 files/774 cases on canonical port 5433, with source/evidence bindings and foreign-cluster restoration verified. Board 3 completed staging arrival verification at 15:14:26 UTC: actual source `f20275ffa150ecc41b745f625f085308ea283379`, build `oGGU-IwRplJ92pIcxYyRz`, active service, verified TLS/HTTP 401, zero source checksum differences and 495 migration ledger entries with the original 489 tuples preserved. This proves that repaired release, not a sub-ten-minute release or authenticated user journey. The controller never relabels the original full FAIL receipt or grants generic cross-commit reuse. No Actions run was started by publishing that controller.

## Staging compilation resource diagnostic

During the authorized canonical staging build, a read-only sample at 14:38:30–35 UTC on 25 October observed two logical CPUs on the approximately 4 GiB host. The actual Next build PID had 1,729,996 kB resident and 2,436,280 kB swapped memory. Five actual vmstat intervals, excluding the initial since-boot row, showed active paging and I/O wait of 43%, 1%, 18%, 17% and 38%. Memory full-pressure avg10 was 10.75% and I/O full-pressure avg10 19.89%. No OOM or sole-cause attribution follows from this sample.

At that observation the deployment had reused dependencies and remained in production compilation, before a successful compilation/TypeScript footer. These observations add the staging host's build resources to the measured critical path; the Mac is not the only place to investigate. No server settings, heap limit or running build changed. Build-once artifact promotion still needs the exact Linux/runtime/environment and System Testing identity guarantees described in [the build audit](CI-BUILD-EFFICIENCY.md); this diagnostic does not authorize skipping the canonical build.

## Included-minute constraint

A read-only GitHub billing observation on 25 October showed **1,672 Linux minutes used out of 3,000 included**, a displayed 56%. The arithmetic remainder was 1,328 minutes. Gross usage of $10.03 was fully discounted, with $0 billed; the panel displayed seven days until reset. Billing can lag running jobs. No billing settings or spending authorization changed.

The owner flagged the cost before any successful deployment. Root stopped new performance experiments and automatic full cloud retries. Board 3 is completing its frozen release with local verification under the official resource locks. The owner separately authorized AI dev 2 to continue its reviewed, bounded walkthrough; that exception includes later repaired walkthrough attempts and does not authorize root experiments or another full cloud gate. Do not cancel another owner's authorized run.

An earlier timestamp audit of 31 runs estimated 1,307.05 occupied job-minutes, including partial active work. Four full attempts accounted for about 1,027.81 minutes; cancellation does not erase consumed time. These estimates are not the billing balance. The billing API lacked the current token's `admin:org` scope, so the authenticated browser view supplied the displayed usage.

For allowance A, reserve R and N expected monthly releases, the average available budget is `(A - R) / N`. Agree the release frequency before claiming a sustainable budget. Repeated full attempts costing roughly 280–293 minutes are unsuitable as routine development checks on this allowance. No paid larger runners or additional spending is authorized.

## Operating approach while reducing cost

Use focused development checks locally under the official resource locks, once the release owner releases the Mac. Diagnose a failure before choosing another run. Reserve included GitHub-hosted capacity for reviewed Linux-specific verification and final candidate checks; the current root experiment hold remains in place. This does not remove any required release coverage.

Track two separate outcomes: end-to-end elapsed time and runner minutes per verified successful release, including failed attempts leading to that release. At approximately 293 occupied runner-minutes per whole attempt, ten attempts consume about 2,930 minutes of the 3,000-minute allowance before other workflows or per-job rounding. Increasing parallelism alone cannot make that sustainable.

GitHub supports rerunning failed jobs on the **same original commit**. It does not automatically validate previously passing jobs after a code repair changes the commit. Keep input-aware, authenticated cross-commit reuse explicitly unfinished until its independent verifier is implemented and validated. See GitHub's [rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) and [usage accounting](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Implemented in the isolated review branch

These changes are prepared in `codex/test-suite-efficiency-review-20261025`. They are not activated in the current release. Reconcile the actually released alpha baseline before integration.

| Change | Evidence and limit |
| --- | --- |
| Move pure personnel-search checks out of database fixtures | Same-controller comparison: resets 16 → 3; reset time 8.788s → 1.519s; DB file time 10.199s → 2.100s. Unique protections retained; complete TypeScript checks passed in both focused runs. See [coverage map](TEST-OPTIMIZATION-SEARCH.md). This is one group, not an end-to-end result. |
| Reserve local resources together | An isolated launcher requests both memory slots and the shared DB slot as one set, holds none while waiting, refuses nested upgrades, and preserves foreign/uncertain leases. All 17 private subprocess checks passed, including actual gate-helper re-entry, argument/exit preservation and partial-upgrade refusal. It is not installed in the shared runtime and cannot repair existing legacy waiters. See [local admission](LOCAL-RESOURCE-LOCKS.md). |
| Opt-in fixture profiling | Records reset, seed, close, template setup/migration and worker cloning. It records timings, not SQL, fixture records or error contents. Inclusive/parallel timings must not be summed as elapsed time. |
| Reuse Next compiler work | Optional pinned compiler-only cache prepared for the Linux build, bound to the existing CSS-input guard; production compilation always runs. YAML/shell/scope, CSS-namespace and tiny upload-budget probes passed. Cold/warm timings and actual cloud behavior remain unverified. See [build efficiency and deployment boundaries](CI-BUILD-EFFICIENCY.md). |
| Reduce planning setup | Planning and final report verification use shallow source checkouts, pinned Node setup and the native classifier, with no package installation. The web build retains root dependencies and omits the mobile SDK. All actual test/compiler jobs retain full history and native dependencies. Native sign-in tests execute installed Expo sources, so those dependencies cannot simply be removed everywhere. Cloud savings are unmeasured. |
| Refuse doomed aggregate verification early | Prerequisite failures are checked before checkout/install. In run 401861, verification spent 40s on source checkout and 87s on setup before refusing an already-failed prerequisite. Failed unit artifacts remain available; no receipt can be issued. |
| Suppress routine reset notices | Add `SET LOCAL client_min_messages = 'warning'` only inside the existing fixture-reset transaction. Preserve its 216-table TRUNCATE, identity reset, cascade, lock timeout, retry and isolation behavior. Local PostgreSQL semantics passed; runtime savings and Linux full-suite behavior remain unmeasured. |
| Offline cost reporting | `.github/ci/report-run-cost.mjs` separates aggregate job time from elapsed time and refuses missing pagination, duplicates or impossible timestamps. It never calls GitHub, dispatches work, infers billing, or authorizes release. |
| Release rolled-back write-comparison savepoints | The slow security-equivalence file retains all 88 cases and assertions. Source/control-flow checks passed; actual PostgreSQL semantics and timing are pending. See [r395 coverage and validation](TEST-OPTIMIZATION-R395.md). |
| Split the performance-service monolith | Four files retain all 167 callbacks/assertions/timeouts and original per-case fixtures/mocks. Collection, helper AST and mock live-binding checks passed; all four remain DB-classified. Database execution, whole TypeScript, resource peaks and timing are pending. See [coverage map](TEST-OPTIMIZATION-ONEHR.md). |
| Split the longest attendance file | Four files retain all 100 cases and original per-case fixture hooks. Exact registration/data checks and helper AST equivalence passed; database execution, complete type checking and timing remain unverified. See [coverage and fixture design](TEST-OPTIMIZATION-ATTENDANCE.md). |
| Exact-candidate resume assessment | Identifies complete passing units and units needing fresh execution, using the same strict unit validator as full verification. It has no release authority and cannot authenticate archives itself. See below. |

The review branch passed 139 lightweight integrity/refusal checks locally. These do not replace application tests, complete TypeScript/build checks, outcome walkthroughs or release validation.

### Fixture logging evidence

One authenticated 64-file job log contained 51,469,145 bytes and 751,464 lines, including 74,175 routine TRUNCATE CASCADE notices.

A tiny private local PostgreSQL 16.14 probe verified that the transaction-local setting suppresses cascade NOTICEs while preserving WARNINGs, ERRORs and nonzero error exits. The original level returned after commit and rollback; NOTICEs outside the transaction remained visible. The probe used a private Unix socket, 16 MB shared buffers and no shared application database or network listener. Its cluster was stopped and temporary data removed.

Notice-asserting migration tests retain their separate notice connection. This change affects fixture reset output, not product/server configuration. See PostgreSQL's [client message levels](https://www.postgresql.org/docs/16/runtime-config-client.html) and [SET LOCAL scope](https://www.postgresql.org/docs/16/sql-set.html).

### Dependency-free planning probe

A local shallow checkout of exact `ba2142`, without `node_modules` or local env files, reconstructed all 1,944 files, 23 units and 48 browser executions in 9.868s using Node's native type stripping. Coverage/execution fields matched the authenticated historical plan. This was Darwin arm64 Node 22.23.1, not Linux release proof. The cloud parity probe remains undispatched under the cost hold. The isolated review workflow now selects this native loader for planning and final verification; test workers and the operator keep the default tsx loader. Both paths must reconstruct the same complete manifest or verification refuses. The active release controller is unchanged; Linux parity and whole-workflow validation remain required before adoption.

## Resumable CI: prepared assessment and remaining work

`.github/ci/resume-assessment.mjs` assesses reports against a **complete plan independently reconstructed from source**. It preserves every required unit, schedules missing/red/skipped/incomplete/unhealthy units fresh, and refuses changed candidate, controller, baseline, environment or coverage fingerprints. It emits no PASS receipt. All six non-test prerequisites, including compiler, build and migration checks, remain fresh in this initial proposal.

Historical assessment results:

- Run 401861: 22 of 23 units, containing 24,247 passing assertions, were potentially reusable for that exact candidate; the failed 256-file no-DB unit still required fresh execution.
- Run 401887: 21 of 23 units, containing 25,905 passing assertions, were potentially reusable for that exact candidate; both failed database units still required fresh execution.

These are analyses of authenticated historical evidence, not permission to deploy failed attempts. **Reuse after a code repair remains unfinished**: a changed commit is refused by the current assessment. It requires independently validated impact/input provenance, not substitution of a new SHA into old reports.

The review branch also has `.github/ci/resume-source.mjs`, an offline source-integrity check. It binds the expected company repository, workflow, controller, first run attempt, complete job inventory, artifact ownership/times and raw ZIP digests before bounded JSON-only extraction. The archived plan must equal coverage independently reconstructed from source. Missing/red/skipped/unhealthy units remain fresh; a failed producing job cannot be overridden by a green payload. It preserves the failed run and each job observation. API snapshots are inputs, so this tool explicitly does **not** authenticate them, inspect the latest cross-run failure history or authorize release.

Twenty-nine integrity/refusal checks passed, including bad identities, stale attempts, digest corruption, unsafe archives, omitted jobs, wrong-unit payloads, skips and PostgreSQL OOM. Historical run 401887 was checked again against all 24 saved raw archives and source-derived coverage: 21 units / 25,905 assertions remained potentially reusable, both failed units remained required fresh, and the original whole run remained FAILURE. No test bodies, application/database runtime or GitHub jobs ran for this assessment.

`.github/ci/resume-repair.mjs` now prepares a cross-commit scheduling assessment while retaining original report SHA, fingerprint, report hash and run/job/archive identities. It makes changed, affected, guard-selected and previously failed units fresh. New unit membership and affected browser engines stay fresh. Crucially, the existing impact policy's **full** classification still makes every unit fresh; deployment/database/verification changes do not gain an exception. This is not an assembled release receipt or activated reuse.

`.github/ci/repair-impact.mjs` reconstructs old/new impact from immutable Git objects through the existing pinned classifier. It requires an exact clean controller, company origin and ancestor source commit, binds both tree identities, and refuses malformed/truncated Git blob responses. A tiny disposable Git integration proved transitive selection, retained old import edges, immunity to uncommitted candidate edits, mandatory deployment full classification, and refusal of foreign origins/non-ancestor sources. The 54 source/repair integrity checks passed; the configured pure CI integrity set also passed. No complete application graph, application tests, build or database ran for this integration. Authenticated latest failure history, full-repository integration, the versioned scheduler/operator validator and bootstrap validation are still required.

Before activation, implement and validate a versioned resume workflow and independent operator revalidation binding repository/run/attempt/job/controller identities, archive digests, complete coverage, environment and freshness. Preserve original red observations and the full attempt history; never select an older green to hide a newer failure. Final assembly must revalidate every carried unit and fresh prerequisite. Existing unmerged ADR-0133/local checkpoint code is design context, not current GitHub v2 authority.

## Rejected shortcuts and diagnostic limits

**Naive batch balancing:** An offline model of all 981 database files in run 401861 retained 16 jobs and the 64-file cap. It reduced the predicted longest unit from 16.17 to 12.65 minutes but increased summed predicted job time from 129.74 to 141.66 minutes, about 9.2%. The single-file floor remained 12.65 minutes. Do not adopt this costlier reordering as a solution. These are models from contention-affected file durations; they exclude setup, queues and deployment and do not predict actual billing. New combinations may also change peak PostgreSQL memory.

**Blanket JIT changes:** The unchanged 88-case r395 suite passed with JIT on at 221.053s and off at 409.289s. The unchanged 100-case attendance suite passed with JIT on at 663.633s and off at 514.666s. Settings were authenticated, but separate standard VMs confound causal comparisons. The opposing results do not justify disabling JIT globally. Preserve the existing measured resource and default-JIT checks.

**Unbounded browser checks:** Development-only run 40188453726 was cancelled after exceeding 16 minutes without useful live phase progress. It had zero completed visit screenshots and no terminal resource proof; preserve it as incomplete. AI dev 2 prepared bounded product-outcome waits, progress evidence and an explicit risk/coverage map before the separately authorized replacement. Required HR correction/save/reopen outcomes remain unverified until demonstrated.

## Deployment-status review supporting the current repair

A file-only deterministic probe reproduced a torn status record. Independent review then found another handoff gap: `begin` cleared PENDING before publishing the new CURRENT record. A failed publish could leave an old matching current/last-good/build combination reporting old `ok` and `stale_build=0` after new source was announced.

Publishing CURRENT successfully before clearing PENDING retained conservative `incomplete`, the new ref and `stale_build=1` on failure, while clearing pending on success. Board 3 is incorporating this guard. These are reproduced product faults, not proof of the actual CI race. The probes used private files and no application/database runtime, Vitest, build or real process signals.

## Reset retry classification

A separate, unfinished local performance analysis on `claude/gate-speed-analysis-37e5b1` reported a timeout followed by reset deadlocks in repeated REA gates. Independent inspection confirmed the relevant driver behavior: Drizzle 0.45 wraps the PostgreSQL exception in `cause`; its outer message contains the failed query, not the PostgreSQL error message. The harness examined only that outer message, leaving its intended retry path unreachable for normal wrapped lock errors.

The review branch now has a small cause-chain classifier. It recognizes the existing intended reset conditions (`40P01`, `55P03`, `57014`), retains legacy message support, refuses unrelated structured SQL errors, ignores wrapper SQL text and bounds malformed/cyclic causes. The existing three-attempt limit, five-second lock timeout, rollback, worker-database ownership, final-attempt cleanup and original-error propagation remain unchanged. This retries fixture reset, never a failed application assertion; an earlier timed-out test remains failed.

Seventeen lightweight assertions passed using the actual installed Drizzle error class, including an old-red/new-green wrapped-error case. The new Vitest regression file has not run, and no database recovery or complete compiler proof is claimed. No local heavy command was started. Board 3's active frozen local verification candidate does not include this future change; do not introduce it mid-run. PostgreSQL recommends matching [SQLSTATE codes](https://www.postgresql.org/docs/16/errcodes-appendix.html), rather than localized error text.

## Completed tooling checkpoints after Board 3

The isolated performance branch normally merged the aligned `main`/`alpha` integration baseline `1a45bbe0e`; the runtime arrival above remains the separately verified deployed source. All 153 dependency-free controller integrity checks passed after conflict resolution. Main/live deployment remains disabled.

Complete-set local admission reproduced and fixed another concrete gap: extra legacy reservations beyond its fixed two-test/one-database budget were previously ignored. Private regression controls failed on that old behavior; all 15 subprocess checks passed at that checkpoint, preserving out-of-capacity leases and waiting without acquiring new ones. The repository gate helper subsequently adopted complete-set admission; all 17 private checks passed, including actual helper re-entry, argument/exit preservation and partial outer-upgrade refusal. This does not prove a real application gate. The shared host scripts and foreign owners were not changed. A real benchmark admission waited 45 seconds, then exited 75 holding no resources because the login reservations remained occupied; the PostgreSQL benchmark did not start.

The [build-byte transport and canonical producer](BUILD-ARTIFACT-TRANSPORT.md) are checkpointed. Nineteen byte-transport fixture checks and four producer guard groups passed. The producer calls the actual owned-record System Testing builder and binds preparation, successful observation, BUILD_ID and package bytes, but has not run on Linux or become authenticated promotion authority. The current build/deploy jobs remain unchanged. Completion still requires the full versioned verification and deployment path plus real runtime/render and end-to-end timing evidence.

The alignment push automatically started [40206744430](https://github.com/StradaverseHub/ai-hr/actions/runs/40206744430). Board 3 cancelled that duplicate; the API confirmed `completed/cancelled` at 15:33:40 UTC. Some jobs had already consumed runner time. This is cancelled evidence, not a passing gate. No additional full workflow was dispatched for these future changes.

## Next validation sequence

1. Board 3 has completed the verified staging release and handed the first performance-validation window to this session. Obtain normal complete-set admission after the existing login owners finish; preserve all peer processes, data and leases. Give an explicit coordinated handback to AI dev 2, then Mobile, without claiming unfinished performance work complete.
2. Measure setup and fixture savings on comparable candidates; reduce actual work in the longest files before considering more parallelism.
3. Complete authenticated, input-aware evidence reuse and its independent release validator.
4. Finish build-once artifact promotion. Bind platform/runtime, compile-time environment, source, dependencies and artifact provenance; retain migrations, catalog work, restart, health and source/build arrival. The current official build derives its System Testing identity from a validated owned preparation and fresh build observation; generic CI output lacks that context. [Build audit](CI-BUILD-EFFICIENCY.md) records this boundary. Rebuilding is an opportunity to measure, but artifact promotion is not implemented.
5. Validate the complete representative release, including all required full coverage, within the elapsed-time and runner-minute budgets. Only then claim the ten-minute goal achieved.

Read [repository/environment ownership](https://github.com/StradaverseHub/ai-hr/blob/main/docs/REPOSITORY-AND-ENVIRONMENTS.md), [alpha Actions](https://github.com/StradaverseHub/ai-hr/blob/main/docs/ALPHA-STAGING-ACTIONS.md), [CI verification policy](https://github.com/StradaverseHub/ai-hr/blob/main/docs/CI-STAGING-VERIFICATION-POLICY.md) and [test assessment](https://github.com/StradaverseHub/ai-hr/blob/main/docs/TEST-SUITE-ASSESSMENT.md) before changing release authority. Private raw evidence is retained in the owning worktrees' ignored scratchpads; it is not committed to the repository.
