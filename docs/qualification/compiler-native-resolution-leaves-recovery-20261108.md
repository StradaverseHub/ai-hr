# Preserve native opaque resolution leaves

Source-only child of88dae55cad5c4b2374a803396af1413c63004e85. Actual run42407473358
remains failed. Inventory passed26.604s/3507608KiB sampled peak. Producer passed the
exact224-file ambient order and both actual global/module overload controls, then
refused external resolution identity after17.922s/1874984KiB, before application
semantic checking. This is neither OOM nor compiler acceptance.

Native TypeScript resolved seven opaque JavaScript/CJS targets that were absent
from both the11268 checked SourceFiles and native first-parse records: punycode,
string_decoder, Next's bundled jest-worker and superstruct, server-only, jsdom and
fontkit. The original full program kept their resolution identity without checking
their bodies under its existing declaration/dependency policy. The receiver host
incorrectly treated missing checked-source membership as an absent resolution file.
Seven vendor edges consequently became unresolved; fontkit is additionally used by
an owned implementation. No original compiler option or vendor opacity is changed.

The recovery records a **separate** resolution-only inventory derived exclusively
from actual native targets outside the original SourceFiles. Each record pins its
logical and real path, bytes, native extensions, resolution kinds and package
identities; it explicitly says unchecked/unparsed. It never increments11268,
claims semantic coverage, adds roots, writes declarations or introduces an any.
An alias to a checked source or an originally parsed target refuses classification.

The compiler host admits only exact original leaf identities/bytes during native
resolution, including native pnpm alias canonicalization. A getSourceFile request
for such a leaf independently refuses before parsing; its positive path is only
file existence/read resolution. Actual hosted controls verify every leaf resolves,
mutated bytes refuse, and source parsing is denied. The native external edge guard
remains exact; producer-owned imports are also checked against their original
module/package/mode identity, including fontkit. Unknown leaves still refuse.

All original source/ambient/declaration/root coverage and checked generated API
guards remain. Default libraries still load natively; context sidecars are not
replaced with vendor source roots. No heap, timer, output, runner, compiler option,
ordinary workflow, public API or release rule changes. The same120s inventory and
**720s aggregate** compiler work budget apply. Full semantic/declaration/consumer
qualification remains due. Static syntax/diff/hash checks only locally; both source
reviews precede standard Actions. Original failures remain; production stays held.
