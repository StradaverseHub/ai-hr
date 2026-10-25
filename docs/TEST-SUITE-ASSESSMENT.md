# Automated test suite assessment

Assessment date: 25 October 2026. Read-only audit of frozen candidate `44541e31af316179cc81ff264e840ae77c1b706a` and authenticated complete failed CI run [40179027150](https://github.com/StradaverseHub/ai-hr/actions/runs/40179027150). This assessment neither removes required coverage nor authorizes release. Failed-run timings include environmental faults and cannot establish healthy-run performance or a promised speedup.

## Verified inventory and cost

- 1,944 Node/DOM files: 1,637 Node files and 307 DOM files. The executed classifier partition was 981 DB and 963 no-DB files.
- 16 real-browser files execute in three engines, giving 48 browser file executions.
- The completed run reported 27,823 test cases: 27,070 Node/DOM cases and 753 browser cases across three engines. These are reported cases, not a count of individual `expect` assertions or distinct user outcomes.
- DB files account for 271.35 minutes of summed reported file duration versus 18.06 minutes for no-DB files: approximately 94% of their combined reported duration. Jobs and workers overlap; these numbers are NOT elapsed CI wall time. The whole failed run took 63m27s.
- Median reported DB file duration was 10.20 seconds; median no-DB file duration was 176 ms. Nineteen DB files exceeded one minute. The ten slowest DB files account for 20.9% of summed DB file duration.

Slowest passing files in that run:

| File | Reported file duration | Cases | Review focus |
|---|---:|---:|---|
| `test/attendance-policy-storage.test.ts` | 17m56s | 100 | Cross-module fixtures, real financial workflows, reset/seed and query cost |
| `test/r395-write-path-equivalence.test.ts` | 10m29s | 88 | Security policy equivalence, repeated real SQL and historical-policy switching |
| `test/onehr-service.test.ts` | 7m50s | 167 | Large shared fixture rebuilt before each case; multiple employee and review-cycle operations |

These contain substantial business/security checks; their duration is a profiling priority, not grounds for deletion.

## Why the suite is large

The product tests permissions, tenant/company boundaries, workflows, payroll, documents, imports and historical regressions. Parameterized tests expand one declaration into many cases. The static AST inventory found 877 parameterized registration sites and 288 round-prefixed filenames. Neither is evidence that a case is unnecessary; filenames and case counts do not measure protection.

A static scan found file reads in 705 test files, including legitimate fixture reads. This is a review population, NOT a count of brittle source guards. Source-text checks can protect explicit wiring contracts, but they do not establish that the running user journey works. Each must be reviewed for the actual failure it detects.

Exact callback-text matching found seven cross-file pairs (14 callback registrations). Identical text can call different imports or fixtures; this is only a candidate list, not proof of redundancy. Broad deletion is unjustified from this scan.

## Concrete inefficiencies and failure amplification

1. **Expensive isolation:** the candidate's `test/harness.ts` lists 216 tables in its shared TRUNCATE/reset helper. The AST scan found direct reset calls in 897 files, with 915 call sites, often inside repeated setup hooks. Call-site counts are not runtime invocation counts. Reset/seed time must be measured separately before attributing all DB cost to cleanup.
2. **Mixed test layers:** `test/personnel-full-width-search.test.ts` has file-scoped `beforeEach` that resets/seeds a database and adds another company/department, including before its pure search-rule cases. Some matching-rule bodies repeat those in `test/employee-search-shared.test.ts`, which also verifies that the personnel entry point re-exports the shared function. Keep actual scoped-access tests; review consolidating pure-rule coverage in the fast file and scoping DB fixtures to DB cases.
3. **Existing optimization, not a new proposal:** `test/global-setup.ts` already migrates a template and clones worker databases. `migrateTestDb()` in the harness is intentionally a no-op. Removing its old call sites does not remove repeated migration cost, because that cost was already eliminated.
4. **Resource and query failures:** a 1 GiB PostgreSQL cap OOMs even on the released baseline. A controlled 2 GiB comparison removes OOM but retains organization-test timeouts; snapshots show individual queries active for roughly 14 seconds without a reported blocker. In controlled diagnostic run [40185152304](https://github.com/StradaverseHub/ai-hr/actions/runs/40185152304), the same original organization file at 2 GiB with JIT disabled passed all 26 cases in 5.37 seconds; the earlier 2 GiB default-JIT run still failed two cases. The paired explicit JIT-on repeat [40185150122](https://github.com/StradaverseHub/ai-hr/actions/runs/40185150122), with the same frozen source/controller, cap and workers, reported 23 passes, three failures and 81.80 seconds for that file. Actual settings confirmed JIT on/available versus off. This supports investigating query-local JIT overhead; it does not authorize blanket database configuration changes or hiding failures with larger test timeouts.
5. **Unreliable interaction contracts:** loaded instrumentation proved an allocation test clicked a visible but disabled Confirm button, which enabled 18.557 ms later. Original import tests repeatedly read/parsed catalogs or assumed asynchronous workbook completion within a short generic wait. Their targeted repairs preserve business assertions and address observed mechanisms.
6. **Incomplete experience claims:** the repaired topbar browser tests run real browsers against a component harness. They protect geometry but are not complete authenticated login-to-save journey evidence. Increasing their count cannot substitute for actual app walkthroughs.

## Streamlined testing plan

| Area / risk | Appropriate test | Coverage target and example |
|---|---|---|
| Pure calculations, parsers, search, validation | Fast unit tests without PostgreSQL | Distinct input boundaries and regressions; e.g. employee-ID normalization and ranking |
| Persistence, permissions, tenant boundaries | Real PostgreSQL integration tests | Every material allow/refuse boundary and data-integrity invariant; e.g. another company cannot read salary |
| Form interaction and asynchronous completion | Component/DOM tests | Observable success, error and disabled states; e.g. await actionable Confirm, save exact payload |
| Critical complete user journeys | Small maintained end-to-end suite plus experience review | Login as representative role, create/save/reopen, verify authorization and persistence |
| Schema changes | Fresh migration and deployed-baseline upgrade rehearsal | Journal/order/hash correctness, retained data and applicable grants |
| Runtime packaging | Linux production build and staging smoke checks | Exact release builds, starts, is healthy and serves the verified source |
| Source contracts | Limited explicit contract checks | Non-vacuous architectural/wiring constraints that lack a better behavioural check |

During development, run focused changed-behaviour and consumer tests. At integration/release use the validated impact policy; database/security/configuration/unknown changes retain broader required verification. Current release requirements remain unchanged until a replacement is reviewed and validated.

Priorities:

1. Fix measured query/resource faults and flaky asynchronous interactions; do not count environmental cascades as hundreds of distinct product defects.
2. Add per-phase timing for database creation/migration, reset, seed, product calls and teardown on the slowest suites. Report slow-file timings as CI artifacts; count repeated fixtures and actual database operations.
3. Separate pure assertions from DB fixtures and consolidate demonstrated duplicate protection. Require an explicit mapping from each removed check to retained coverage; preserve security, financial and data-integrity boundaries.
4. Review the slowest suites case by case for oversized fixtures and shared mutable state. Consider transaction rollback or narrower reset strategies only where actual connection/transaction semantics and isolation allow them; the app and harness have separate pools, so a blanket outer rollback is not automatically correct.
5. Balance isolated CI batches using measurements, with complete inventory verification independent of concurrency. More runners reduce elapsed time only where independent work exists; they do not repair a slow individual query or reduce total work.

Success means lower median and tail feedback times on comparable healthy runs, fewer infrastructure/flaky failures, and demonstrated retained outcome/security coverage. A smaller case count alone is not success. No numeric speedup or safe deletion total is established yet.

## Evidence and references

Raw authenticated artifacts and the reproducible static/timing inventories are retained privately under the controller worktree's ignored `scratchpad/test-suite-audit-20261025/` and per-run scratch directories. Do not commit private logs or environment data.

The approach follows [Google's testing overview](https://abseil.io/resources/swe-book/html/ch11.html) and [Playwright's behaviour/isolation guidance](https://playwright.dev/docs/best-practices). PostgreSQL documents [template copying and its WAL/checkpoint tradeoffs](https://www.postgresql.org/docs/16/sql-createdatabase.html); template cloning is not universally free and is already implemented here.
