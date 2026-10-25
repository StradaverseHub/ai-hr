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
