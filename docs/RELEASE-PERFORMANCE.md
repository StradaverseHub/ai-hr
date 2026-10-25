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
