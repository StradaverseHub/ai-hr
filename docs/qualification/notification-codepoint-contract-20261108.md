# Preserve the canonical reminder Unicode contract

Source-only child of diagnostic0da8cfc069c6027c5741d4cab659ea8164cc1f2f.
Unnumbered isolated-CI prototype only; no migration, installer, production setting,
provider call or production change. Existing business schemas remain unchanged.

## Actual failure, preserved

Stage3 run42397221009 completed38 native cases and failed2. Canonical behavior
run42397232835 passed172 assertions across17 files. Pure diagnostic42398135608
then identified exactly the claimed-invalid task at index28:101 supplementary
characters are accepted by the actual canonical parser. Preserve all original
results; no failed result becomes a pass on this source.

The locked Zod4.6.7 implementation counts Unicode code points for string limits,
not UTF16 code units. The native prototype incorrectly counted supplementary
characters twice. Correct its private length helper to PostgreSQL UTF8 length,
which agrees on the representable JSONB domain. Combining marks each count;
grapheme clusters are not the unit. PostgreSQL still refuses NUL and unpaired
surrogates at its JSONB boundary; this is not a claim of arbitrary JS-string
representability. ECMAScript trim and the existing exact ISO syntax are unchanged.

Both pure and native checks now pin the parser version, actual ESM/CommonJS length
implementations and date-regex source. Positive boundaries include101/200
supplementary characters,200 CJK characters and100 decomposed two-code-point
sequences; their respective next-over-limit cases are refused. Prepared words keep
the canonical20k/30k code-point limits. A real LOGIN persists the original five
date edges, decimal JSON numbers, trimmed names and maximum supplementary words,
then passes them through the actual canonical mail consumer. A second real LOGIN
persists all16 task keys with3 names at200 code points and maximum escaped words.
Both prove native current epochs, source/recipient binding, outbox/receipt/cursor
effects and cleanup. These are wire proofs, not native proof of proposed task truth.

## Derived byte envelope, independent from shape

The previous20,000 task-byte and220,000 word-byte ceilings reject valid canonical
bounded values. This unpublished prototype uses64KiB tasks and320KiB words:
16*3*200*6=57,600 worst-case JSON-escaped name bytes, and(20k+30k)*6=300,000 word
bytes, plus fixed field/key/date overhead. The overall ceiling is400KiB, above the
sum of both envelopes with room for the seven-field preparation metadata. The real
server's JSONB text sizes must fit all three limits; the escaped positive must
also exceed all three old limits, so this is not an unexercised budget change.
No task/name/count/word cardinality or canonical length is increased. The batch
count, query/lock/time limits, global resources and authority stay unchanged.

These are operational ceilings, not a claim that every arbitrarily padded valid
parser input fits. ISO fractional digits and pre-trim padding can be unbounded;
one parser-valid66k-digit date fraction must still be natively refused with no
committed preparation, projection, receipt or cursor effect. Existing malformed
task/date/epoch/skip and rollback controls remain. No blanket truncation occurs.

## Required hosted qualification

Independently review before running the pure task-shape file and the sole native
notification-worker-lifecycle file on their normal registered hosted profiles.
The native file now has41 cases; no skip is introduced. Preserve the already valid
172 canonical assertions unless a later application change invalidates them.
Actual worker invocation, unsupported event families, crash/recovery/retention,
protected installation, full browser/load and release qualification remain open.
Staging remains gated and production held.
