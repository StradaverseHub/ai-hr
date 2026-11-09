# Compiler trace controller verification recovery

Development verification-only child of68a648ff22cc4e9d1defcca92f6b9c27a0b3c2ab. Both planned chunks reached terminal: actual selected trace42418174429 succeeded; focused controller42418177031 failed1/4 wrappers (3passed,0pending). Failed artifact13592925333 API ZIP digest740ee5f3263adef847dc6f69db57ad229b6518c22ff5fc07ce8d1398e47c7415 was independently matched. No failed workflow is relabeled.

The existing attribution source assertion expected the former incremental-job condition literal. The actual workflow now additionally excludes the closed compiler-consumer-trace intent. The assertion now requires BOTH exclusions plus its original exact compiler flag/source predicate. Workflow, compiler, diagnostic scheduler/limits, application and source f2 are unchanged. The actual successful trace evidence remains bound to its original controller68/source f2/run42418174429.

The existing wrapper now uses bounded spawnSync instead of throwing before child stdout is emitted. It prints real stdout/stderr for both positive and failing outcomes, then still requires no spawn/timeout/output error, no signal, zero child exit, one positive complete native TAP count and zero failures/cancellations/skips/todo. Same30s child/35s wrapper/4MiB output bounds; same four suites. Failed nested output cannot disappear into an exception. No child result is accepted from a self-reported green wrapper alone.

After root and independent review, rerun the affected four-suite wrapper through the standard hosted focused route; its source-only controls are not native compiler execution or release authority. No local application/tests/compiler/DB/runtime execution occurred. Production held; final source/build/browser/load/migration/release gates pending.
