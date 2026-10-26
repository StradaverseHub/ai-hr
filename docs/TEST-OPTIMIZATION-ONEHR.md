# Performance-service test split

## Complete hosted split verified — 26 October MYT

[Run40272783633](https://github.com/StradaverseHub/ai-hr/actions/runs/40272783633) passed all four files and **167/167 cases**, with0 failures, skips or pending, on exact source/controller `13983754d88e6847125655bcdf51b832a31072d5`. Root independently authenticated the first-attempt API/job/artifact identities, ZIP digest and raw reports, compared every expanded case name against the original167-case baseline, and rechecked the five split/helper hashes against the original callback/hook preservation proof. No assertion, case or fixture reset was removed.

Actual Vitest printed229.55 s; the DB phase including container setup, migration and tests was257.226 s. Complete submission-to-last-job elapsed459.812963 s (7m40s) and occupied job time453 s (7.55 runner-minutes), not authoritative billing. This focused workflow retained the old unconditional SDK cleanup117.263 s; it did not use the newly measured capacity-aware normal suite setup. Separate-run times do not establish a paired speedup or complete release result.

| Split file | Cases passed | Reported file interval |
| --- | ---: | ---: |
| onehr-service.test.ts |42 |78.192 s |
| onehr-service-written-evidence.test.ts |42 |136.956 s |
| onehr-service-calibration.test.ts |42 |119.817 s |
| onehr-service-moderation-reminders.test.ts |41 |96.900 s |

These file intervals overlap workers. PostgreSQL16.15/JIT on peaked at1,559,334,912 bytes under its2 GiB cap, with0 OOM events/kills. Both the focused runner's owned-container stop and the always-run cleanup step completed successfully. The tracked source stayed clean at the frozen commit. No Mac/shared database, compiler, application build, staging mutation or release receipt was involved.

The authenticated artifact12628199438 is27,035 bytes, ZIP SHA256 `732a5e2484355324a3192473af038fb39889219d2ebe0ed51be9c44140022f1c`. Original API/log/archive/raw report/identity comparison evidence is retained in ignored `scratchpad/onehr-hosted-20261026/`.

Fixture profiling recorded167 successful resets (94.467 inclusive seconds, median0.548 s, p950.702 s),177 seeds (6.869 inclusive seconds), one template migration2.324 s and two worker clones0.596 s total. These overlapping totals cannot be subtracted from wall time or treated as a causal saving. They show that template/database creation is a small component; the actual workflows and SQL remain material. This hosted disk-backed database success does not prove Mac SSD-versus-RAM-disk performance.

The earlier original167-case monolith passed on the Mac in257.97 reported file seconds, while its accompanying attendance suite failed and stopped that old comparison before the split phase. Those observations remain separate. Whole-repository TypeScript previously passed atd08; no new whole compiler or paired performance comparison is claimed by this run. Reconcile the current alpha and complete required integrated validation before adopting the optimized source.

## Purpose and preserved coverage

The original `test/onehr-service.test.ts` proves performance workflows and their Rewards, scope/RLS, written-evidence, AI/privacy, moderation, notification and reminder boundaries. Authenticated full run [40188791293](https://github.com/StradaverseHub/ai-hr/actions/runs/40188791293) passed its 167 cases and reported 536,638.96 ms for the file. The slowest case was about 8.7 seconds; work was distributed across many cases rather than one long assertion. That reported file duration excludes the complete release path and is not a fixture-cost breakdown.

The monolith was byte-identical between the review baseline `ca929f59e` and Board 3's inspected frozen `f20275ffa150ecc41b745f625f085308ea283379`. The split retains every original test registration, callback, assertion, title and timeout unchanged, in original order across these files:

| File | Cases | Original cases' summed reported durations |
| --- | ---: | ---: |
| `test/onehr-service.test.ts` | 42 | 91.01 s |
| `test/onehr-service-written-evidence.test.ts` | 42 | 172.73 s |
| `test/onehr-service-calibration.test.ts` | 42 | 153.97 s |
| `test/onehr-service-moderation-reminders.test.ts` | 41 | 118.90 s |
| **Total** | **167** | **536.60 s** |

These sums map old observations to the new grouping. They do **not** predict new elapsed time, billing or memory use. Existing workers may divide the files, but changed scheduling, contention and module/setup overhead need measurement. No worker count, PostgreSQL limit, isolation rule or job concurrency changed.

Each file retains the original per-case `beforeEach` body: reset and seed, module entitlements, real hire/reporting services, actors, cohort, cycle/policy configuration and review selection. Each retains both original AI mock declarations and its own `afterAll` cleanup. No fixture is shared across cases to obtain a faster result.

## One helper implementation, live per-file state

`test/onehr-service-fixture.ts` owns the five common helpers (`hire`, `view`, `editableDraftKpi`, `complete`, `reviewerPlan`), the unchanged restricted reminder-mail owner helper and the same Kuala Lumpur calendar year derivation. The migration URL in the restricted-owner helper still resolves from the same `test/` directory.

The five helpers read nine live per-file bindings through getters. This retains the original behavior when hooks or cases replace administrator/employee/manager contexts, fixture IDs, review/cycle IDs or peer arrays. Capturing uninitialized values when the suite registers would be incorrect. The source transformation resolved lexical symbols in one file only, changed 49 references, and normalized the five helper ASTs back to their original form to verify equivalence. No complete application TypeScript program was loaded.

## Verification completed and limits

- All 167 registration/callback/assertion/timeout texts matched the original, as did the expanded collection. All four hook bodies and both mocks matched their originals.
- Collection used inert product imports and registered hooks without running them. `import.meta.url` was replaced only in the inert CommonJS collector; actual written source retains it.
- The existing classifier still labels all four files DB-touching. Nothing was reclassified as pure merely to reduce runtime.
- A separate mock helper check replaced fixture/administrator/manager/review bindings and verified that `hire` and `view` read the new values, rather than an early snapshot.
- Source syntax and diff checks passed. Private evidence is retained in the owning worktree's ignored `scratchpad/onehr-split-20261025/`.

All167 split database cases, actual mock/loader behavior and owned PostgreSQL resource evidence are now verified by the hosted run above. A paired original-versus-split timing comparison remains unproved. Any future applicable check must explicitly include **all four files** and count167; the original filename covers only42. Preserve authentic passing evidence, reassess changed scope and complete required integrated candidate verification before adoption. No complete ten-minute release or runner-minute saving is claimed.
