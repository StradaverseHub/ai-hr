# Native usage context without changing the Program

Source-only successor of267dcb7b8bf8866268734944aa8af2adaa2d6696.
Authenticated native run42461765785 is a FAILURE, not an application inventory
or compiler pass. Artifact13610316597 ZIP SHA256 is
cf78c0199b2642e415548d7b14bba6e33667650fd5ffa6f5e20fd82256c71292.
The new source does not relabel that failure or any successful earlier controls.

Actual Next typegen completed638.55ms. Original CLI completed25636.84ms,
peak RSS4361699328 bytes, retaining11255683 log bytes. Original API failed with
code1 after34166.16ms, peak RSS3961589760 bytes. Its actual stack calls
isImportDeclaration(undefined) through getModeForUsageLocationWorker from our
require/dynamic AST branch. Build CLI was blocked. The worker was not OOM-killed
and neither its120s phase nor720s aggregate bound was exhausted. No resource or
timeout increase addresses this correctness error.

## Primary-source cause and narrow repair

Read the exact installed TypeScript5.9.3 API body and public declarations without
executing them. API SHA256 remains
3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675.
Relevant primary code in lib/typescript.js:

- createProgram uses createCompilerHost(options) when no host is supplied
  (around126975); the parser's setParentNodes default is false (around33019).
- collectExternalModuleReferences/forEachDynamicImportOrRequireCall attach
  parents to recognized native imports and selected references (around128434,
  128451 and24056). Require calls receive that handling for JavaScript files;
  a broader TypeScript require-like AST observation need not have a parent.
- getModeForUsageLocationWorker immediately tests usage.parent with
  isImportDeclaration (around126570). This public mode method assumes an actual
  parent; its signature does not make a default Program's entire AST parented.
- Public declarations around6094 and9544 distinguish native undefined mode
  from explicit CommonJS/ESNext modes and support attribute mode overrides.

The new helper first observes the ORIGINAL literal.parent. If absent, it returns
modeObserved=false, resolutionAttempted=false, mode=null, nativeParentKind=null
and resolvedModule=null. It calls neither the mode API nor a resolver with a
guessed/default mode. The worker STILL appends that original syntactic
observation, including source, kind, specifier, position, end and literal kind,
with target=null, and adds native-usage-parent-unavailable as an explicit gap.
It does not mislabel unavailable context as an observed unresolved module.

When the actual parent exists, the SAME genuine public Program mode method and
unchanged ts.sys resolver run. A legitimate returned undefined remains
modeObserved=true and resolutionAttempted=true, serialized as mode=null. The
actual undefined is passed to the resolver unchanged. Explicit modes are passed
unchanged too. Native mode/resolver errors preserve their original identity;
there is no catch-all that turns an unexpected failure into a convenient gap.

No AST parent is written, no tree is reparsed, no synthetic literal is substituted
and no binder, type checker, semantic diagnostic, custom host or compiler option
waiver is invoked. Original roots, native loaded membership/order, input custody,
all other observations and build-CLI distinction remain intact. GraphComplete,
planFeasible, ordinary compiler qualification and five application API negatives
remain false/open. Missing context cannot justify a complete effective graph or
dropping a source. It is retained for the separately reviewed future owner.

## Prepared controls and exact source binding

Four new ordinary guard/source controls test absent-parent no-call/no-mutation,
actual API undefined versus unknown, exact native error identity and modes, and
the complete original-body inverse/current source bindings. Existing15 ordinary
metadata controls stay whole-byte unchanged; the wrapper now requires all19.
Fabricated guard nodes are explicitly models, not native parent/context evidence.

A SEPARATE hosted ordinary tiny default-Program fixture contains two cases. Its
actual pinned API constructs fresh Programs with NO host and checks independent
expected presence of static import, export, dynamic import, import type,
import-equals, JSDoc import, TypeScript require and both explicit resolution-mode
attribute expressions. The real unparented TS require reproduces the original
public API TypeError, while the guard retains its unknown observation. Other
references use actual public resolution; import/require attribute modes have
independent expected native values. A second default Program proves genuine
native undefined mode. Original literal/AST parent reference AND own-property
presence are snapshotted and must remain unchanged. Fixture source bytes remain
exact and no output is emitted. These syntax/context fixtures request no semantic
diagnostics and make no assertion that the complete fixture is type-correct.
They are not the five real application negative contracts or full-app coverage.

No extra Program or phase is added to the application metadata operation. Its
same three observations remain original CLI/API and build CLI, plus normal Next
typegen. The kernel, supervisor, settlement verifier, closed admission and all
resource/window owners are WHOLE-BYTE unchanged. The failed command correctly
caused strict settlement-verifier refusal; this repair does not relax that
verifier or turn a nonzero exit into valid execution evidence.

The active current source map binds all its previous current components plus the
new helper, controls, tiny fixture, wrapper, review and inverse. Its historical
source map stays immutable. The new whole-body inverse retains exact original
267d worker, ordinary wrapper and active-map bytes, and enumerates every added
file needed to restore267d completely. The map cannot hash itself, so its inverse
entry retains its full original bytes/hash without a circular current-map hash.
The other two changed original bodies have current hashes. The original1ff
seven-owner inverse remains byte-exact and still validates its original members.

After root plus independent FULL source review, execute the19 ordinary controls,
the separate TWO tiny native context cases and existing9 Python controls on
standard hosted Actions. Only after those pass rerun the unchanged full native
application metadata selector. Verify actual complete original CLI/API order,
all retained unknown-context observations, complete build CLI membership and
native settlement. Earlier control results and the failed run retain their own
identities. Complete native graph/planning/emission, actual five API negatives,
normal full-CI registration and final current-policy witness remain OPEN.

Only Git, primary-source reading, source AST parsing and static hashes/source
generation ran locally. No repository module, test/model, Program/compiler,
application, build, DB or provider behavior ran. No upload or dispatch occurred
at this freeze. No business/model/migration, AI manifest, human approval or
provider authority changes. Staging and production remain held.
