# Native host receipt binding correction

Exact child of c0456f6a98e5f3feaf11ca4d759d57c8b76e25da. The authenticated
controls run42473405629 remains a PASS on that source: four wrappers and nested
37+21+22+16=96 cases. The subsequent host commissioning run42473841370 is a
preserved FAILURE, not a native conformance witness. Its sole registered
nodb-de684e790b483bf3 unit failed transformation before any test/native entry:
the newly added receipt-local `const keys` at73 collided with the existing
environment-forwarding `const keys` at21 in the same callback. The actual report
has zero cases and one failed suite; no host native report was produced. All13
jobs became terminal before this repair. No full Next run was dispatched.

Actual failed-unit artifact13614771494 ZIP SHA256
abada5db8f54b524b42c203d9126b5d65cca3305ab5fd23b38a817ebd2ad4216;
actual plan13614747255 ZIP SHA256
9437fd9aa7d7b63057a9c2e25957b197256b0cd9c7ce6896c811819d60776051;
terminal refusal-summary13614274117 ZIP SHA256
de1cef7a52033d14c6b0702686f9e3e29cd56a534af18e023e8a659deb8dc3c5.
All18 actual singleton source pins matched c045. These identities preserve the
original failure and provide no transferred PASS or environment/key evidence.

The only executable test change renames that RECEIPT-local binding and its11
references from `keys` to `keyNames`. The old forwarding binding, `Object.keys`
method, receipt field names and every assertion/expression remain unchanged.
All Python runtime owners, tuple-only capture, codecs, native proof, helper
publication, receiver, NextRuntime/guard620, resources and cleanup are byte-exact
c045. Native host case/30s child/35s wrapper and all other budgets remain whole.
There is no allowlist, environment, source acceptance or deployment correction.

Before freeze an external @babel/parser7.29.12 fully parsed the changed `.ts` as
a TypeScript ECMAScript module: sourceType=module, TypeScript dts=false, no JSX,
errorRecovery=false, allowReturnOutsideFunction=false. This is a parser-only
operation, not a TypeScript Program/build, repository import or test execution.
The actual complete frozen c045 file independently refuses VarRedeclaration at73;
the corrected complete file parses with no error. A second source-only AST
comparison used recovery solely to inspect the refused parent AST, normalized
the one renamed local binding and its11 references, ignored source offsets and
the parent's error array, and proved the WHOLE AST otherwise identical. No
property/string/assertion/native call was renamed or weakened. This closes the
specific gap missed by earlier token/syntax-only parsing; native execution still
requires its real hosted witness.

The three existing source-history controls prepend a COMPLETE four-file c045
inverse, then run every immutable capability/key/terminal/phase/environment/CPU/
cleanup predecessor layer. All original37/21/22/16 case names and intentions are
retained. Only those three history bodies change; no new case or wrapper-count
adjustment. The fourth inverse member is the corrected TS host test. Whole
preimages/hashes/descending edits reconstruct actual Git c045 before any older
inverse consumes it. All prior inverse/source maps remain whole unchanged.
The new current map retains88 inherited members with four current overrides and
adds the immutable parent map, new inverse and this record:91 current bindings.

Local work is limited to source/Git/byte/hash/AST/external-parser checks. No
repository behavior, native command, DB, application compiler/build or test ran
locally. Source approval precedes upload and affected hosted controls, then the
same registered native host component. Only a real host PASS permits a NEW
same-run canonical build/full Next attempt on the corrected frozen source;
earlier build reuse and failure relabel remain refused. The unknown actual
initial-environment key/origin remains UNKNOWN. All readiness/full-helper/Next/
release claims remain false until their distinct real witnesses qualify. Staging
and production stay held.
