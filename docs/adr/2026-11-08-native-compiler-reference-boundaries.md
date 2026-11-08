# Native compiler reference boundaries

Status: Proposed; source-only design, not a compiler or release result.
Date: 2026-11-08. Decision owner: architecture task; independent review required.

## Context and constraints

The ordinary strict whole compiler exhausted its unchanged12GiB V8 heap. Actual
checked-boundary diagnostic42423098585 on13d5a5d64512d1daa026836b34cb0b043b4a24cf
completed8823 original roots and11268 resolved files in710046 of720000ms, with
4932 producer roots and3891 consumer roots across10 partitions. Its producer
peaked at9295588KiB sampled RSS. That establishes a useful memory hypothesis,
not normal compiler acceptance. Its custom read/resolution host, declaration
transport and hand-owned checks cannot silently become the release compiler.

Keep pinned TypeScript5.9.3, Node22.23.3, original strict options/JS/JSON/ambient
semantics,12GiB per child, standard4CPU/~16GiB host and existing aggregate bounds.
Do not add any, suppress diagnostics, exclude source roots, increase resources,
reuse unchecked declarations or mutate the ordinary compiler/release verifier.
Original failures and independent successful evidence remain attached to their
actual source/controller. No production/staging command is part of this design.

## Proposed decision

Measure genuine native project references next, with actual immutable project
configurations and the unmodified pinned native compiler executable. Use a
source-bound generated solution and complete project ownership inventory. Native
references and native declaration outputs own cross-project resolution. No
CompilerHost monkey patch, fake .d.ts, source-to-declaration path substitution,
resolver interception or copied reduced implementation replaces native checking.

The [TypeScript project reference handbook](https://www.typescriptlang.org/docs/handbook/project-references.html)
describes dependencies through their emitted declarations and requires composite
projects with explicit implementation membership. Its solution configuration has
references and no implementation roots. The initial experiment must validate
those native semantics on the actual pinned version, not infer them from docs.

### Complete graph ownership

Obtain a fresh native parsed root, resolved input/package/mode, ambient and byte
inventory for the exact frozen source. Historical13d counts are observations,
never acceptance constants for a newer candidate. Preserve every original root
exactly once in the owning-project inventory; retain every nonroot implementation,
JSON, JS, declaration, original package identity and resolution-only opaque leaf.
Unknown roots/resolutions fail. Mobile exclusion stays exactly as originally
configured; this does not waive its separately required native compiler.

Use the actual runtime/build-root dependency closure for the producer. Compute
strongly connected components over ALL owned implementation dependencies and
keep each complete cycle with its owner. Condense the remaining graph and choose
deterministic dependency-first topological order. Group only contiguous groups
in that order within the original400-root/600-owned-closure limits. Validate the
contracted graph remains a DAG. Old alphabetic diagnostic batches cannot be
blindly converted to native references: contracting arbitrary DAG vertices can
create cycles. An oversized component refuses rather than dropping a root.

Every dependency crossing project ownership becomes an actual reference to the
owning project. No consumer silently compiles a referenced implementation again.
Native composite membership diagnostics stay enabled. Any source dependency
missing from project files/references is a real failure. Generated graphs and
configs are retained as complete source/run-bound private evidence.

### Configurations and native execution

Each generated config extends the exact original absolute config, supplies only
its complete files and an explicit empty include, preserves inherited paths and
original package resolution, and adds native composite/declaration settings.
The exact emission overrides are noEmit=false, noEmitOnError=true,
composite=true, declaration=true and emitDeclarationOnly=false. Keep every
original semantic option, including checkJs and skipLibCheck, unchanged. Native
JS/JSON emission stays private; none of those bytes are runtime artifacts.
rootDir is the actual source root; output/build-info files belong to separate
owned RUNNER_TEMP directories, never checkout or node_modules. No emitted JS is
installed or served. Output and input containment/hashes are independently bound.

Start cold with no output or build info. Native producer references must finish
before a dependent process starts. Run a fresh native compiler process per
project in native dependency order using -p on its composite config; ordinary
-p does not rebuild missing references. Native reference resolution requires the
previous exact outputs. This avoids retaining every Program in one build-driver
process. Retain actual native diagnostics and exit status, listFiles and emitted
file inventory. Separately compare the native solution ordering/graph, and never
accept an up-to-date marker as a cold semantic check.

Use disableSourceOfProjectReferenceRedirect for declaration boundaries and prove
from actual native loaded files that a consumer did not fall back to a referenced
implementation. All boundary declarations are emitted by the successful exact
producer in the same owned run. Validate their complete hashes/metadata before
consumption, not only a convenient API sample. The
[composite constraints](https://www.typescriptlang.org/tsconfig/composite.html) and
[reference redirect option](https://www.typescriptlang.org/tsconfig/disableSourceOfProjectReferenceRedirect.html)
are native contracts; option presence alone does not prove their execution.

JSON has no invented declaration output. Preserve original JSON bytes and native
module resolution and explicitly enumerate each project's required JSON context.
Use the native compiler's normal JS/JSON emission so JSON assets referenced by
emitted .d.ts files exist at their actual native relative paths. No bespoke JSON
copy/rewriter or emitted import rewrite fills a missing native output. A
[TypeScript investigation](https://github.com/microsoft/TypeScript/issues/58684)
identifies the declaration-only JSON-copy limitation; this motivates the native
emission choice, while pinned-version fixtures must prove its actual behavior.
Shared immutable JSON/declaration context may appear in multiple native Programs;
implementation ownership is still unique. The prior per-source emit diagnostic
observed a native aggregate JSON emitSkipped quirk. Genuine native CLI behavior
must be measured; an empty diagnostic list or partially emitted file set is not
success. Do not replace native emission with the old custom host on failure.

Ambient/global declaration ordering and augmentations are semantic inputs. Retain
original declaration bytes and external context entries in native config order.
If explicit context-only import sidecars are required, they may only import the
exact originally resolved external declaration/package context. They are real
retained source inputs, with complete edges/bytes, not stubs; they cannot import
unowned implementation sources, invent exports or add a new ambient truth. Native
source/context drift blocks. Keep the previous five independent type refusals
against source and emitted API, and directly check owned emitted declarations
without broadening the original skipLibCheck policy for external dependencies.

## Alternatives and trade-offs

1. Continue one retained whole Program: smallest tooling change, but actual
   failures show the current source does not fit the allowed heap. Retrying
   unchanged source does not address its retained graph cost.
2. Promote the custom diagnostic host: already measured complete coverage and
   useful low-memory behavior, but it adds bespoke resolver/ambient/type-output
   trust to ordinary release acceptance. Retain it as diagnostic evidence.
3. Native references with explicit ownership: more graph/config work and native
   declaration build dependencies, with compiler-owned membership and resolution
   behavior and a sustainable place for future modules. This is the chosen next
   measurement, not an assertion it already meets latency/coverage constraints.

No compiler upgrade is bundled. TypeScript6 or native compiler migration would
change a separate broad compatibility surface and needs independent evidence.

## Qualification and release boundary

First review graph/config generation, root ownership, native command constraints
and bounded process ownership through pure models plus small real native fixture
projects. Those fixtures must reject missing owner, cyclic contraction, foreign
reference output, stale declaration/build-info, implementation fallback, JSON or
ambient loss and all existing invalid API cases. A fake compiler model only
verifies orchestration; genuine native compiler fixtures establish semantics.

Then measure the COMPLETE original frozen application graph with unchanged
budgets, all projects and all negative controls. Finish every independent planned
chunk and retain actual failures. Check source/controller restoration, exact
coverage and source/output integrity independently. Partial/unstarted projects
fail. No extra time, lower sampling, omitted phase or adjusted target makes PASS.

Only after the actual native schedule and reviewed source change qualify may a
separate implementation propose ordinary/release adoption: authenticated CI
policy/version/critical source bindings, exact full current classifier/coverage,
cache provenance/invalidation, operator verifier and fail-closed recovery. Until
that acceptance is actually implemented and independently verified, keep
ordinaryCompilerQualified=false and releaseAuthorized=false. This design changes
no compiler command or release decision.

## Next actions

- Independent design review, including native JSON/ambient/project DAG questions.
- Separate owned implementation of native graph/config proof and small native
  fixture qualification; no application rewrite or ordinary compiler switch.
- Complete fixed-source native measurement, then current integration measurement.
- Authenticated normal CI/release adoption only with complete retained evidence.
