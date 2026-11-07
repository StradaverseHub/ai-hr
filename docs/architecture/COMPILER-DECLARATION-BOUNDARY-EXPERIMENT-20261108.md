# Checked declaration boundary experiment

Status: DEVELOPMENT ONLY, unrun. Exact application source38b047c9f465990e3f26295c035ab9f69b3001d7;
controller is an isolated child of6098bb43165891ee06f21821645e89b1e0f67a19.
No application, ordinary compiler, production tsconfig, release verifier, compiler cache,
staging or production source is adopted by this experiment. Production remains held.

## Evidence and decision

The retained whole-program traces42392198414/42396515501/42402718235 use the same
Node22.23.3, TypeScript5.9.3, four-CPU standard runner,12GiB child heap, root config,
lockfile and compiler bytes. Their complete ordered11268-file inventory hash is
64150993b2990e6b4b405a1211037cca665887fb5068f97bebfb3e1e54a5dbbd.
Each trace records8823 configured roots. The historical artifact does not separately
enumerate those root identities; this experiment must capture them, not reconstruct
them from the resolved-file inventory.

Source38's Rewards board check fell34.462→0.169 seconds; agent/profile-date fixes
remain effective. Yet source38 still self-aborted at548.358 seconds, sampled peak
12806716KiB. It completed7003 file checks before its incomplete trace ended. Terminal
GC retained approximately12047MB. These facts justify a retained-program experiment;
they do not identify a heap-object retainer, support adding overlapping trace
durations, or make the last sampled/flushed file responsible for the failure.

## Native graph and complete ownership

Only the opt-in diagnostic loads the pinned installed TypeScript API. It parses the
actual root config and records every ordered root, resolved file and real-file byte
identity, native import and type-reference resolution mode/package identity, triple
slash path/lib reference, package manifest identity and global/module augmentation.
The native resolution hooks delegate to the pinned TypeScript resolver; there is no
regex import graph. Original program count and ordered inventory hash must match.

Actual parsed tsconfig.build.json roots supply the existing application runtime
**seed**, never a reduced verification scope. Its native dependency closure is
closed over SCCs. All original global/ambient context is established through native root/entry
ownership. Imported dependency identities remain pinned; every original resolved
file must be observed across the complete producer/consumer union. Any back-edge pulls its whole dependency SCC into the producer.
Every root of the original tsconfig.json independently receives exactly one primary
producer/consumer owner. Iterative graph traversal avoids a JavaScript stack limit.
Consumer SCCs are packed deterministically to200 primary roots; source dependency
closures over600 identities refuse rather than silently expand the budget. Transitively
rechecked helpers are recorded, not subtracted from original coverage.

Original JavaScript/MJS, JSON, imported mobile sources, multiple package identities,
fontkit declaration, jest-dom/Vitest augmentations and generated Next route types
remain part of the actual graph. Native ambient declaration order and dependency package/module identities
are checked rather than inferred from directory names. The original ambient-file
sequence must match in every checked program; a different merge order refuses.
A separate pinned resolution-only inventory preserves native opaque targets that
are not checked SourceFiles. Those bytes may satisfy native resolution but may
never become roots or parsed/checked sources; they do not inflate11268 coverage.

## Real checked declarations and strict receivers

One fresh process checks the actual producer source under the original strict
semantic options, then emits native declarations with exact single-source provenance.
Only emit settings and fresh nonincremental state differ: declaration-only output,
owned root/output directories, no maps and no emit on error. No isolated-declaration
shortcut, declaration bundler, custom API stub, new any/unknown boundary, inferred
type replacement or compiler root exclusion is introduced. Any native naming,
inference or declaration emission error remains a failure to solve, not a waiver.

Every implementation source requires an actual hashed emitted declaration. Original
declaration files retain their original bytes. The receiver compiler host refuses
producer implementation files before native module resolution can select them.
Virtual declaration paths are backed only by the exact fresh emitted files. Pnpm
aliases retain native realpath/package identity and must resolve to original hashed
files. No source fallback, stale declaration, unregistered source or foreign output
can satisfy coverage. JSON remains an original immutable type-bearing leaf.

The original skipLibCheck=true policy must not hide errors introduced by generated
declarations. A separate program enables declaration checking and requests semantic
diagnostics for **every owned generated declaration**, plus normal syntax/options/
global checks. It does not request new semantic checking of originally skipped
third-party declaration files. Consumers retain the original skipLibCheck policy;
their generated dependencies have already received the additional owned checks.
One diagnostic-only declaration additionally references a deliberately missing type.
The native2304 at its exact file/line is the only permitted diagnostic in that phase;
this proves owned declaration checking actually runs. A skipped sentinel or any
error in an actual generated declaration refuses. The sentinel is not emitted or
substituted for an application API.

The same positive contract is checked against source and declarations. Actual
native negative compilers must separately reject five exact file/line/code cases:
invalid SessionContext entitlements, lost generic Promise result, an invalid inferred
schema column, an invalid employee status discriminant and an invalid typed translation
key. Missing errors, additional/unrelated errors, any erasure and unused suppression
directives cannot count as proof. No ts-ignore/ts-expect-error controls are used.
These contracts test relevant API semantics, not universal type equivalence. The
actual retained application tests and Linux build remain independently necessary.

## Resource and failure protocol

All child programs run sequentially, on one standard4CPU/~16GiB hosted runner,
with a12GiB heap and no incremental/compiler-state reuse. The original120s inventory
budget remains separate. All producer, generated-declaration, source-negative,
declaration-negative and consumer work share **one720s aggregate wall-time budget**.
The controller deducts each completed child before starting another. It never
allocates720s to each partition. The existing20-minute diagnostic job,512MiB file,
1GiB total,16MiB per-child log and free-space boundaries remain bounded. A one-second
external RSS/space/time monitor preserves measurements; a failed/aborted child ends
the experiment. The existing10s forced termination grace cannot become success.

The complete root union, full11268 original resolved identities, every semantic
phase, exact immutable emitted bytes, context order, successful restoration of both
Git checkouts and aggregate budget are all required for diagnostic completion.
Producer OOM, source naming errors, declaration errors, consumer errors, package
resolution drift or budget overrun are useful failed measurements, never PASS.

## Narrow workflow and remaining decision

The existing25-input diagnostic uses one explicit choice:
installer_fixture_phase=compiler-boundary, compiler_probe=true, exact38 source and
its frozen source branch. Every other boolean must be false, cache phase disabled
and all origins absent/empty. Resolve checks the closed intent before dispatch.
Every other job excludes this intent; existing38 attribution now requires phasefull.
Only diagnostic-compiler-boundary artifacts are produced. No normal compiler/cache,
ci-receipt, gate-evidence or release verification path consumes these results.

First freeze and independently review this controller, then run its controller
tests and actual standard-hosted experiment. Neither local compiler/application
checks nor a new full gate are authorized here. A successful experiment would still
require reviewed project/reference and artifact trust design, complete ordinary
qualification, resource comparison and authenticated acceptance before adoption.
No root exclusion, heap increase or release-proof relabeling can fill a failure.

Native emission follow-up:42409150861 reached producer semantic/emission work with
zero diagnostics but refused aggregate emitSkipped. The source-only native-emission
recovery preserves JSON in the original checked Program and requires non-skipped
public native emission for every original owned implementation individually, with
exact complete declaration provenance and a real JSON/native-output control. The
remaining phases, aggregate budget and all release distinctions remain unchanged.
