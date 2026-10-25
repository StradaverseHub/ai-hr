# r395 write-equivalence savepoint cleanup

## Runtime verification on 26 October MYT

At source `d08aa22c5788cdce421a36542fb1999e0d06738c`, the actual 88-case suite passed without failures or pending cases in 154.219 seconds, including its always-on administrator-refusal mutation. It used an owned PostgreSQL 16 cluster, the standard non-bypass application role, two Vitest workers and JIT enabled. The separate reset-error classifier passed all 12 cases in 0.560 seconds. Private raw results and cleanup are in `scratchpad/r395-savepoint-20261025/application-probe/`. No external optional write-mutation run, production build or full release was proved.

An actual PostgreSQL 16.14/postgres-js 3.4.9 tiny-fixture probe also verified identical allowed/refused/unique-error outcomes and restored row/role/local-setting/outer-rollback state. Six attempted statements retained six savepoints before cleanup and zero after. Median 2048-attempt time was 164.736 ms before and 159.243 ms after; other sizes had mixed results. This establishes runtime compatibility, not a substantial speedup or memory saving. The earlier model and historical GitHub duration are not comparable application A/B evidence. The first probe incorrectly committed a caught-error transaction; its preserved failure was corrected by matching the application's intentional outer rollback, without changing the actual security helper.

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

Installed postgres-js 3.4.9 sets no-parameter `unsafe` calls to simple protocol; this supports multiple statements in one request. The cleanup still uses one awaited client call. See the driver's [simple-query documentation](https://github.com/porsager/postgres#multiple-statements-in-one-query). The runtime checkpoint above now demonstrates compatibility on PostgreSQL 16.14/postgres-js 3.4.9; other environments still require applicable validation.

## Evidence and remaining checks

The source/control-flow probe verified:

- The cleanup SQL and its explanatory comment are the only changes; all 88 registrations remain identical.
- In a documented savepoint-state model, 128 allowed attempts and 128 refused attempts retained identical outcome strings and restored rows. Old code retained 128 same-name savepoints in each sequence; the candidate retained zero.
- Both versions made 384 client calls for each 128-attempt sequence. A candidate cleanup failure propagated.

The model is **not** PostgreSQL execution, proof of memory savings or performance evidence. Private source/probe evidence is in the owning worktree's ignored `scratchpad/r395-savepoint-20261025/`.

The isolated PostgreSQL semantic probe and candidate 88-case run described above are complete. A comparable original-versus-candidate full-suite timing experiment remains outstanding. Preserve the named administrator-refusal mutation, record actual elapsed time and PostgreSQL/host resource usage, and complete compiler/build/full release validation before adoption. Keep JIT/resource settings comparable; do not infer a speedup from separate-run timing alone.
