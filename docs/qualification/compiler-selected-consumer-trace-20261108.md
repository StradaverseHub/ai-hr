# Frozen selected consumer trace proposal

Status: **NOT RUN**. This branch contains controller/verification-only code; application source stays exact f2b1ae1a9af20bdb30f28ed9b537aa08994dfc10. No local application, compiler, DB, build or test execution was performed. Static reads, source hashing, import existence inspection and whitespace validation are not runtime proof.

The paired JSON request fixes all 25 workflow inputs, exact source/ref, consumer indices 7/8/9, expected two jobs and one artifact. Its `sourceSha256` entries bind the reviewed code/document bytes. The controller SHA is supplied by the frozen commit/ref, rather than a circular self-hash. Root and independent source review precede upload/dispatch.

Affected focused selector: `test/compiler-diagnostic-controller.test.ts` (four actual Node TAP suites). The new trace suite has nine declared model cases; actual hosted counts and zero skip/failure/cancellation/todo must be observed, not inferred from this inventory. Resolve also runs the boundary/trace suites and the existing incremental controller suite before source admission. No duplicate heavy compiler run is authorized by the wrapper.

The separate trace invocation must use `alpha-staging-diagnostics.yml`, controller branch `codex/compiler-selected-consumer-trace-20261108`, with expected jobs `resolve` and `compiler-consumer-trace`, artifact `diagnostic-compiler-consumer-trace`. Every other job must be skipped by closed intent. The controller verifies actual hosted/source identities, original raw inventory/plan hashes, native phase outcomes, resource limits and both clean checkouts. The artifact contains native trace/type bytes where actually produced, native result JSON, resource samples/logs, report and bounded `trace-analysis.json`. Missing/partial artifacts cannot become complete compiler evidence.

Retain run 42414030213 unchanged: fresh producer/declarations and both API negative programs passed there, consumers 0–7 passed there, consumer 8 was terminated at aggregate budget and 9 was blocked. They are not relabeled onto this new controller. Prior ordinary whole-program OOMs remain separate failures. This diagnostic does not establish the sustainable whole-project compiler solution.

Application source changed: **false**. Ordinary compiler qualified: **false**. Complete suite: **false**. Release authorized: **false**. Staging deployed: **false**. Production: **held**.
