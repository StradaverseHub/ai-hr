# Owned visibility plan-reuse experiment

This manual diagnostic follows the authenticated one-case [SQL profile40232115042](https://github.com/StradaverseHub/ai-hr/actions/runs/40232115042): the visibility query had3501 calls/3498 plans/4184.636ms planning, no observed JIT, with all time/financial guards retained. Reusing its exact query plan is a hypothesis. No saving or semantic equivalence is proved by source comparison alone.

## Verified limited result — 26 October MYT

[Repaired run40235881438](https://github.com/StradaverseHub/ai-hr/actions/runs/40235881438) on frozen source/controller `86b969ac9e51d05e480573cdba97776acca5397f` passed both phases. Root independently authenticated repository/run/attempt, complete job/artifact inventory and artifact12615046517 ZIP SHA256 `9402557824fd633b8a3e84a79e25f28f865efb3527480f8832fe16ed305e41b3`. It regenerated the exact copy/selection proof from frozen source and inspected raw Vitest, catalog, counter, resource and cleanup records.

| Observed measure | SQL baseline | PL/pgSQL prototype |
| --- | ---: | ---: |
| Selected / registered cases |37 /125 |37 /125 |
| Deliberately unselected, never passing |88 |88 |
| Complete selected Vitest command |51.445s |44.683s |
| Unchanged selected cash-case interval |19.258s |13.459s |
| Canonical target-query calls |3647 |3647 |
| Canonical target-query plans |3644 |3 |
| Canonical target planning |4496.121ms |4.700ms |
| PostgreSQL peak memory |448036864bytes |446189568bytes |
| Minimum sampled source-volume available |10658598912bytes |10653765632bytes |
| OOM kills |0 |0 |

The cash interval was30.11% lower, the complete37-case command13.14% lower, and target planning99.90% lower in this one ordered pair. All original selected identities matched across phases. Function query text and every catalog property except the intended language/source wrapper stayed unchanged, including OID/owner/ACL/security/search path. Both phases passed72 actual queries across24 contexts/two tenants on one reserved non-bypass application connection, with22 distinct visibility sets; real role revocation, login archival, graph expiry and rollback recovery passed, and the entire control transaction was rolled back. Fresh containers, unchanged tracked source and owned-copy/container cleanup were independently checked.

The diagnostic took218s from submission to last job completion and212 occupied job-seconds (3.533 runner-minutes, not billing). Root's private `scratchpad/visibility-plan-experiment-20261026/run-40235881438/independent-review.json` and `cost-report.json` retain calculations and caveats. Baseline ran first; normal compiler/library/OS warming may contribute to elapsed differences. Nested timing overlaps remain. This is37-case coverage per phase, not125 passing cases, a full suite, an applied migration, verified staging arrival or the under-ten-minute release goal.

Actual capacity preparation fell from107406ms in the original failed attempt to314ms here. The new runner began with12810468KiB available and skipped all SDK deletion; the5-second samples above retained more than9.9GiB throughout this bounded scope. This demonstrates that component saving and observed diagnostic headroom, not full-suite capacity safety. Ordinary test/compiler/build job cleanup is still unchanged.

Wider financial/authorization coverage, normal append-only migration allocation, complete release validation and build-once transport/adoption remain required. Migration allocation facts have been requested from AI dev2; its coordination reply is currently behind an automatic approval-review authorization request. No migration number is being guessed and no staging change is authorized by this diagnostic.

## Scope and boundaries

The existing alpha-staging-db-diagnostics workflow adds explicit slow_suite=visibility-plan-benchmark and plan_phases=both (default), or prototype only for a repaired failed prototype. It uses one standard Ubuntu24 runner, PostgreSQL16 with JIT on and2GiB, and one Vitest worker. Baseline then prototype run sequentially on the same VM with fresh owned containers. Each migration/test subprocess retains actual exit/signal/timeout; the database job has a25-minute ceiling. This is a bounded diagnostic, not a ten-minute-release claim. Ordinary workflows, release policy and staging are unchanged.

Original tracked source is never edited during execution. Three labelled ignored copies preserve every original test registration, callback/assertion, data table, timeout and per-case fixture; local import specifiers are adjusted only where their resolved target is identical. The original functions/hooks remain, with an explicitly added beforeAll diagnostic installation hook. One new120-second control is added; no original timeout is raised. Parsing refuses unknown dynamic imports or registry expressions.

There are125 registered cases: the original32 cash/unclocked registrations,87 visibility registrations,5 principal guards and1 new control. Exactly37 execute: the unchanged selected cash scenario,25 existing visibility-context checks,5 existing visibility mutation/restoration checks,all5 principal guards and the new reused-connection control. The other88 are deliberately unselected and must appear skipped, never passing. Actual identities/counts/statuses/process exits must match or the diagnostic refuses. This does not replace the remaining release coverage.

## Function change

The canonical migration0515 file and visibility predicate have pinned SHA256s. Only the worker database function app.visible_employment_ids() is wrapped in PL/pgSQL RETURN with its existing scalar query preserved byte-for-byte (apart from removing its final statement terminator inside the wrapper). Function OID, owner, ACLs, volatility, security mode, search path and every other pg_proc property except language/source must stay identical. Source body and function properties are checked before and after installation. The baseline only observes its original SQL implementation; the prototype accepts only that exact implementation or its own exact idempotent wrapper.

The helper refuses outside a first-attempt manual hosted company-repository run with identical frozen candidate/controller, explicit private plan_base/plan_proto namespace, loopback PostgreSQL5433 and actual owner/worker catalog identity. Each generated hook derives its expected worker name from the actual test/db-names.ts workerDb owner; the bootstrap URL and actual catalog must match that exact name in the explicit private namespace. No worker-name construction is duplicated in the diagnostic. An owned private evidence directory must be verified before any function mutation. No applied migration, server setting/version, production function, trigger or integrity guard changes. No staging credentials are provided. Main/live deployment remains disabled.

## Actual security controls required

The new control reserves one postgres-js connection and verifies the same backend PID throughout. It runs all24 existing fictional authorization contexts across two tenants three times, as the non-bypass application role, comparing the new set with the real per-row authorization function. It requires varied nonempty visibility sets rather than an always-empty equality.

On that same connection it verifies an actual role revocation invalidates the current principal, restores it through savepoint rollback, verifies actual login archival and rollback, expires actual administrative graph edges and requires both changed visibility and recovery after rollback. Every result must still equal the per-row authorization reference. It rolls the entire owned control transaction back and releases its connection in finally. Installed postgres-js3.4.9 runtime source exposes unsafe/release on a reserved client, despite broader type declarations; the control therefore uses explicit BEGIN/ROLLBACK on that client, not an unavailable reserved-client begin method. The original principal cases additionally retain forged-role, expanded-grant, missing-identity, foreign-tenant and actual role/archive refusal; original visibility mutation controls must still catch the removed HOD, company-clamp, validity and termination predicates.

These are proposed controls until genuine PostgreSQL execution succeeds. Pure fake-transport checks deliberately feed stale context, revoked-role, graph and changed-connection behavior and require refusal. Their initial fake savepoint-state failure was retained; only the fake actor lookup was repaired to survive state cloning. No real application/database test ran on the Mac.

## Evidence and interpretation

Retain exact source-copy hashes, all raw Vitest JSON/logs, per-worker before/after function catalog proofs, the actual reserved-connection proof, full counter settings/roles/no-eviction evidence, ranked and specifically captured visibility SQL rows, resource/zero-OOM evidence, process exits, unchanged source and owned-container/copy cleanup. Target SQL statistics include reverted mutation versions; do not attribute all rows to the final function or sum nested/outer times. Baseline precedes prototype, so normal VM warming is a caveat. A prototype-only repair supplies no paired timing comparison.

Before adoption, independently authenticate actual workflow/run/attempt/artifact bytes and inspect every required scope. Any missing/failing control, altered metadata, timeout, eviction, source change or cleanup failure remains incomplete. A diagnostic success cannot authorize release or create a full-PASS baseline. Adoption would require normal append-only migration allocation, genuine security/financial/full-gate/compiler/build checks and verified staging arrival under the applicable policy. The complete required under-ten-minute goal remains unfinished.

The limited genuine runtime evidence is recorded above; normal adoption and wider required coverage remain unverified. This source is not deployed. Planning behavior rationale: PostgreSQL16 [PL/pgSQL plan caching](https://www.postgresql.org/docs/16/plpgsql-implementation.html#PLPGSQL-PLAN-CACHING) and the upstream [SQL-function plan-cache change](https://www.postgresql.org/message-id/E1u02Tn-002Kp0-0Q@gemulon.postgresql.org).

## First execution and guard repair

[First attempt40234316717](https://github.com/StradaverseHub/ai-hr/actions/runs/40234316717) on frozen402bcd1bd failed before any selected case body or prototype mutation. Original migration exited0, but all three suite hooks refused the diagnostic worker-address guard: the canonical name is ai_hr_test_w_plan_base1, while the guard had incorrectly assumed ai_hr_test_w1_plan_base. The raw report has0 passing cases,125 skipped and3 failed suites, so it is not test or performance evidence. Secondary target-query statistics are absent because no scenario ran. Source/copy/container cleanup was terminal and successful. Preserve this failure.

Root authenticated artifact12614720470 with ZIP SHA2568d0fb2dd99edf4cfded0c885ea3b0e03ee083e94e7a7f486ccc167155b5e778c. The repair imports the actual workerDb helper at each generated hook and compares that canonical result with both the loopback migration URL and actual database catalog before any change. It does not accept an unnamespaced/shared database or weaken role/financial/time guards. The exact original pure guard is retained as a regression fixture; actual canonical helper outputs reproduce old-RED/new-GREEN for both phases, with shared/wrong-worker addresses still refused. This is a controller repair; no case passed in the original attempt. A new genuine run is required for both unexecuted phases.

## Measured setup cost and bounded disk profile

The authenticated failed job log records107.406s deleting unused preinstalled SDKs. Disk available before cleanup was12,810,652KiB and after34,226,968KiB. Native npm installation took16s, so SDK deletion was the larger observed setup cost. These are actual step observations, not predicted savings.

The manual selected-case diagnostics now opt into a distinct bounded-db-diagnostic capacity profile: keep an8GiB initial free-space floor, skip fixed SDK deletion when already sufficient, and fail closed on unknown scope or failed capacity measurement. Only the reviewed company-repository manual DB diagnostic workflow may use it. Ordinary test/compiler/build workflows retain the existing legacy cleanup behavior. Before each bounded PostgreSQL phase, require at least4GiB measured source-volume headroom; record five-second available-space samples and the minimum sampled value. This is sampled headroom, not an exact database-volume peak or proof for full-suite disk requirements. Runtime saving and adequate observed headroom remain pending until the next genuine run.

The shell integration check uses fake uname/df/sudo and never deletes an SDK. It proves sufficient-space skip and refusal on bad workflow/profile or failed df. Its initial test expected exit2 for an initial df failure; actual set-e correctly exited1 before reaching that branch. That failed assertion/source is retained, only the fake expectation was repaired, and only that failed group was retested.
