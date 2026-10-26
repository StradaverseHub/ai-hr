# Alpha/staging GitHub Actions

Repository and branch policy: [Repository and environments](REPOSITORY-AND-ENVIRONMENTS.md).

## Efficiency review and free runner policy — 26 October MYT

Use only standard GitHub-hosted public-repository Actions; the owner explicitly forbids paid larger runners and spending-limit increases. The public ubuntu-24.04 standard size is four CPUs/16GB RAM. The earlier private included-minute holds are superseded; storage allowances remain separate. See [repository capacity policy](REPOSITORY-AND-ENVIRONMENTS.md#public-repository-actions-capacity).

The efficiency review branch's version8 execution completed all23test units and28,005cases in40290170108, but the workflow failed one controller import-path test and its dependent verifier. Its narrowly scoped repair passed in40292314938 while retaining valid unit evidence. That is not a complete CI release receipt, deployment arrival or under-ten-minute result. The complete attempt took701.09s before deployment. These review-branch improvements have not been promoted into the default main/alpha controller. [Current evidence and remaining work](RELEASE-PERFORMANCE.md).

## Current rollout

`alpha-staging-ci` runs on GitHub-hosted Ubuntu runners. The workflow/controller is published on default `main`; it checks out the requested candidate separately, at an exact SHA, without modifying that candidate's tracked files. This allows the Board 3 pilot to run while `alpha` remains pinned to its verified deployed release. CI on `main` does **not** deploy main.

Staging environment branch policy permits only `alpha`. `STAGING_DEPLOY_ENABLED=false`, `PRODUCTION_DEPLOY_ENABLED=false`, and `STAGING_RELEASE_OWNER=board3-pending-verified-release`. This workflow has **no SSH/deployment credentials, deployment job or production target**. Its deployment-hold job verifies both switches remain disabled. Creating an environment is not activating deployment.

Board 3 retains staging release ownership. The owner authorized replacing its duplicate local full gate with a complete validated CI witness. The versioned [CI staging verification policy](CI-STAGING-VERIFICATION-POLICY.md) defines that evidence and an operator adapter which uses the frozen candidate’s official deployment helpers. Automatic staging CD remains disabled; the coordinating release owner operates the adapter with existing operator access, verifies arrival and advances alpha. Main deployment stays disabled until the separate live installation is ready.

## Run a frozen candidate

After the release owner freezes and publishes a clean same-repository pilot branch:

```sh
gh workflow run alpha-staging.yml --repo StradaverseHub/ai-hr --ref main \
  -f candidate_ref=codex/board3-ci-pilot-20261025 \
  -f expected_sha=THE_EXACT_40_CHARACTER_CANDIDATE_COMMIT \
  -f test_parallelism=20
```

The resolver refuses a moved branch, a different repository and invalid refs. `STAGING_DEPLOYED_SHA` must be the verified deployed staging baseline, used for append-only journal and unchanged applied-SQL checks. It is a migration baseline, not a test receipt.

Ready same-repository PRs targeting `alpha` and pushes to `alpha` are also declared triggers. **Those triggers become effective on alpha after its release owner integrates the workflow/helper files into that branch.** Publishing only the controller on main does not install workflows on alpha. During the coordinated freeze use the manual exact-commit dispatch above. Fork PRs and draft PRs do not run this workflow.

## What CI checks

- Whole-repository type check on pinned Node 22.23.3 and production build on Node20/Linux. The isolated first-attempt typecheck integration uses an authenticated graph or mandatory cold compiler with validated compiler-only disk capacity; see [normal compiler cache](NORMAL-COMPILER-CACHE.md). Its actual normal helper/wrapper passed independently authenticated cold-fallback and fresh-runner managed-restoration pilots (full 7,060-file compiler 338.924 s → 20.329 s; complete pilots 416.298 s → 97.755 s). Complete normal workflow/release adoption remains unverified. Other jobs retain the existing unused-SDK cleanup; compiler reruns retain the legacy20GiB admission guard. The compiler uses an 8 GiB heap and, on small runners, a job-owned bounded 4 GiB swap file with exit cleanup; it does not change the Mac or staging host.
- Controller integrity and refusal tests, plus tests exercising the frozen candidate’s actual detached-deploy polling helpers with fixture transport (including disconnects and failed or stale builds).
- Journal prefix and applied SQL bytes against the staging migration baseline.
- The candidate's existing deterministic DB classifier partitions the complete tracked Node/DOM inventory into content-addressed batches: at most 256 no-DB files or 64 DB files per job. Required job/artifact sets derive independently from that manifest. The standard-runner concurrency now defaults to20, with explicit4/8/16/20 choices; it does not change coverage. A source-only inventory onbf3868aa8 found20 Node/DOM units (16 DB,4 no-DB), so the older16 default queued four units within the test matrix. Browser and other required jobs remain separate. Actual whole-run queue/cost improvement remains unmeasured. [GitHub standard-runner limits](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners) are account-wide; this change requests no paid runner or additional test unit. No-DB jobs receive closed-port database URLs. DB jobs use separate 2 GiB PostgreSQL 16 containers on disposable runner disks, two test workers and server-default JIT on. Each successful DB batch and terminal state must have validated actual cap, peak memory, zero OOM kills, live-server and JIT settings evidence before cleanup. They never contact the Mac or staging database.
- Existing browser suites run in Chromium, Firefox and WebKit. Runner-generated ignored config selects the actual engine while preserving candidate source.
- A final verifier refuses absent, duplicate, foreign-commit, skipped, failed or zero-test evidence, and checks every expected file and assertion count. Artifacts identify both candidate and controller commits. Matrix jobs do not stop the other jobs on failure.

`gate-evidence` remains a distinct **CI receipt** under the review implementation’s `aihr-staging-ci/v8`. The operator verifier authenticates the successful run, all required jobs and all artifact digests, recomputes source classification and validates every executed report before accepting it. No `.gate-receipt.json` is manufactured, and partial runs cannot be combined into a PASS. Version8 retains complete coverage and authenticated compiler/build packet boundaries with duration-balanced database groups and within-project ordering; optional graph artifacts never supply test-unit or gate authority. A diagnostic-only success is not release evidence. Policy or controller repairs require a fresh whole run on the final controller commit.

Node/DOM unit artifacts are retained for 14 days; the final CI receipt for 30 days. Staging secrets are absent from every verification job. Read actual workflow conclusions and artifact totals; a workflow being installed or dispatched is not a passing pilot.

## Focused diagnostics

`alpha-staging-diagnostics` is a separate manual-only workflow. It checks out the exact candidate and collects measurements on isolated standard Linux runners. It cannot authorize release and emits no gate receipt. Original failing Node/DOM files run separately with their original assertions and timeouts; explicitly labelled ignored copies record timing and disabled-button transitions. Browser replicas record computed font/style/geometry and PNGs in three engines. Schibsted used with Classic geometry is explicitly a proxy, not actual Classic Jakarta; Monolith replica measurements are not an authenticated application walkthrough. Diagnostic artifacts remain separate from the full gate, and individual failure exit codes are retained.

## Application compiler/build diagnostic — 26 October MYT

The default-off next_build_cache_phase input in the existing diagnostic workflow now supports cold, compiler-only recovery and warm. The [independently verified warm canonical build](NEXT-APPLICATION-COMPILER-CACHE.md) preserves all application roots, fresh build identity, actual type-error refusals and cleanup; it supplies no full-test or deployment receipt. Normal production-build cache/capacity/promotion adoption remains unfinished. The GitHub migration baseline was reconciled to verified staging fbef after fresh status/service/root checks; always refresh real state rather than treating that dated value as permanent. Both deployment enable switches remain false.
