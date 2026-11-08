# Rewards current ACL observer token recovery

Source-only successor of ae9e714a672ad996b0a8a21fb44ca0afa8f8a1a0.
The predecessor remains frozen. Actual hosted native run 42461359012 completed
22 PASS / 2 FAIL / 0 pending of 24; this is not qualification. Authenticated
artifact 13610026205 ZIP SHA256 is
5dcf8e7a0725f5ec71a287cc8a86af4a54d21294839dfe25f6af850ff8235683.
No earlier receipt is relabelled onto this successor.

## Actual failure and minimal repair

Bank case 16 exposed PostgresError 42601, trailing junk after parameter at or
near $2and, at ownerDirect in the test-only observer. The actual tagged query
had two scalar placeholders adjacent to AND: root.pid and database. This repair
adds one space after each placeholder and changes no other observer byte.
A TypeScript-valid template is not necessarily valid SQL after the native
client serializes its scalar placeholders.

Catalogue case 18 has the existing public PositionArchiveUnavailable error.
Its authenticated closed diagnostic records catalogue-test-pre 42601, then
catalogue-confirm 42601 and tenant-callback 42601. Source routes both Bank and
Catalogue PRE callbacks through fixture.observeReview, observer.observe and
first-use prove, including the same ownerDirect query. Cases 17 and 19 reach
their respective positive PRE paths. Together these facts support the shared
observer syntax defect as the Catalogue cause. They do not establish a repaired
native result: the actual unchanged case 18 must pass on hosted rerun. No
business error translator, source, custody owner or PRE oracle is changed.

The observer SQL body and direct-grant/effective-permission ordering, exact
42501/55000 refusals, full native metadata checks, actual owner/root binding,
mandatory parent-frame cleanup, abort/error identity and poison/drain rules
are unchanged. Native has_function_privilege caching remains unproven; this
successor introduces no cache claim or forced refresh.

## Meaningful source controls

The original 19 observer contract/source cases are retained byte-for-byte as
a prefix. Two appended source cases parse the actual observer with TypeScript
createSourceFile and never import or execute that native observer. They inspect
all 50 tagged SQL templates with a closed five-tag inventory and all 47 scalar
interpolations, checking both literal edges for joined SQL identifier characters.
ASCII letters/digits/underscore/dollar and non-ASCII text are conservatively
rejected when adjacent to a scalar placeholder. Punctuation and casts remain
permitted. This is a lexical source guard, not a general SQL parser or DB proof.

The first case rejects the exact two-boundary predecessor mutation. The second
makes 94 independent mutations at the actual AST literal positions, joining an
identifier at each side of every interpolation; every mutation must be detected.
It also covers malformed TypeScript, unknown tags, fixed before/after negatives
and cast/punctuation positives. Exact template/span counts prevent silent loss
of this source coverage. Total ordinary observer cases: 21.

## Source binding and hosted verification request

The companion current map binds both changed files and this request, preserves
all 1671 critical source members, and records complete ae9e whole-file preimages
for both changed files with their original/current hashes. Historical maps and
inverses are unchanged. Only the observer TS member changes inside the critical
source set. The original native singleton file and all 24 native case bodies,
financial/domain-event xmin oracle, actual PRE and bank/catalogue rollback
assertions remain byte-for-byte ae9e. Observer SQL/contract, diagnostic 11 cases
and ordinary native frame two cases also remain unchanged. No app/core/lib/db/
packs/migration/model/grant/controller/policy/provider change is included.

Local verification is limited to Git/source/hash/inverse checks and TypeScript
syntax parsing. No local model, compiler, test, native or database behavior ran.
Root and independent full review are required before upload or dispatch. Request
hosted observer 21 controls, affected actual native frame two cases, and unchanged
native singleton 24 cases against the frozen successor. Retain all predecessor
failures and unaffected valid evidence. Passing source controls cannot substitute
for the actual native failures or authorize staging/production.
