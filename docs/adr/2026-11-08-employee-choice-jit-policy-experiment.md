# Employee lookup JIT planning experiment

Status: **test-only proposal, unexecuted and not approved for adoption**. Base is
`da5b2e81730ea3a92f53ff15a2a16e6fdcbd2ce7`. Production remains held.

## Evidence and question

Preserve hosted run42395640747 and its original artifact
`employee-choice-unified-plan.json`: all seven measurement cases completed,
61 actual native plans across24 case families, unchanged authority/restoration
and work gates passed, while the14-port unified sub1000ms target **failed**.
Initial unified execution was1331.600ms, including986.683ms of JIT; deep execution
was1475ms with about932ms JIT. A foreign-company query with no authorized population
spent799.795ms JIT out of800.516ms execution, with only4 shared blocks and maximum
node work2. These facts identify compilation overhead in this controlled lookup;
they establish neither whole-page/browser speed nor a successful replacement.

The551 unified query improved native repeated-probe complexity but its estimated
cost crosses the existing PostgreSQL compilation thresholds. Test whether the
unchanged query benefits from a narrower planning policy before designing a native
purpose boundary. No function, migration, allocation, app setting or production
deployment is included.

## Closed experiment

| Variant | Reader | JIT | Above cost | Inline cost | Optimize cost |
| --- | --- | --- | --- | --- | --- |
| original | Frozen c2 control | on |100000 |500000 |500000 |
| unified | Frozen551 | on |100000 |500000 |500000 |
| unified-base-jit | Frozen551 | on |100000 |-1 |-1 |
| unified-no-jit | Frozen551 | off |100000 |500000 |500000 |

The runner first asserts those actual default settings and JIT availability. It
refuses a different environment instead of silently changing the control. All
unified SQL objects and bound parameters, expected rows and cursor-body flags must
match the default unified capture exactly. Frozen source SHA256 is
`f2f2bf608e078262905353d9ac9ab3f70242e8656086fd160ab1b69072239517`;
the original c2 baseline hash remains unchanged.

Retain the same50k fictional fixture, native3001+3102/RLS/functions/grants/indexes,
4CPU/16GB runner and database evidence, statistics capture,20s statement timeout,
300ms lock timeout,300s case budget and exact JS Unicode/selection/facet assertions.
Each variant measures all14 whole ports, captures all12 plan families and repeats
the complete native authority/history/revocation controls:56 whole-port entries,
48 plan families and four independent authority results. The original400-ID
assertion, held Access/History writers,25-row bound and default1000ms target stay.
Do not replace the default result with the fastest policy or infer p95/capacity
from these few controlled samples.

## Owned transaction and planning boundary

Only the test interceptor opens a fresh native `single.withTenant` RRRO transaction
on its exclusively owned max1 application connection. It rejects another checkout
before its callback can enter, until the first transaction **and** restoration
proof finish. No helper accepts a borrowed application transaction. Policy is
captured immutably when installing each test's interceptor; all parallel subqueries
inside that one callback see the same stable policy. Fixed transaction-local
settings apply only before the callback. No global/session configuration is set.

Assert actual app role, tenant/user, native active RLS, transaction mode, all four
JIT settings and unchanged memory/time budgets inside every transaction. After
COMMIT or ROLLBACK, observe the same physical PID outside the transaction and
require exact session defaults. `SET LOCAL` unwinds natively; never execute cleanup
SQL in an aborted transaction. Preserve the primary SQL error; if the independent
restoration proof also fails, retain both failures with the primary as cause and
block further cases. Native controls require real22012 rollback, ordinary commit,
concurrent-checkout refusal before callback and the next default checkout for each
policy. Pure tests check error preservation, including synchronous admission refusal.

PostgreSQL makes compilation-cost decisions at plan time; a reused generic plan
can retain earlier choices. Therefore every variant/plan-phase selection issues
`DISCARD PLANS` on that same exclusively owned backend, equally for all policies,
outside measured ports. This retains prepared statements but forces replanning.
No `DEALLOCATE`, role reset or `plan_cache_mode` change occurs. Actual EXPLAIN must
show base-JIT inlining/optimization false and no JIT for the off variant; a query
above the original threshold must actually show base JIT. Persist all executable
plans before rejecting JIT/work/row gates. See the PostgreSQL16
[JIT planning rules](https://www.postgresql.org/docs/16/jit-decision.html) and
[DISCARD PLANS](https://www.postgresql.org/docs/16/sql-discard.html).

The new artifact is `employee-choice-jit-policy-plan.json`, explicitly named for
changed planning policies. Native identity/budget and post-transaction restoration
round trips count in every whole-port timing. Statistics, DISCARD PLANS, telemetry
and artifact writes stay outside it. Pre-measurement simple native lifecycle
controls can warm admission functions; this is disclosed for all variants. The
existing timer abort closes/drains only the owned client and blocks later work.

## Decision gates

Hosted sole native-plan execution, pure policy tests and common complete compiler
remain pending. The existing temporary sole-selector focused route remains the
explicit admission boundary; the benchmark stays skipped elsewhere until that
protocol is integrated into the later admission registry. A successful workflow
means measurement/assertion completion; per-policy latency targets are separately
reported, including the default failure. Release eligibility and production policy
approval remain false unconditionally.

If a policy wins, separately review a fixed typed SECURITY INVOKER native purpose
API with automatic function-scoped settings and unchanged native authorization.
That future design requires its own correctness/performance proof, guarded append
allocation, upgrade/rollback and full-browser/load qualification. Do not ship this
test interceptor or a `SET LOCAL` wrapper around borrowed shared transactions.
