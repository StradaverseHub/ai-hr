# Release performance goal

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/RELEASE-PERFORMANCE.md`. Verify current code and evidence before acting.

## Durable performance target

Owner goal: complete all required automated verification and a verified staging deployment in under ten minutes. This summary does not claim that goal was achieved.

Measure submission of a clean frozen candidate through queues, setup, dependencies, all required tests, compiler/build/migrations, authenticated evidence, transport, install, restart, health and exact source/build arrival. Also measure occupied runner minutes; parallel speed and total workload differ. Independent phase times are not a continuous release measurement.

Preserve complete business, financial, authorization, isolation and data-integrity coverage, plus full regression whenever policy requires it. Use standard runners only. Optimize measured bottlenecks without dropping coverage, weakening refusals or relabelling earlier evidence onto new source.

<a id="real-sequencing-integration-and-released-alpha-reconciliation--26-october-myt"></a>
<a id="integrated-source-verified-compiler-held-at-included-allowance--26-october-myt"></a>

Historical v1–v12 timings and logs belong to their original run/source identities. Current executable policy lives in `.github/ci/`, the workflows and [CI verification policy](CI-STAGING-VERIFICATION-POLICY.md). Read current run/job/artifact records to assess progress. A passing build or diagnostic is not staging acceptance or production authority.
