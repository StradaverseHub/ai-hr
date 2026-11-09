# Analytics dashboard native statement timing

Source-only candidate; not a latency, browser or release qualification. Parent: a49f7736bf7d9dd63eabea906a65609ce6e0c0ee. Fresh main/alpha controller: 9dd3847b4a3ce9e4cf4df744edcf10b250dcbbb8. Four owned paths: this brief, test/helpers/native-read-observer.ts and the two existing Analytics composition/native-scale tests. All application, database, permission, entitlement, money, export and report bodies remain byte-identical to the parent.

The authenticated parent run42481112365 executed49successful cases; its batched sole-file diagnostic refused admission and was preserved. Unchanged sole retry42481772769 then passed both diagnostic cases. Parent native50k dashboardSnapshotMs measured8003.399745ms; the complete case took166842.394457ms. Eight seconds is unacceptable for the intended experience. These observations establish no current statement bottleneck. The native termination diagnostic also establishes no paired speedup claim; EXPLAIN/warmth and its actual outcomes remain attached to that original evidence.

## One test observer

The seven-case composition suite's real native Tx proxy is now shared through one test helper. It preserves the exact compiled query objects/params/returned-row counts in memory for existing parity assertions, native role/isolation/read-only/backend facts, fail injection, after-query callbacks, original result/error and spy restoration. The seven case bodies and standalone oracle are unchanged. Production has no observer hooks or alternate pool/transaction owner.

New telemetry is separate from those query objects. Each actual query await receives a compiled-SQL SHA256, a structural statement classification, ordinal, elapsed time, success flag and returned-row count. The timing closes before intentional after-query test callbacks, so an injected writer wait cannot be reported as query execution. The shared observer leaves the original active-count lifetime around the callback. It never serializes SQL, parameters, result content, error messages or identities into its new telemetry. The50k invocation disables raw-query capture in memory; results are consumed only by the original product code and whole DTO assertion.

Digest aggregation stores at most128digest/classification keys with counts, sum/max await times and returned-row totals; first256ordinal samples are bounded. Overflow counts and whole elapsed/row/statement totals remain explicit. detailComplete is false on either overflow and the known50k diagnostic requires true. This bounds diagnostic storage, not product queries or result populations. No product truncation, timeout, cache or cap changes occur.

The source-backed Analytics statement classifier labels actual SQL shapes from canonical aliases, cursor operations and projected/table signatures. Unmatched shapes remain unclassified, retaining their digest/time/count; no report or bottleneck is guessed. Classifier version and actual classifier/observer source SHA256 values accompany the receipt. PostgreSQL driver debug alone supplies send-time statements without completion/row counts, so it is insufficient for this measurement.

## Separate50k observation

Every old standalone read, complete export, input, timing and independent fixture assertion remains whole. The existing unobserved13-report dashboard timing and known expected40000headcount/demographics,50000hires/carry,10000terminations and all other facts remain first. One additional instrumented dashboard invocation follows, with identical inputs and one actual ai_hr_app RR/RO frame. Its entire DTO must equal the independently verified unobserved result; active must settle at0/max1, no statement failure/unknown row count, digest totals must reconcile, and every sample has finite nonnegative time/row count. Unknown classifications are exposed, not removed.

The receipt separates dashboardSnapshotInstrumentedMs, total query-await time and the remaining observed time. The remainder includes admission, the observer's identity query and client aggregation/instrumentation; it is not a server CPU measurement. The second call is warmed and observed, so neither its total nor individual durations are an unbiased speedup comparison. No slow-query optimization or new business decision is part of this change.

The existing300000ms budget and fixture stay unchanged. The historical166842ms run leaves about133s of planning room; actual hosted execution decides whether the expanded course fits. Never raise the budget or report a partial observation as complete on timeout.

## Verification

Local verification is source/hash/external AST only. Freeze and perform root plus independent full source review before source upload. Execute only the affected two selectors on standard GitHub-hosted alpha-focused-checks: test/analytics-dashboard-composition.test.ts (seven native cases) and test/analytics-native-scale.test.ts (one native case). Authenticate exact candidate/controller/attempt/repository, all eight actual cases, complete timing receipt, real PostgreSQL budget/health and cleanup. Retain unaffected valid parent evidence at its original source identity. Whole compiler/build remains off while the independent heap-OOM issue is unresolved. No staging/production action or all-module acceptance is authorized.
