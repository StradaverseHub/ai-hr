# r395 write-equivalence performance and preservation

## Two-part write-context candidate — hosted runtime verified

The measured50-file run40275058443 passed the original88 write cases, but this file took529.998s after an80.604s start delay. Its24generic caller cases account for524.506s of reported intervals. Ordering addresses the start delay; it does not remove the sequential caller loop.

The new candidate retains all88original expanded cases across two independently isolated Vitest files. The primary keeps12generic contexts plus all63other setup/handwritten/CTE/real-hire/restoration/mutation cases. The secondary contains the remaining12generic contexts, repeats the canonical employee0 and group-administrator16 as additional controls, and independently requires the same >=40 tables with allowed inserts, RLS-refused inserts and returned updates. Primary already includes both controls and retains the original non-vacuity assertion. Total write cases become91; three extra checks are not replacements for original coverage. Each comparison still executes the identical SQL, both policy sets, role transitions, returned-row/error comparison and rollback/release logic. All original per-case/hook deadlines remain.

The fixture lives in test/r395-write-fixture.ts and registers once per isolated file. Existing current Feedback/Profile policy snapshots, real hire cases, committed-policy restoration and always-on administrator-refusal mutation remain unchanged. The context0/16 identities and total24 are checked after fixture setup. R395_REPORT now writes explicit .primary.json/.secondary.json suffixes; neither partial tally silently overwrites a shared aggregate path. The old frozen slow-r395 diagnostic remains pinned to its original ba214 source; use both current files for the new candidate.

The immutable source oracle in .github/ci/diagnostics/fixtures/r395-write-before-split.ts.txt is bound to the original file at2a83c8c84. A closed source-preservation reader reconstructs permitted moves and rejects modified callbacks, queries, savepoints, original63other cases, thresholds, missing contexts, mutation removal, report collision or oracle replacement. All8dependency-free preservation/refusal controls passed in52ms locally, with no application imports, database, compiler, Vitest or Mac slots. They also run before expensive hosted checks and in the normal controller. This is source evidence, not runtime or full release proof.

The partition weights280.429s and293.485s are sums of old reported case intervals, including the extra controls. They are scheduling estimates, not measured split wall time or a predicted speedup. Both complete files have now passed on the same existing2workers/2GiB PostgreSQL/JIT-on budget, as detailed below. No full release, compiler/build/staging or under600s submission-to-arrival claim is established.

### Actual included-runner result

[40283271315](https://github.com/StradaverseHub/ai-hr/actions/runs/40283271315), exacte9b21688b7cdd35d02ba20847a55abca735747d3, passed91/91 cases with no failures, pending, skipped or todo cases. Independently authenticated API/job/ZIP/source review reconciled every original88expanded name exactly once against the actual a025 report, and proved the frozen source oracle equals that original run's source file. The three additions are precisely the two repeated caller controls and the secondary non-vacuity assertion. Both actual table tallies show48/50 insert tables with an allowed attempt and48/50 with an RLS refusal; unchanged returned-update thresholds also passed. All original real-hire/CTE/admin-mutation/restoration cases passed.

Primary76cases took166.229s and secondary15cases168.862s between raw file timestamps. Actual Vitest179.61s; complete DB phase202.327s; submission-to-last-job346.249499s (**5m46s**).339occupied runner-seconds is not billing. PG16.15/JIT on remained within2GiB, peak588,791,808B, all OOM/max events0; canonical stop and alwayscleanup succeeded. One actual ordered split run is not a paired causal speedup against the earlier50-file workload or the Mac. No compiler/build/full regression/deployment ran.

Artifact12632554513/1,362,210B ZIP SHA256c600b9928df37ae2ef354702928381de832cb086044082b26a45a69ed4301915. Raw evidence, exact91-case comparison, independent actual48/50 tallies and source/resource checks are retained under ignored scratchpad/r395-context-split-20261026/actual. The diagnostic server log was collected with its original16MiB cap; it is not claimed complete. Independent bounded terminal log tail, process/cgroup/settings and all assertion reports were validated. Scheduling hints now use the two actual file intervals, retaining this exact origin and no PASS authority.

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

At the savepoint-only revision below, all original registration expressions, callbacks, assertions, table-driven values and timeouts were unchanged. The source proof collected the same 88 expanded registrations using inert imports, without executing hooks or case bodies. A naive split would lose the accumulated non-vacuity witness and was rejected. The subsequent two-part candidate above retains every original comparison and adds independent administrator/employee controls with the original thresholds in each part; runtime remains pending.

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
