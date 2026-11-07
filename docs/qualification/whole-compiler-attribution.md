# Attribute the complete compiler without increasing resources

This default-off development diagnostic targets only source
`fe26d003b9750478e4d434cc9dd22b59092ae830`. Its focused run42390723421
retains35 passing selected tests and one real route-scheduling failure. Its full
compiler failed with an actual V8 heap exhaustion at the unchanged12GiB ceiling,
591.14s elapsed and12,873,312KiB maximum RSS. No TypeScript diagnostic was emitted.
Preserve both original failures and the successful tests; this diagnostic neither
repairs nor reruns application tests.

The previous exact-source attribution42387121951 againsted188 remains historical
failure evidence. It identified costly whole-catalogue translation inference;
repairac53 narrowed the two measured test boundaries without changing locale
coverage, compiler roots or resources. Run42388908785 then passed the ordinary
compiler at12,841,532KiB RSS. The larger combined source still exhausts the heap,
so that isolated pass does not establish robust combined compiler qualification.
Measure remaining file durations and retained graph growth before changing more
type boundaries. No exclusions, casts to erase checking, heap increase or cached
PASS are proposed here.

The isolated controller reuses `alpha-staging-diagnostics.yml`'s existing
`compiler_probe=true` selector: only the exact fe26 expected SHA chooses this
attribution path. Every other source retains the existing cold/warm incremental
diagnostic and error-refusal controls. No input is added to the existing25-input
workflow. The resolver still requires the existing frozen source branch and
exact expected SHA. Set `nodb_probe=false`, `layout_probe=false` and
`instrument_copies=false`; leave
every other probe false, every transport origin empty and build-cache phase
disabled. Resolution refuses other enabled probes before any dependent job.
No database, application suite, build, paid runner or installation runs.

The job installs all existing web/tooling/mobile dependencies, generates real
Next route types, then checks the complete original project at Node22.23.3,
TypeScript5.9.3 and12GiB heap on the standard4CPU/~16GiB runner. A separate
full input inventory precedes `tsc --noEmit --pretty false --extendedDiagnostics
--generateTrace`; both use fresh owned graph paths, without altered config,
excluded files, cached PASS or source changes. The inventory count must match
any successfully completed semantic check.

Only the fixed owned `diagnostic-compiler-attribution/` directory is uploaded.
It contains input inventory, actual compiler log, trace, one-second process RSS
and current source observations, and a source/controller/hash-bound report.
No environment or credentials are serialized; core dumps are disabled. Source
paths and public TypeScript type displays may appear in the compiler trace.
Preflight requires20GiB free; regular files have512MiB hard limits, combined
observed output1GiB/log16MiB and remaining free space2GiB limits stop the owned
process. Inventory/semantic budgets are120/720seconds plus10seconds termination
grace inside the20minute job. Sampling can overshoot observed byte limits;
per-file limits remain enforced by Linux. Owned compiler state is removed.

TypeScript writes trace events synchronously. A crash can leave an incomplete
JSON array, which remains raw failure evidence; the helper also retains bounded
tail observations. Attribute completed file durations, the final unmatched
checkSourceFile begin and memory growth before choosing a repair. Trace
instrumentation itself adds overhead, so it does not establish original-run
timing or peak usage. RSS samples are not an exact final process peak.

A V8 crash, signal, output limit, timeout or source diagnostic remains failure.
The report always sets `releaseAuthorized:false`; it supplies no gate receipt.
After an identified repair, rerun the ordinary complete compiler at unchanged
coverage/resources. Browser/load and staging qualification remain independent;
production remains held.
