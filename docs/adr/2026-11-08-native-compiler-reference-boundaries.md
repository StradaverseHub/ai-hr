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
configurations and the unmodified pinned native compiler executable for every
implementation project. Use a
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

All native projects share ONE private RUNNER_TEMP emitted tree mirroring the
actual whole source rootDir. Each project retains its own disk config and unique
build-info file. A separate outDir per project with the whole source rootDir
would leave unchanged cross-project relative declaration/JSON imports pointing
into the wrong output tree. The native shared mirror preserves those paths
without alias, resolver, import rewrite or copied assets. Only serial fresh
native compiler processes write it. Precompute exact output ownership from
native parsed source membership before emission: each implementation and its
native JS/declaration paths has one owner; any duplicate/conflicting declaration
or JS writer refuses. A shared JSON context may repeat only for the EXACT same
original source/hash and native output path/bytes. Retain those repetitions as
native observations, not synthetic copies. Small actual native fixtures must
prove cross-project relative declarations plus JSON, and missing/colliding
output negatives before any full-graph qualification. This layout adds no
runtime artifact, application install or ordinary compiler authority.

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
against source and emitted API. Validate every owned emitted declaration in a separate genuine native
phase, described below, without broadening original external dependency policy.


### Native declaration validation

A precise exception to the implementation-project CLI route is required here.
The original skipLibCheck=true skips semantic checks of ALL declaration files,
including our own fresh outputs. Project references do not make those owned
declarations immune to that rule. Do not claim validation from option presence
or ordinary consumer success, and do not classify a failed native CLI as PASS.

Use one separate fresh process with the pinned public TypeScript Program API
and its UNMODIFIED default CompilerHost. Read the exact retained disk-only native
project configs/references and complete current output bytes. Never override
getSourceFile, fileExists, readFile, realpath, module/type resolution or project
reference redirection; no synthetic in-memory source or old diagnostic host is
accepted. Native references still determine every cross-project resolution.

This validation Program uses skipLibCheck=false and noEmit=true. Collect ALL
options/global/syntactic diagnostics, plus getSemanticDiagnostics for EVERY
actual owned emitted declaration SourceFile. Request no third-party semantic
check: original external skipLibCheck policy remains unchanged. Assert exact
nonempty owned output membership, no duplicates/missing/foreign identities,
exact file bytes and no referenced implementation fallback. Retain the full
diagnostic arrays and native source identities. Any unplanned diagnostic fails.
Do not catch/relabel diagnostics or convert a CLI nonzero result into success.

Run actual owned unresolved-type and original five-code API negatives, with
external-preexisting-error controls proving that external semantic policy has
not been widened and owned semantic checking cannot silently introduce any.
Controlled invalid declarations are real retained disk fixtures, not a patched
resolver or memory-only substitute. Native fixture/source ownership separates
intentional negatives from application outputs. This phase and all controls
spend the SAME aggregate720s/per-child12GiB/output budgets; they are not free
checks outside the envelope. The actual native declaration validation remains
unexecuted and unqualified until these observations pass.

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

## Stock database type-boundary experiment: guard-only control

The ordinary whole compiler at source0f50 exhausted its unchanged12GiB heap again after the six Letters await-arm changes; its23 selected native/pure controls passed, which does not establish the compiler cause or a whole typecheck PASS. This experiment is separate from the unqualified native Program/binder context above. The dominant heap cause and current source-coordinate event counts remain unknown.

A direct0f50 CONTROL adds one compile-only, uncalled contract owner, preserving `db/client.ts` byte-whole. Its OLD oracle is the actual unannotated installed `drizzle(pool)` expression with the existing pool type. Finite positive assignments and checked negative cases preserve the complete native Db/Tx API, protected ancestry, `$client`, generic/overloaded method inference, selected rows and nullable joins, writes/CTEs, SQL results and nested transactions. No guard function is invoked, no database opens, and this is not a runtime harness or reduced compiler project.

The prospective direct CONTROL child may name full native interfaces and annotate the existing database value; it must keep this guard file byte-whole and preserve emitted application statements, all original roots, configuration, schema generic, dependencies, pool/transaction/RLS authority and budgets. No hand-written method subset, cast, widened key/row or partial public facade is permitted. Both actual stock full-Program cells need identical cold diagnostic instrumentation and the same added guard root. Source review cannot prove the contracts compile. A separately reviewed closed hosted trace mode and actual unchanged ordinary whole-TSC PASS are still required; no upload, native-context qualification or release follows from this source experiment.

## Corrected positive native type fixture

The original unrun CONTROL3f654de6352ee7a211f2b707d21a0ae552f75cd4 and CANDIDATEf9ffa0bd0e9425fa228ffdf90b3f4a344276603d omitted required person.primaryEmail from one positive insert contract. Root and independent full source review identified the same soleP2 before any publication or compiler run. This fresh direct0f50 CONTROL adds the fictional required email only to that positive input, preserving every other guard byte and all12 checked negative controls. The original frozen pair remains source-review history, never a runtime failure or passing compiler baseline. Its prospective direct child must reuse this corrected guard whole and the original application's exact type-only delta. All compatibility, trace, ordinary gate and release claims remain open.
