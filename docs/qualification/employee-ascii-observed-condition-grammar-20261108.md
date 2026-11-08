# Observed ASCII worker condition grammar: source repair, not qualification

Base: exact2b8c8df9ac6724524eb3e11f93ff387aa459bbb3. Original native run
42448763524 finished7PASS/2FAIL; its failures and successful assertions remain
at that source. Root authenticated artifact13604223147, ZIP digest
 d3b81930ae35bc6bc67ab47737517b9ae5a3c9ae90556e02aa1d4f6c456e4574.
The retained runtime-before-shutdown JSON digest is
25bd8e725e611e3a9896cf7b06a89ff1d123ec78791cd60540a39266a141f0e0.
Only redacted runtime metadata was inspected; no comparator/app/test ran locally.

The actual worker reported fallback `unknown-launch-profile`, binaryBytes0,
scalarCount0, contexts0. Its seven execArgv tokens were:
`--experimental-import-meta-resolve`, `--require`, the redacted fixed Vitest
preload category, `--conditions`, `node`, `--conditions`, `development`.
Actual proc cmdline had9tokens; executable and the entire expected runtime argv
both matched, with the fixed Vitest forks entry category. No private preload
path is copied into source. The previously documented installed-Vitest
separate-token source lead is now confirmed by actual worker observation.

The only parser addition consumes `--conditions` plus exactly one following
`node` or `development` value. Missing, empty, NUL/newline-bearing, production,
foreign, comma-joined and flag-as-value forms refuse. Existing equals forms,
heap4096/6144 forms, duplicate supported conditions and mixed order retain their
prior behavior. Duplicate meta/require owners and all unknown loader/ICU flags
still refuse. No flag normalization, environment clearing or arbitrary value
acceptance is introduced.

A parsed result remains ONLY a preload source-verification obligation. Actual
input-free runtime qualification still independently checks versions, forbidden
startup/current environment, exact locked package/preload/entry bytes, kernel
argv, source/FD identities, binary bytes/digest, intrinsics and exhaustive
scalar/context behavior under the same5s work budget. No caller eligibility
flag, new production mode or reusable qualification token is added. All native
SQL/authority/budget/hydration oracles,9native cases,6benchmark cases, process
adapters, shared kernel, workflow and complete runtime owner are unchanged.

Planned affected pure checks:14runtime-boundary models (original11 plus3
observed grammar/refusal/mixed-duplicate controls), and6launch-observation
models. The old contradictory separate-token refusal observation model now
asserts that diagnostic data AND a recognized parser result cannot activate the
actual input-free owner; the independent runtime forged-profile controls stay.
The seven-token positive uses a fictional preload placeholder; real preload
source/bytes still require actual native qualification, not the model basename.

No checks have run on this candidate. Root and independent full source review
precede hosted pure checks, then actual9native cases; root owns any subsequent
6-case benchmark. No old failure is relabelled, no speed or loaded-browser claim
is made, and staging/production remain unqualified and held. The source manifest
pins all current changed/unchanged source and complete byte inverses to2b8.
Historical2b8 source manifests retain their original identities unchanged.
