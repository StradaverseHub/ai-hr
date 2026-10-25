# r395 write-equivalence savepoint cleanup

This is a prepared optimization candidate, not a measured speedup or release proof. Do not adopt it into Board 3's frozen local verification.

## Preserve the security proof

`test/r395-write-path-equivalence.test.ts` compares the same INSERT/UPDATE outcomes under current policies and the historical USING clauses, with explicit protection for the current Profile and Feedback graphs. The real hire path, administrator refusal mutation, row-returning writes, cross-company/tenant contexts and restoration assertions remain required.

| Original group | Cases retained |
| --- | ---: |
| Setup and policy/builder inventory | 1 |
| Generic writes for all 24 contexts, plus non-vacuity | 25 |
| Person/employment/assignment writes, plus aggregate check | 25 |
| Parent/child data-modifying CTEs | 24 |
| Rolled-back administrator refusal mutation | 1 |
| Real hire service comparisons and live-policy restoration | 12 |
| **Total** | **88** |

All original registration expressions, callbacks, assertions, table-driven values and timeouts are unchanged. The source proof collected the same 88 expanded registrations using inert imports, without executing hooks or case bodies. Splitting the generic context table without preserving its accumulated non-vacuity witness would change this proof, so that approach was not used.

## Observed bottleneck

Authenticated full run [40188791293](https://github.com/StradaverseHub/ai-hr/actions/runs/40188791293) reported 609,755.65 ms between this file's result timestamps. Its generic-write group contributed 601,840.64 ms of assertion durations across 25 cases; the 24 context comparisons dominate. These reported test times are not complete job/setup/deployment timings.

The comparison helper creates `SAVEPOINT w` for each statement and always rolls the statement back. It previously stopped at `ROLLBACK TO SAVEPOINT w`. PostgreSQL retains that named savepoint after rollback and retains older savepoints when the same name is reused. See [ROLLBACK TO](https://www.postgresql.org/docs/16/sql-rollback-to.html) and [same-name SAVEPOINT behavior](https://www.postgresql.org/docs/16/sql-savepoint.html).

## Prepared change

After rollback, release the savepoint in the same cleanup request:

```sql
ROLLBACK TO SAVEPOINT w; RELEASE SAVEPOINT w
```

The INSERT/UPDATE SQL, both policy sets, role transitions, result/error comparison, statement order and outer transaction remain unchanged. Releasing after rollback discards no additional row changes: the attempted writes have already been rolled back. Cleanup errors continue to fail verification.

Installed postgres-js 3.4.9 sets no-parameter `unsafe` calls to simple protocol; this supports multiple statements in one request. The cleanup still uses one awaited client call. See the driver's [simple-query documentation](https://github.com/porsager/postgres#multiple-statements-in-one-query). Runtime compatibility remains to be demonstrated on the actual supported PostgreSQL and driver combination.

## Evidence and remaining checks

The source/control-flow probe verified:

- The cleanup SQL and its explanatory comment are the only changes; all 88 registrations remain identical.
- In a documented savepoint-state model, 128 allowed attempts and 128 refused attempts retained identical outcome strings and restored rows. Old code retained 128 same-name savepoints in each sequence; the candidate retained zero.
- Both versions made 384 client calls for each 128-attempt sequence. A candidate cleanup failure propagated.

The model is **not** PostgreSQL execution, proof of memory savings or performance evidence. Private source/probe evidence is in the owning worktree's ignored `scratchpad/r395-savepoint-20261025/`.

After the release owner hands back the Mac resources, run an isolated PostgreSQL 16 semantic probe through the official locks. Verify row/role/session-setting restoration, allowed/refused/error outcomes, outer transaction behavior and repeated attempts. Then compare unchanged full 88-case runs, preserve the named administrator-refusal mutation, record actual elapsed time and PostgreSQL/host resource usage, and complete compiler/build/full release validation before adoption. Keep JIT/resource settings comparable; do not infer a speedup from separate-run timing alone.
