# Pure classifier witness protocol proposal

Child of frozen4808c1d4210edf41ead3096a5b73588b19da8d9e. The entire4808 design
and source-owner index remain unchanged. This implements PURE DATA grammar and
ordinary controls only. It allocates no workflow, native selector, policy,
process, snapshot collector, filesystem/API receiver, algorithm or admission.
Every represented native fact is untrusted until the future independent native
and authenticated API/Git receiver proves it. A successful shape check is never
native custody, a semantic algorithm witness, classification adoption or release.

## Exact serialization and content relationships

The executable grammar is scripts/gate-db-witness-protocol.ts. No imports, file
reads, environment access, process calls or API calls occur there. It accepts
already supplied strings/bytes/objects. Exact JSON schemas require their declared
keys only; numbers used as IDs are nonnegative safe integers (no booleans), and
sequence IDs begin at0 without gaps. Every JSON member uses recursively sorted
keys, canonical JSON.stringify string encoding and ONE final LF. Re-encoding must
match every input code unit, rejecting duplicate keys, extra whitespace, aliases,
missing/extra terminators, noncanonical escape spelling and nonfinite numbers.
Prototype-named keys survive as literal data; they cannot replace the serializer
prototype. Closed schemas still reject any such unexpected field.

| Relation | Exact records and order |
| --- | --- |
| suite.json | version1, paths: nonempty unique JS-code-unit-sorted canonical relative node/dom roots; whitespace refuses because the actual CLI trims LF input |
| snapshot-index.json | version1, rows: dense id, exact path (including EMPTY logical missing probe), firstSeen permutation, firstEngine a/b/c, value null OR full blob/rawSha256/rawBytes/textSha256/textCodeUnits/mode record |
| calls-a/b/c.json | version1, exact engine, rows: dense call id/sourceId; repeated probes retained; every referenced source exists |
| Complete collection cross-check | C then B then A calls reproduce every snapshot firstSeen/firstEngine and the ENTIRE source union; no uncalled snapshot entry or hidden probe |
| graph.json | version1, nodes/resolvers/hazardous; dense node/resolver IDs, unique node source IDs, every root represented; helper edge targets actual nodes; direct steps carry full reason |
| Resolver rows | id/nodeId/importIndex/specifier/candidates/selectedSourceId/outcome; node/import ordered; candidates preserve duplicates and native order; bare has no candidates, missing all-null, resolved ends at first positive |
| reasons.json | version1, a/b/c complete rootId/kind/reason arrays and complete ordered witnesses; B/C arrays exact; each DB witness is acyclic, starts at actual root, follows actual helper edges and ends at the actual direct step/reason; NODB has empty path and null terminal |
| delta-a-b/a-c/b-c.json | version1/from/to/rows; EVERY kind OR reason change, root order, exact before/after kind/reason; unchanged/omitted/extra/duplicate/reordered deltas refuse |
| source-pre/post.json | closed source/inventory identity plus COMPLETE ordered positiveSourceIds and negativeSourceIds; external native owner must prove their actual observations |

Null means that exact Reader probe returned null; an empty source is a positive
record with textCodeUnits0 and its full authenticated Git blob reference. Empty
reasons remain strings, never null or omitted. Snapshot IDs follow exact logical
path order; firstSeen separately records collection order. Alias keys remain
separate IDs. Full source strings are rebuilt from actual authenticated Git blobs
by the future receiver: no hash-only/source-prefix shortcut is introduced here.
Graph hazard membership/least closure, source-rule replay, root-specific FIRST
reason correctness and A/B/C actual algorithm invocation remain the independent
checker owner's obligations; schema validation does not calculate the classifier.

Semantic TSV has exactly THREE fields: fixed DB or NODB, canonical JSON-string
path, canonical JSON-string reason, separated by two literal TABs and terminated
by ONE LF per root. JSON escapes tabs/newlines/CR/lone surrogates inside strings,
so each complete semantic row occupies exactly one physical line and round-trips
all code units. Exact root order/coverage and canonical re-encoding are required.
No header, extra row, raw unquoted path, altered reason or missing LF is accepted.

native.stdout and native.stderr remain VERBATIM byte arrays, including partial
UTF8 at failure. They are never semantic TSV, escaped, trimmed, normalized, joined
with another attempt or used to fill missing semantic rows. validateNativeStdout
requires exact UTF8 bytes of the ORIGINAL unmodified CLI explain format AND a
separately obtained actual normal planner interpretation. The pure function
compares that separately supplied groups object; it cannot prove its native origin.
The future independent receiver must invoke/check the real plan owner and source
identity, rather than manufacture that object or substitute this pure replay.
Reasons containing C0/DEL controls (including tab/CR/LF/NUL) or leading/trailing whitespace refuse actual CLI
conformance, even if normal planning would ignore part of a reason. Ambiguous
original output is retained as raw failure evidence, not repaired into acceptance.
The exact normal plan trim/split/destructure partition course is preserved as an
additional pure comparison and bound to the unchanged .github/ci/plan.mjs source.

## Exact members, partial prefix and bounds

The two exported immutable member arrays preserve EXACT35 semantic and30 CLI
flat basename sets from4808. validateMemberSet requires one report with exact
version/kind/purpose/complete/completedStages/failedStage/failedMembers. complete
requires ALL13 semantic or15 CLI scheduled stages and ALL35/30 members. A partial
report requires a contiguous completed-stage prefix, the exact next failed stage,
and a prefix of that stage's fixed produced-member list. Its member set must
exactly equal bootstrap members plus completed outputs plus that failed prefix.
Unknown/duplicate/missing/alias/directory names or a later-stage output refuse.
No partial prefix has complete-witness authority. Code-defined stage order and
output groups are the exact schema contract for the future owner; no producer
may invent a stage, reorder work or emit a later member after failure.

Bootstrap: binding/anchor/prerequisites/report, plus the three program bodies for
semantic. Five original Git stage outputs precede collection. Semantic collect
produces suite/stdin/snapshot/allthreecalltables/phase-collect; replay produces
complete graph/reasons/three semantic TSVs/three deltas/phase-replay. CLI parent
stage produces semantic-parent/snapshot/phase-parent-auth; preparation produces
suite/stdin/program/package/source-pre; CLI produces clock/stream/rawstdout/
rawstderr/result; postimage produces source-post. The SAME five post-Git stage
outputs follow; seal produces native-ownership and phase-seal. A failed stage can
retain only its declared output prefix. These are output-framing constraints,
not a new native schedule or permission to execute any stage.

All metadata JSON shapes (binding, anchor, prerequisites, parent, package,
clock, stream, result, source, phase) are closed in the module. Native ownership
JSONL has one canonical closed row per line, dense sequence, fixed scheduled
stage/event and explicit PID/start/parent/group/session/native child-endpoint
fields. Socket endpoints record their OWN device/inode only; no peer inode
comparison, guessed outer writer FD or fictional child input digest appears.
Actual outer ChildProcess.stdin and independent actual kernel/process proof
remain mandatory external owners. Metadata can represent refusal/incomplete
facts; none grants authority because its booleans claim success.

Named bounds remain8MiB Git inventory/stdin,16MiB source/TSV/snapshot/calls/graph/
reason/delta/log/ownership,1MiB other metadata; at most100 members and128MiB
expanded intersection. Future ZIP/API receiver must additionally enforce64MiB
member/64MiB compressed/API limits BEFORE allocation, with strict named caps.
This pure already-materialized-data decoder cannot claim preallocation, ZIP bomb,
API identity or archive authentication checks. Git stage0 records are complete
NUL-framed100644/100755 blobs with exact40hex IDs; paths unique and nativeUTF8
byte sorted, preserving literal tabs/newlines after the FIRST header tab. Git
source content/raw identity and actual clean tree verification remain external.

## Prepared checks and honest boundary

28 NEW ordinary Vitest controls exercise the real pure exports: canonical JSON
and prototype names; duplicate keys; invalid framing; complete/partial members;
byte caps; complete35-member fixture; raw partial native bytes; null/empty source
and empty logical key; IDs/call repeats/source universe; suite coverage; reversible
semantic TSV/control characters; resolver order/first positive; invalid graph/
reason edges; exact B/C reasons; exhaustive deltas; raw CLI plus separate normal
groups; ambiguous raw CLI; Git framing; closed metadata/budgets; ownership rows;
and cross-member first-observer, stdin, phase and binding identity mismatches.
All original46 case bodies across the four classifier selectors remain whole
byte-exact4808. Their prior actual results retain their original source identity.
No existing runtime, workflow, admission, kernel, classifier, app, database,
migration, approval, provider, timeout or resource file changes. The two4808
documents remain whole exact preimages; the new finite source record binds the
new protocol/control/document and retained actual owners plus historical leads.

Local verification was SOURCE-ONLY: Git/byte/hash comparison and TypeScript
createSourceFile SYNTAX parsing (no Program/typecheck/import of this module or
model execution). All28 control behaviors remain prospective until reviewed
source runs on standard hosted Actions. Root+Compiler FULL review precedes any
upload, new API/native implementation or dispatch. No staging/production action.
The entire normal NoDB union, exact native CLI/source witness, normal/admission
integration, all-module loading/zeroBusy and release gates remain OPEN.
