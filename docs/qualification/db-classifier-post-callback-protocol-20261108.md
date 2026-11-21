# Corrected pure protocol: callback output and genuine runner report

Source-only successor of frozen e749695f265fd15e2ccd7c2d94e67a307b681cf9.
Root and Compiler completed the full e749 review and found FIVE material issues:
runner report ownership, lossless native UTF8, Buffer aliasing, BOM normalization,
and the exact node/dom root grammar. Preserve e749 and its original28 intentions
as historical source, without transferring any PASS. This successor corrects
those issues within the pure protocol/control scope. No actual native, filesystem,
API, workflow, classifier, permission, policy, resource or admission owner changes.

## 1. Callback cannot manufacture its own Vitest completion

The35 semantic/30 CLI basename sets remain EXACT. report.json is now solely the
VERBATIM actual Vitest4.1.8 JSON reporter output written AFTER onTestRunEnd.
It is never callback metadata, canonical JSON, a bootstrap prerequisite or an
output of native stage13/15. A callback cannot produce evidence that it passed.
The frozen e749 document's report/prefix description is superseded only here;
both4808 documents remain whole and their bounds stay in force.

phase-seal.json instead contains the closed callback progress shape:
version1, kind=NATIVE_CALLBACK_PROGRESS_NOT_ADMISSION, purpose, complete,
completedStages, failedStage, failedMembers, seal. The first six progress fields
retain their exact ordered prefix meaning. seal is a CLOSED discriminated union:
{state:not-reached} OR {state:executed,phase:<actual closed seal phase outcome>}.
Only actual stage13/15 seal execution can use executed. Earlier failure requires
not-reached. A failed seal phase is executed with complete=false/noncomplete
outcome; a complete native prefix requires executed/complete=true/outcome=complete.
Actual phase clock order, fixed seal10000ms/settlement6000ms remain checked.

This terminal METADATA file may be written after early failure inside the
EXISTING bounded6s mandatory owner-close. That does not run/claim a later seal
stage, borrow its10s or continue classification/source work. Every other member
remains exactly the completed-stage outputs plus a PREFIX of the failed stage's
fixed outputs. Native-ownership stays the last actual seal output; metadata does
not fabricate native process observations when seal was not reached. Earlier
failure keeps actual partial output/cleanup, not a forged completed ledger.

There are now separate pure APIs, with NO caller boolean report waiver:

- validateCallbackMemberSet/decodeMembers/validateCallbackArchiveData reject ANY
  report.json. A native-complete callback is pending-runner; a partial prefix is
  partial-native. Neither can be final success.
- validateFinalMemberSet/validateFinalArchiveData require EXACTLY ONE report.json
  plus the appropriate native prefix. The separate final API compares the actual
  one-purpose-file/one-assertion report and native-complete conjunction. Its
  returned kind is FORMAT_ONLY_NOT_NATIVE_OR_ADMISSION, even when outcome=passed.
- Failed genuine-shaped runner JSON is retained byte-for-byte and returned with
  a failed outcome; native partial plus a passing-shaped report is still failed.
  Missing/invalid/impostor/duplicate/extra/foreign/skipped/pending/todo reports
  cannot produce a successful format result. Malformed raw report bytes remain
  the future collector's original failure artifact, never synthesized/repaired.

The FUTURE workflow owner must copy/upload the real report only AFTER the actual
Vitest process finished and settled. The future authenticated collector must
verify that provenance independently. Pure JSON shape cannot prove it. Fixture
report objects in the ordinary controls are synthetic DATA fixtures explicitly,
not actual runner/native receipts. No producer claimed complete/verified bit or
JSON title grants release authority.

## Actual pinned reporter format source, not a runtime witness

Read-only primary source inspection found local installed Vitest version4.1.8.
JsonReporter.onTestRunEnd calls JSON.stringify(result) and writeReport writes those
bytes WITHOUT an added LF. The schema therefore requires JSON.parse followed by
EXACT JSON.stringify roundtrip; canonicalJson sorting/LF does not apply. All
actual outer report/file/assertion/snapshot keys and types are closed. Optional
assertion duration/location follow the actual source; successful execution needs
a finite duration. Coverage is disabled/coverageMap absent; fixed native sources
will have no snapshot assertions, custom meta, tags, describe nesting or retries.
The exact proposed top-level title (agreed with Compiler) is
qualifies the complete source-bound classifier witness. Each purpose binds its
4808 exact selector; the actual authenticated candidate root binds absolute name.

Successful format requires one file, one actual passed assertion, exact counts,
no failed/pending/skipped/todo, no failed suite, no report/file/assertion errors,
empty snapshot summary and native-complete output. A real module/fixture failure
may carry zero assertions and failed suite; it remains typed failure, never PASS.
Unknown extra report fields or a different framework format refuse pending a
separate source review; there is no generic accept-both fallback.

| Local inspected primary source | SHA256 |
| --- | --- |
| vitest/package.json (version4.1.8) |7514764431c71b6145ac008c36bdb8995d1998dfefe9f7bbbe3ca2da96716f3d|
| vitest/dist/chunks/index.UpGiHP7g.js |cdafaf8e508042dddba72f8c7bbae84e2836ddb6b06c7026520c35d91af4e798|
| vitest/dist/chunks/reporters.d.CtLUhkkA.d.ts |a9c8214ef27f5762c807802fd468b50fafae5c909d4376b67b3bfccaf8f99e13|
| @vitest/snapshot4.1.8/dist/manager.js |1ed6bfb67d6a50b44c373700f32cc65621d4e44ce8958ac0796cdbb45775a529|
| @vitest/runner4.1.8/dist/chunk-artifact.js |c10a7a80fca65fb42e27eabf7655c5ce5ecf36e8aaeb1811499efd063df62556|

These local dependency hashes explain the SOURCE FORMAT derivation only. They
are not portable hosted installation/lock/source/runner authority. Actual native
jobs must prove their own source/runtime and use the unchanged pinned lockfile.
No dependency module was imported or executed during this inspection.

## 2–5. Lossless bytes and exact suite roots

Native explain equality now first requires expectedString===fatalUTF8Decode(
TextEncoder(expectedString)). Unpaired high/low surrogates in either root or
reason refuse; valid Unicode pairs and actual U+FFFD remain distinct valid data.
Semantic TSV still round-trips ALL code units including unpaired surrogates/NUL,
using JSON-string fields. Actual raw native stdout/stderr remain byte arrays,
with no normalization, rewriting, escaping or partial-row substitution.

Every raw input is copied with new Uint8Array(bytes). Buffer passes instanceof
Uint8Array but Buffer.slice aliases; no slice method can now leave the decoded
raw member linked to its original Buffer. Controls mutate both directions using
actual Buffer data, not a simulated getter or copy-returning mock.

The fatal UTF8 TextDecoder explicitly uses ignoreBOM=true, which PRESERVES the
leading U+FEFF code point. A BOM-prefixed canonical JSON/semantic TSV/Git header
therefore refuses, rather than silently normalizing. Whole program text preserves
its original BOM. Native streams/report bytes stay verbatim. No decoder erases
source bytes before source equality checking.

Suite roots require canonical relative test/ paths and the ACTUAL normal planner
suffix predicate .test.ts OR .dom.test.tsx, unique in exact JS sort order.
core/admin.ts, test/helper.ts, .github/x.test.ts and browser .test.tsx are refused.
Tracked Git paths retain their broad repository grammar; snapshot logical probes
retain exact possibly-empty strings. No native membership/source claim follows
from lexical matching. The full fixed suite is still3631 (the original3630 plus
the one ordinary protocol selector), not a transferred inventory witness.

## Future post-callback metadata verification contract — DESIGN ONLY

Root approved the finite proposal for ONE classifier-witness-verify job after
all THREE native jobs. It is not a fourth native case or classifier retry. The
same workflow run can still be in_progress while that verifier executes: actual
three parent JOBS/reports must be completed and independently authenticated;
requiring the entire containing workflow already complete would be impossible.
The root's external final collector repeats the whole-run TERMINAL conjunction
AFTER the workflow finishes. Neither a shape-only report nor a parent claim
substitutes for actual API/Git/native/source/graph replay.

Existing1800s job, proven30s preanchor,120s artifact and6s final reserves remain.
The proposed660s metadata owner has5 preGit(10+6each),3 complete parentAuth
(120+6each),one complete source/graph/conjunction replay(15+6),5 postGit(10+6each),
and seal(10+6):575s stages;30prep+6close gives611<660. Launch requires
elapsed+30+660+120+6<=1800. No borrowing, retries, extra native classifier, added
heap/resources or widened cap. Actual nativeCLI15s+6, semantic collect/replay15s+6,
all8/16MiB and archive100/64/128/64MiB limits remain unchanged. Known B deadline
stays failed actual CLI outcome/partial stdout, never filled from semantic C or
relabeled onto another source. C complete and all semantic/native controls plus
complete normal NoDB union remain required before algorithm adoption. This
metadata proposal has releaseAuthorized=false and allocates no policy/workflow.
Compiler owns future actual workflow/admission/native/snapshot/graph/API/evidence
implementation; this candidate implements NONE of that scope.

## Exact prepared controls and source closure

38 ordinary controls: all28 e749 intentions retained (report-related fixtures
adapted to the HONEST callback/final boundary), plus10 discriminating additions:
Unicode pairs/unpaired surrogate collision; actual Buffer bidirectional copying;
BOM preservation/refusal; callback-vs-runner ownership; actual reporter framing;
extra/skip/pending/todo/foreign/title report refusal; retained actual-shaped failure;
partial callback/final distinction; honest seal-not-reached/failed seal; exact
suite cohort. The original46 classifier rule/Reader/graph/cycle intentions and
all runtime/native owners remain whole byte-exact4808/e749. No assertion is
removed to make a failure pass; all38 behaviors remain PROSPECTIVE until hosted.

Only the pure protocol/control files change. Their COMPLETE e749 preimages are
bound in the new whole inverse. The complete new source map retains28 parent
bindings with two actual overrides, adds the immutable e749 map/new inverse/this
record, and independently retains3 historical69f source leads. All3631 paths and
both full-suite digests remain exact e749. Fresh main/alpha29d ancestry was checked;
this is the explicitly authorized e749 successor, not integration/source relabel.
Local checks were source reads, Git, bytes/hashes and createSourceFile SYNTAX only.
No Program/typecheck/module import/model/test/native/DB/API/runner behavior ran.
Root+Compiler FULL review precede any upload or native implementation approval.
Staging/production and all complete architectural qualification remain on hold.
