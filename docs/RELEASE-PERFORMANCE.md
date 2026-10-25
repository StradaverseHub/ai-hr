# Release performance goal

Owner decision, 25 October 2026: work toward completing all required automated testing and deployment in **under ten minutes**.

Measure from submission of a clean frozen candidate until verified healthy staging arrival, including queue time, runner provisioning, checkout/cache/dependencies, every required test and compiler/build/migration check, authenticated evidence verification, transfer/deployment, restart, health and source/build arrival. Concurrent phases contribute their actual critical path, not the sum of job durations. Keep main/live deployment disabled until its separate installation is ready.

Required business, financial, authorization, tenant isolation and data-integrity coverage remains mandatory. A full suite remains part of the metric whenever the validated release policy requires it. Do not achieve the number by silently excluding setup, queues, deployment or required checks. Distinguish passing, failed and incomplete attempts, cache state and runner capacity. A fast focused development check does not meet the full release goal.

The current frozen Board 3 release proceeds unchanged. Future optimization happens in isolated worktrees and is integrated only after reconciling the actually released alpha baseline. Standard included GitHub runner capacity only; no paid larger runner or additional spending is authorized by this goal.

## Work toward the target

1. Establish complete pipeline and per-phase timing from authenticated runs and the release owner's verified arrival timestamps.
2. Fix measured resource/query problems and unreliable asynchronous test interactions.
3. Measure database template setup/migration/cloning, reset, seed and teardown separately. Profiling is opt-in and records timings only, never SQL, fixture records or error contents. Inclusive and parallel durations must not be added as elapsed time.
4. Move pure checks out of database fixtures and consolidate proven duplicate protection with an explicit retained-coverage map.
5. Review setup/install/checkout overhead, batch balancing and oversized files using comparable measurements. Investigate build-artifact promotion to avoid rebuilding identical verified output during deployment only after environment and artifact provenance are established.
6. Validate improvements with focused development checks, then a complete representative release before claiming the ten-minute goal achieved.

No end-to-end ten-minute success has been established. Planned time allocations are hypotheses until measured; the complete healthy-release baseline is still being collected.

## Included-minute constraint and dispatch hold

Owner reported 35% of the included GitHub allowance consumed before a deployment on 25 October 2026. Wall-clock speed alone is insufficient: concurrent jobs consume summed runner time. No paid runners or additional spending is authorized.

Root stopped new cloud performance experiments and asked Board 3 and AI dev 2 to hold new retries/dispatches; both acknowledged. Preserve the current already-running release attempt and its evidence. A failure requires complete failure/cost review before another whole run. These are session coordination decisions; no claim of a platform-enforced billing cap.

Authenticated job-timestamp audit (not billing): four full attempts 40179027150, 40179650591 (cancelled), 40183086869 and 40186100073 total approximately **1,027.81 runner-minutes**. The last completed attempt alone consumed **281.07 runner-minutes**, with 27,821 passing cases and two failures. Across the 31 recent runs inspected, observed job time was about **1,307 minutes**, including partial running jobs. Billing can lag, and attempts, rounding and OS pricing can differ; the billing API refused the current token's missing admin:org scope. Do not present this estimate as the current billed balance. Raw run/job snapshots are preserved privately.

The sustainable target must track both complete release elapsed time and aggregate runner minutes per successful release. For an allowance A, reserve R and expected monthly release count N, the average available budget is (A-R)/N. Select N with the owner before claiming a sustainable budget. A full attempt costing around 281 minutes cannot be routine for frequent releases on an included allowance.

Next work: inspect and reuse authentic exact-candidate evidence under the existing validated impact policy; use focused development checks; avoid repeated builds for browser-helper-only repairs when a verified artifact can safely be reused; reduce measured setup/reset/slow-test costs. Any changes to selection, reuse, artifact promotion or verification require their own correctness validation. Do not silently skip required checks. The dependency-free plan probe is local WIP only and has not been dispatched or validated in GitHub.

## Prepared setup savings (not deployed or cloud-validated)

The plan and final report-verification jobs both installed the entire mobile Expo dependency tree even though they only invoke Node planning/verification code and the root tsx loader. Their future isolated workflow now requests mobile=false and source fetch-depth=1. The shared action retains mobile=true by default, validates the scope, and splits root/native installation into named steps for timing. All actual test jobs and the complete compiler retain the native dependencies and full history; no coverage or release verification is removed. In particular, native sign-in tests execute the actual installed Expo AuthRequest sources, so blindly removing mobile installation from every test job would break required protection. Migration ancestry jobs retain complete history.

This change is prepared only on the efficiency branch; the current Board 3 frozen workflow is untouched. Expected savings are unmeasured until an authorized future cloud validation. No new Actions dispatch is authorized under the cost hold.

Completed unchanged r395 diagnostic evidence: JIT-on40188013185 passed88/88 at221.053s file time; JIT-off40188015015 passed88/88 at409.289s. Both actual settings were authenticated from API-digest-verified artifacts. Different runner executions can vary, so this does not isolate the causal effect of JIT; it does refute assuming a blanket JIT-off configuration is proven faster for all suites. Retain default server JIT on.

The aggregate verifier also now checks prerequisite outcomes before checkout or package installation. In failed baseline401861, this job spent40s on source checkout and87s on setup before refusing an already-failed prerequisite; neither helped verification. Early refusal preserves failed unit artifacts and cannot issue a receipt. The full completed failed run elapsed33m58s; build alone was287s plus138s setup and42s source checkout. These measured costs show why setup reductions help but cannot establish the complete ten-minute goal by themselves.

Local shallow/native-loader parity check (Darwinarm64 Node22.23.1, NOT Linux release proof): exactba2142, no node_modules or local env, reconstructed all1944 suite files/23units/48browser executions in9.868s, matching the previously authenticated reference plan's complete coverage/execution fields. The Linux cloud parity probe remains undispatched under the cost hold.

## Repeatable cost measurement

`.github/ci/report-run-cost.mjs` reads a preserved run/job snapshot locally, separates summed occupied job seconds from candidate queue-to-observation elapsed time, estimates per-job minute rounding, counts cancelled work, refuses incomplete pagination/duplicate jobs/impossible timestamps, and explicitly refuses to infer billing or a ten-minute release success. It never calls GitHub or dispatches/cancels work. Example: `node .github/ci/report-run-cost.mjs /private/path/run-job-snapshot.json /private/path/new-cost-report.json`. Input shape: `{observed_at: ISO timestamp, runs: [{id or databaseId, created_at or createdAt, status, conclusion, total_jobs, jobs: complete GitHub jobs array}]}`. Deployment arrival remains a separate required measurement. Five lightweight regression cases passed; the actual31-run snapshot yielded1307.05 observed job-minutes/1412rounded estimate.

After owner cost concern, root requested cancellation of the separate development-only AI renderer40188453726 after it exceeded16minutes without live phase observability. This is incomplete evidence, not PASS. Preserve its partial artifacts. Board3 release40188791293 remains protected. AIdev2 is preparing a coverage map, bounded waits and progress telemetry without further cloud runs; distinct role/scope/business/security/locale/viewport protections may not silently disappear.

Attendance original100cases: isolatedJITon40188467503 passed100/100 at663.633s; JIToff40188470446 passed100/100 at514.666s. API-digest-verified artifacts confirm actualsettings. DifferentstandardVMrunsarenotcausalisolation. Togetherwithr395'soppositeresultthisdoesnotjustifyblanketJIToff. The11-minute isolatedpassingfile establishes a current critical-path obstacle even before setup/deployment; parallelizing only across whole files cannot by itself meet the target.

## Fixture reset logging

Authenticated current40188791293 job121155866061 log contains51,469,145bytes/751,464lines, including74,175expected TRUNCATECASCADE notices. A future harness-only change adds `SET LOCAL client_min_messages = 'warning'` inside the existing reset transaction, after unchanged5slock_timeout and before the unchanged full216tableTRUNCATE/RESTARTIDENTITY/CASCADE. It changes no query/data/reset membership/retry/isolation or product setting. Warnings and errors remain visible; the original session message level returns before test/migration code runs. Notice-asserting migration tests retain their separate notice connection and behavior.

Actual isolated SQL verification on localHomebrewPostgreSQL16.14 passed: baselinecascadeNOTICEpresent; reset-localNOTICEabsent; WARNINGretained; ERRORretainedwithnonzeroexit; postcommitandrollbackmessagelevelrestored; outsideNOTICEretained. Probe used a privateUnixsocket and16MBsharedbuffers, no network listener/sharedappDB, and stopped/removed its owncluster/data. This establishesSQLsemantics, NOTLinuxfullsuiteorperformancespeedup. Cloudvalidationremainsheld. SeePostgreSQL16 [clientmessagelevels](https://www.postgresql.org/docs/16/runtime-config-client.html) and [SETLOCALscope](https://www.postgresql.org/docs/16/sql-set.html). Private evidence is in scratchpad/reset-notice-20261025.

## Exact-candidate resume assessment (prepared, not activated)

`.github/ci/resume-assessment.mjs` assesses one historical attempt against a complete plan that its caller must independently reconstruct from source. It shares the existing strict per-unit validator with final verification. The assessment preserves every required unit, schedules missing/red/skipped/incomplete/unhealthy units fresh, and refuses a changed candidate/controller/baseline/environment/coverage fingerprint. It explicitly has no release authority, emits no PASS receipt and cannot authenticate archives itself. An authenticated archive-to-report chain remains required. All six non-test prerequisites, including compiler/build/migration checks, stay fresh in this initial proposal.

Nine assessment/refusal tests plus the130existingpure integrity checks passed locally. Against previously API-digest-authenticated/reconciled full401861 evidence, it identified22potentiallyreusable units covering24,247passing assertions and scheduled the failed256-file noDBunit fresh. This is a historical analysis of ba2142 only, not evidence for current3dd and not permission to deploy either failed attempt. The initial assessment deliberately refuses cross-commit repairs: safe reuse after a code repair requires independently validated impact/input provenance and remains unfinished.

Before activation: implement a versioned resume workflow and independent operator revalidation binding repository/run/attempt/job/controller identities, authenticated immutable archive digests, complete independently reconstructed coverage and environment, freshness, latest failures and the full attempt history. Preserve original red observations; never select an older green to hide a newer failure. Revalidate each selected unit and every fresh prerequisite at final assembly. Policy/bootstrap validation and a complete representative healthy deployment are still required. Existing unmerged local ADR0133/checkpoint code is design context, not GitHubv2 authority. No active workflow/release policy was enabled or changed by this assessment.
