# Attendance storage test split

Prepared on the future efficiency branch; **not runtime-validated or adopted into Board 3's active release**.

## Purpose

`attendance-policy-storage.test.ts` reported 17m 12s in complete run 40188791293. A long sequential file sets a floor for its worker regardless of how many other workers are available. This change makes its independent cases schedulable as smaller files. It does not remove financial, authorization, persistence, replay or failure coverage.

## Retained coverage

| File | Coverage | Cases |
| --- | --- | ---: |
| `test/attendance-policy-storage.test.ts` | Source authority, revocation waits and captured duration | 25 |
| `test/attendance-policy-storage-pricing.test.ts` | Pricing, immutable parts and atomic storage refusals | 28 |
| `test/attendance-policy-storage-settlement.test.ts` | Payroll settlement, TOIL, reversal and cutoff boundaries | 15 |
| `test/attendance-policy-storage-unclocked.test.ts` | Unclocked work, routing and financial scope | 32 |
| **Total** | **All original cases** | **100** |

All 47 original registration expressions were moved byte-for-byte, including every callback, assertion, parameter table and explicit timeout. Registration-only evaluation also confirmed the same 100 expanded describe/title/parameter/timeout tuples in the same aggregate order. Product imports were inert stand-ins; no hook, fixture or test callback executed during this proof.

Every file retains the original `beforeAll`, `afterAll` and `beforeEach` expressions. Each case still resets the complete fixture, seeds its own base, enables attendance and initializes its context. There is no shared seeded database state between cases.

## Shared fixture design

The four helper functions live once in `test/attendance-policy-storage-fixture.ts`. Each file creates its own helper instance using getters for its local `b` and `ctx`, plus its existing date function. This matters because original cases replace `ctx` after changing entitlements: importing an immutable context binding or capturing its initial value would change the tests.

The helper change routes its 30 free references through those live per-file getters. An independent AST normalization check verified that all four helper functions otherwise match their originals. The original case bodies, including context assignments, are unchanged. No global Vitest configuration, worker count, database cap, isolation behavior or CI batch policy changed. All four files still classify as database tests.

## Evidence and remaining verification

Private source, generation and collection evidence is retained in `scratchpad/attendance-split-20261025/` in the owning efficiency worktree. The baseline file was taken from commit `a1e9a9575`, SHA-256 `f726ee601ae5689711902602cdb4cbf6df148878454c1eae6b400c7f6c0543c6`.

Completed checks: syntax parsing, exact registration-expression comparison, expanded case-data comparison, unchanged per-file hooks, normalized helper AST equivalence, database classification and diff review. These establish source preservation, not passing database behavior or a speedup.

After reconciling the actually released alpha baseline and obtaining an idle resource window, run all four files against the same isolated database configuration as the original. Require all 100 cases to pass, no skips, complete TypeScript checks and relevant source guards. Compare elapsed time, reset/seed counts and peak resources with a comparable original run. Retain complete release verification under the actual policy.

The scheduler may still place these files in one CI job, and extra file initialization can add cost. Splitting does not automatically increase concurrency or establish the ten-minute goal. Do not adopt a costlier batch reordering or run financial cases concurrently against one shared database to improve the number.
