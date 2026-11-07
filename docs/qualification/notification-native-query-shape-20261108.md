# Native notification guard query-shape experiment

Status: **UNRUN, source only, UNINSTALLED**. Exact parent `dd6e4785112155dda0206336a6209fa61590ac9f`. Root and independent review precede hosted execution. No numbered migration, page catch-up removal, capability/cache/grant change, worker protocol change or performance acceptance.

## Actual cause evidence

Run `42410834063`, source exact dd6, standard4CPU/16GB host, completed all three owned native diagnostic cases. Pure drain/parser run `42410834435` also succeeded. Source/header/PID binding and native logging/guard restoration were checked by those jobs. Twenty-event log is11,001,858bytes, SHA256 `c18fd941ba4c15281142b92d9b43ce480756b4175e45bea697145bb60c802369`, nativePID223/backend start `2026-11-08 04:26:14.249031+08`, actual dedicated `ai_hr_notification_worker` LOGIN. RC/RW,20s statement/300ms lock, JITon/work_mem4MB remained unchanged. All20 native receipts/notices/deliveries committed; final failed/interrupted run is intentional diagnostic cleanup, not finished worker acceptance.

Bounded analysis of2274 actual nested plans found132 executions of the same `admit_login` rejection expression:3448.036ms nested-inclusive total,25.48ms median,1,269,911 root shared-hit blocks. First call50.973ms/43,751hits then stable ~25ms/9,360hits. This is not repeated cold planning. `assert_process_profile` rejection expression executes only twice/58.592ms total; it is not the per-event bottleneck. No JIT documents occur. Static source uses ordinary PL/pgSQL statements, not dynamic EXECUTE; the trace does not establish parse-time cost.

Warm plans show13 allowed API entries merge against5,841 pg_proc rows/3,048hits per call;2300 helper contracts merge against5,826 pg_proc rows and compare full sourceMD5/4,110hits per call; the sequence branch scans3,893classes ×11namespaces with42,823 rejected pairs/call. Privilege functions are evaluated before namespace joins. Top-level sibling facts/project/finish_event calls each occur20times, totaling1097.494/1208.648/1138.929ms respectively; nested totals must never be added to those caller totals.

Original process source `5869b4e6168263404ed054da0433fa2e94a36e94`, run `42407886480`, remains50/51PASS, one genuine30s eight-batch timeout. Five batches/100receipts committed before cancellation. That failed receipt remains failed. The instrumented3.797s twenty-event batch and prior ~5.1s process batches are different jobs/protocols and do not establish an improvement.

## Narrow candidate

`query-shape.sql` is an additive disposable version3 fixture tail. It requires canonical native database binding, inactive/empty authority/run state, actual native relation owner, exact old `admit_login` body/signature/fullmetadata/ACL and all33 existing function-contract entries. It replaces only five expression blocks; four prior SQL source files and three worker implementation files remain byte-identical to dd6. The replacement preserves native metadata/ACL and refreshes exactly its one sealed function entry after verifying that only prosrc changed. Old bodyMD5 `8517a1befa95a7daa5ff621e92f8ceef`; new bodyMD5 `49533d66467b0468d6cb4c1fb0697fe5`.

1. Materialize the exact existing owned-relation target set before owner/forceRLS rejection.
2. Materialize the same non-pg/non-information-schema relation kinds before all existing table/column privilege checks.
3. Materialize the same non-pg sequence set before existing sequence privilege checks. Its original information_schema distinction is retained.
4. Materialize the same non-pg SECDEF function set before existing schema/function effective-privilege checks and API membership.
5. Resolve each existing allowed API OID through a correlated LATERAL lookup with OFFSET0, preserving the original LEFT/missing-row rejection. OFFSET0 is a query boundary, not a result limit or planner-setting change.

All actor/login/role/owner/membership/schema/current-isolation/RC/RW/APIcount/registry/task-key checks and every admission call remain. The entire2300-helper source-MD5 predicate stays byte-identical; it may still dominate. There is no profile/grant cache, removed source check, settings change or assumption of speed gain. PostgreSQL may choose a different plan or the CTE fences may cost more; actual evidence decides.

## Planned hosted proof

Separate native selector: `notification-native-query-shape-native-tests.json`. All51 original native cases remain, including unchanged eight-batch30s assertion and actual source/permission/receipt/kill/recovery controls. One added case independently grants real table-level SELECT, column SELECT/UPDATE, sequence USAGE, an accessible extra SECDEF function and malformed existing API configuration; actual LOGIN admission must refuse42501. Cleanup preserves owned identities. The actual additive SQL reapplication must refuse55000 atomically with unchanged sealed function metadata, followed by a real permitted admission. Expected52 native cases, no skips.

Separate paired plan selector: existing `notification-native-plan-diagnostic-tests.json`, now six native cases: baseline/candidate ×open/empty/twenty. One fixed LOGIN fixture owns sequential native reinstall/clear stages; baseline native SQL+worker bytes exactly match dd6, while the candidate appends the guarded tail. The shared drain/poison owner spans both variants so an uncertain predecessor blocks successor reset. Source hashes, exact PID/start/role/settings, native facts, raw nested plans, before/after guards, elapsed times and root buffers are saved independently for both variants. Complete same-job baseline/candidate native admission call counts must agree. Each case keeps30s/20s/300ms and existing log/memory/host limits. No result is relabeled onto the historical baseline source.

The ordinary uninstrumented52-case run still emits actual per-batch JSONL counter/transition timing; the eight-batch assertion remains160committed receipts +one pending, truthful budget-exhausted status, no uncertain replay. Compare these observations honestly with the retained original failure, not as a controlled cross-job speed claim. A green plan diagnostic is not an eight-batch pass. Full52-native success AND actual plan/counter/walltime review are required before any improvement assertion. Compiler/build and installed capability qualification remain separate gates. Production remains held.

Static-only checks performed: original SQL/worker byte equality, exact function body hash and unchanged full helper source predicate; relative import closure and whitespace. No local application, SQL, compiler, browser, tests or runtime execution.
