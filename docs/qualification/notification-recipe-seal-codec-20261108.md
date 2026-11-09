# Closed recipe byte codec: isolated proof checkpoint

Unexecuted successor of qualified TS recipe-identity source
`db0caaf6d8c9d7eef8bbbeb65fe42e53cc9a9444`. This checkpoint implements only
closed deterministic bytes and read-only native vectors. It creates no native
function, relation, profile, grant, worker activation or application adoption.
The direct-LOGIN recipe-authority gap remains open until the separate reviewed
owner seal is implemented and qualified. Production remains held.

Format1 binds the NUL-terminated `AIHR_NOTIFICATION_RECIPE_SEAL` header, uint32
big-endian format/API version and complete row count. Every ordered row binds
eventType,kind,category,recipientPort,implemented,audience and the complete
guard. UTF-8 length prefixes, explicit null/boolean tags and distinct absent-not
versus present-true tags remove delimiter/JSON-whitespace ambiguity. Identities
sort by UTF-8 bytes, matching native C collation. There is no trimming, Unicode
normalization, folding, opaque-OID rewriting or second business-rule registry.

Plain bounded source arrays, own enumerable data fields and complete row/guard
keys are required before Zod parsing. Array/row/guard accessors, inherited or
extra fields, explicit null/undefined/false optional-not, duplicate identities,
NUL/lone-surrogate text and aggregate byte/row overflow refuse. Total source
text bytes are bounded before repeated UTF-8 allocation or sorting. Complete
encoded size is then independently calculated and checked while appending.
Limits are10,000 rows and1MiB encoded bytes; no caller data is clipped.

The fixed read-only native SELECT receives JSON through `$1::text::jsonb`, then
performs its own closed shape checks and binary framing. Every actual native
call first verifies native JSON type and complete array count. The app LOGIN
has a pg_catalog/pg_temp search path and real repeatable-read/read-only carrier;
no application table, human context, source helper inventory or notification
worker authority is invoked. Native invalid inputs produce valid=false with
NULL encoded bytes/digest, not a fabricated partial seal.

Five pure cases cover the independent72-byte literal vector, exact Unicode/C
ordering and identity uniqueness, every field/API version/guard shape, malformed
data and accessor/operational bounds, and both complete66-row source contracts.
Three actual native cases compare the full hex/count/length/SHA with the Node
encoder for the literal and complete v2/v3 contracts, Unicode/optional-not
distinctions, and direct malformed/overflow/version refusals. Each successful
native positive prints a small closed version/count/length/digest observation
for retained hosted logs; it does not print rows or create an acceptance token.

The independently framed literal has72bytes and SHA-256
`b26d5009d5527dfd780532f47f1809935e6f8660167ea3755882f7467204ed4a`.
Native full-contract digests are deliberately not invented in this source.
The native fixture retains max1 connection,2s startup,20s SQL,300ms locks and
the standard30s case/hook limits. Existing owned-work cancellation/drain/poison
is reused, with a single cached socket-close promise and compound-error
preservation. These read-only tests require no singleton/profile bypass.

No lifecycle, projection, assessment, processing, helper-source or recipe
registry installation SQL changes. Existing payload/storage ceilings, all
canonical recipients/renderers/calculations and fallback/scheduling remain
unchanged. The old2,300-helper profile is not adjusted to the newly captured
2,301 app functions. Nine composed bodies and127 opaque default ASTs still need
their independent source-provenance owner work; this codec approves none of them.

After root and independent source review, run only the two listed selectors
(5pure+3native) on standard hosted Actions. No local application/runtime/tests,
compiler, build, database or provider checks ran. Source preparation is not a
native seal/profile receipt, all-family worker completion, zero Busy proof or
staging/release authorization.
