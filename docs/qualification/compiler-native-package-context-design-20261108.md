# Native miniature package context: diagnosis and repair design

Design only from `5c86c5630341c4ea17085b4f8bf8a8171b047b52`. No code, compiler,
resolver, model, process or DB ran locally. Preserve every frozen predecessor.
This remains a miniature experiment, not an application dependency solution.

## Actual native failure

Run42454779620 completed unsuccessfully. Authenticated artifact13606724187 ZIP
SHA256 `48d10c5e8ea5628ac961ca57babcbc1a90cd9421422946e434b89d19869099e7`
was independently rehashed. Inventory, solution graph, expected missing-output
refusal, both native project emissions and both inspections passed. The corrected
original-JSON-context assertions passed before the next phase. Owned-declarations
then returned exactly one genuine TS2307 at emitted/producer/index.d.ts line2:
its fixture-external type import cannot resolve. Options/global/syntax diagnostics
are empty; no fixture-external file appears in that Program. The remaining five
phases are explicitly blocked. This is not a compiler OOM or a PASS.

The actual package exists only under private source/node_modules/fixture-external.
Its declaration has93bytes/SHA256
`38a6bfb17b33b2a8c87daf3f85253e90be6b3ebcd30253a4c4d4de83a04a1cd9`,
exactly the existing fixed source fixture bytes. Native inventory records its
package identity as name fixture-external, subModuleName index.d.ts, version1.0.0,
mode99 and extension.d.ts. Original source imports can find it. Emitted declaration
imports start below projects/emitted and cannot search a sibling source directory.

## Native-resolution basis

Consulted8November2026:

- [TypeScript module reference: node_modules lookup](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node_modules-package-lookups) describes per-importing-file ancestor package lookup, including bundler mode.
- [Pinned5.9.3 moduleNameResolver.ts](https://raw.githubusercontent.com/microsoft/TypeScript/v5.9.3/src/compiler/moduleNameResolver.ts), loadModuleFromNearestNodeModulesDirectoryWorker, tries declaration/type targets in ancestor node_modules before JavaScript fallbacks. The observed original package edge confirms that native package lookup, not an injected alias, is in use.

Moving the one fictional fixture package to a common private ancestor makes the
same ordinary lookup available to implementation and native emitted declarations.
That is a layout correction, not permission to suppress the real owned error.

## Proposed implementation after source-design review

1. Stage ONE existing fictional package at private
   compiler-native-reference/node_modules/fixture-external. It is a common ancestor
   of source/producer and projects/emitted/producer. Create the fixed package.json
   and exact original93-byte fixture declaration once, with exclusive writes and
   existing0700/0600 private ownership. No installed package is copied, symlinked,
   rewritten or borrowed. No second declaration copy is introduced under source
   or emitted output. No emitted code is installed, served or executed.
2. Keep that package manifest and declaration in the original strict single-link
   input seal. All phases check input seals before launching; final admission also
   rechecks them. The existing read-only hard-link exception applies only to actual
   candidate node_modules dependencies; this privately owned fixture package remains
   strict regularHash custody, never the relaxed dependency-input path.
3. Give outside-source files truthful identities. The exact fixed package target
   becomes external/fixture-external/index.d.ts. Actual native default libraries
   may retain external/typescript/<native library basename> ONLY if both the native
   default-library classification and canonical pinned compiler lib containment
   agree. Unknown outside-source targets refuse rather than being relabelled as
   TypeScript by their basename. Preserve all original implementation/JSON/ambient
   root IDs and complete ordered native source membership. Package manifest custody
   is recorded as input metadata, not mislabelled a checked Program SourceFile.
4. Require source inventory, both original project inspections and owned-declaration
   validation to contain the SAME canonical package file, with exact native external
   classification, non-default-library flag and original body bytes/hash. Preserve
   its independent public native resolveModuleName package identity. Do not accept
   an arbitrary installed package with the same name. Record the exact loaded file
   identity in each existing phase report, without adding a compiler phase or
   treating JSON/caller claims as execution evidence.
5. Positive owned-declaration diagnostics must become empty under the original
   default CompilerHost, actual disk configs/project references and scoped owned
   semantic checks. The external-preexisting phase must STILL obtain actual2304
   from the exact same original declaration's deliberately unresolved external
   sentinel. The declaration body/error is not edited or replaced. The exact
   ambient-loss, source and emitted five-expression negatives and owned-unresolved
   sentinel stay required with their original codes/locations and full membership.
6. Add meaningful source/custody controls for truthful outside-source identities,
   default-library/package mismatch, unknown/duplicate target rejection and strict
   owned package seal refusal on changed manifest/body, with exact restoration.
   No model claims native resolution; real existing13 phases must prove it. Source
   or filesystem controls may grow honestly; no successful old controls are
   relabelled onto changed source and no native phase is silently dropped.
7. Keep all native reader/default-host/implementation-fallback, config/output seal,
   actual JSON source45B versus emitted48B semantic-equality, cold emission, SCC /
   configured-root400/closure600 bounds, process/kernel/clock and budget guards.
   No paths/baseUrl/typeRoots shim, custom resolver/host, synthetic ambient module,
   new declaration type erasure, source-body rewrite, skipLibCheck change or owned
   diagnostic swallowing is allowed.12GiB/720s aggregate/848s supervisor and the
   fixed13-phase list are unchanged.

## Qualification and remaining application obligations

Freeze the implementation, exact full source hashes/inverses and changed controls
for root and independent review BEFORE execution. Hosted source/custody controls
must pass first, then rerun only this failed13-phase miniature with the original
actual envelopes. Compare all phase identities, loaded package bytes, declarations,
semantic positives/refusals, before/after seals, resource use and terminal cleanup.
Retain the original seven success/expected-refusal phases, the additional JSON
context observation, and owned2307 failure under their source;
they are not evidence for the relocated package's new source.

This one fictional package proves only a bounded native resolver/layout contract.
Real application dependencies, package/export conditions, ambient/augmentation
ownership, ordered full inventory, strict declaration consumers and exact full
implementation coverage remain unqualified. Nothing in this design switches the
ordinary compiler, raises resource caps, changes application/runtime code, or
qualifies staging/production. Production remains held.
