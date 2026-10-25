# Performance-service test split

This is a source-verified candidate, not a runtime pass, measured speedup or release receipt. Reconcile the actually released alpha before adopting it; do not change Board 3's frozen release.

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

Actual Vitest mock/loader behavior, all 167 database cases, complete TypeScript, timing and PostgreSQL/host resource peaks remain unverified after the split. A focused comparison must explicitly include **all four files** and count 167 cases; testing only the original filename now covers 42. Preserve the original baseline and comparable execution settings, then complete the required full candidate verification before adoption. No ten-minute release or runner-minute saving is claimed.
