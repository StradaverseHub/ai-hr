# Personnel search test separation

This changes test organization only, on an isolated branch after frozen application candidate `ba2142efbc2e181134d30d1e45740a36d55e29e8`. It does not change the current Board 3 release candidate or deploy anything.

The original personnel test file had file-wide database reset/seed hooks. Its six pure search/URL cases and seven static layout/wiring cases therefore paid for a database fixture, alongside its three actual permission cases. Pure search rules already had a dedicated fast suite.

## Retained coverage map

| Original protection | Retained check |
|---|---|
| Partial employee ID and separator normalization | Existing matching and separator cases in `test/employee-search-shared.test.ts` |
| Partial/case-insensitive name, exact-ID ordering, stable ties | Existing matching/ranking cases in that same fast file |
| Empty query, explicit result cap, missing employee code | Existing empty/cap and missing-code cases in that fast file |
| Default cap, prefix priorities, one shared implementation | Existing fast cases retained unchanged |
| URL, preserved tab and encoded employment ID | Original three URL assertions moved verbatim to the fast file |
| Scoped list excludes another company; direct profile refusal; group-admin positive control | Original three real PostgreSQL cases retained unchanged in `test/personnel-full-width-search.test.ts` |
| Container width, both switcher mounts, malformed-ID guard ordering, plain-data client boundary, six catalogues | Original seven contract cases moved verbatim to `test/personnel-search-layout-contract.test.ts`, without DB hooks |

Five duplicate pure-case registrations are consolidated into the existing tests, not replaced with a weaker assertion. Static contracts and real authorization checks remain separate. The expected reset/seed call count for this personnel file falls from sixteen to three; actual profiling must confirm this before reporting a measured improvement.

Compare immutable instrumented baseline branch `codex/test-profile-baseline-20261025` with the optimization branch, using the same controller, standard runner, two workers, PostgreSQL 2 GiB/JIT-on settings and profiling flags. Run all three retained suites plus profiler-transparency guards; preserve raw results and phase counters. Timing comparisons are observations, not full release evidence or proof of the overall ten-minute goal.

## First measured comparison

Authenticated completed runs [baseline 40186855178](https://github.com/StradaverseHub/ai-hr/actions/runs/40186855178) and [optimized 40187013395](https://github.com/StradaverseHub/ai-hr/actions/runs/40187013395) used the same exact controller `11a412b5689d2d2e8cb4228512f1a3ffd18bc4ca`, standard Linux runners, two workers, PostgreSQL 2 GiB/JIT on and profiling settings. Both whole-repository typechecks passed. Raw selected-file results were independently revalidated, including every file/case and no skipped assertions; the artifact ZIP digests matched the authenticated API.

| Measurement | Instrumented baseline | Separated tests |
|---|---:|---:|
| Reset calls | 16 | 3 |
| Sum of reset durations | 8,787.53 ms | 1,519.16 ms |
| Seed calls | 16 | 3 |
| Sum of seed durations | 640.92 ms | 105.17 ms |
| Personnel DB file duration | 10,199.23 ms | 2,099.83 ms |
| Passing selected cases including four profiler guards | 29 | 24 |

The five-case count reduction is the mapped duplicate consolidation above; all three RLS cases, seven source contracts and original URL assertions passed. This is one measured comparison, not a universal speedup or full release proof. Different template migration times also demonstrate VM/run variability; inclusive phase totals are not pipeline wall time. The complete under-ten-minute release goal remains active and unachieved.
