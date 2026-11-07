# Native assessment reminder preparation checkpoint

8 November 2026. Isolated source/fictional-CI prototype only. No numbered SQL,
journal entry, installation, scheduler change, provider or transport invocation.
Production remains held. This extends the bounded capability contract in
[the native API design](NOTIFICATION-WORKER-NATIVE-API.md), not its authority.

## Implemented boundary

The optional owner-installed version3 profile enables the actual
`assessment.reminder-queued` port. Versions1 and2 keep their original capability
profiles and independent negative controls. The same serialized real-LOGIN suite
owns all three stages; no new test invocation may create a competing cluster role.

The unnumbered `test/fixtures/notification-worker/assessment.sql` checks exact
predecessor function bodies and the canonical owned test-database marker before
adding private projection/admission state and one public fixed API. Facts derive
the recipient, run, cycle, user and employment from the admitted source event and
native reminder row. The worker supplies none of those IDs. Private projection
state is scoped to the real batch and epoch set, reused within that transaction,
and deleted with batch settlement. Every API retains real LOGIN/backend/start/xid
admission. No application-schema usage, direct source-table grants, app-role edge,
SQL broker or fake transaction carrier is introduced.

Native facts use the existing `app.assessment_pending_work`, mail-route and words
helpers. The canonical pure work, entitlement, routing, window, refusal and word
evaluators are shared by web and native adapters. The existing web resolver keeps
its actual transaction, fresh reads, cached projection, lazy refusal order and
preparation mutations. The native adapter uses its proved native clock for its
preparation interval and checks the full epoch set before proposing work. The
fixed preparation API rechecks actual source linkage, current identity, full epochs
and expiry immediately before writing only the already approved preparation
columns. It bounds preparation to the captured projection and sixty seconds.

The proposal remains **trusted deterministic worker computation**: native SQL
validates a closed bounded task/word shape, event identity, epochs and deadline;
it does not independently prove task counts, wording or the truth of a proposed
skip reason. This is the same explicitly bounded render/preparation trust model
in the API design. Actual source/build/environment qualification is still required.
The worker cannot replace the source user/cycle, write other HR facts or claim a
known event settled before preparation. The final native event audience is the
protected preparation result for that exact batch/event. Notification, consent
outbox, preparation, processing receipt, cursor and run counters settle in one
transaction; any refusal rolls them back together. Delivery revalidates freshness
through its existing separately isolated lease and is not executed here.

## Qualification request and limits

Run `test/notification-worker-lifecycle.test.ts` alone on the standard hosted
runner. It now includes five substantive version3 cases: independent equivalent
legacy/native nonempty preparation+notice+consent-outbox parity; actual consent
revocation; a concurrent source edit invalidating the native epoch; a real native
receipt-trigger failure proving complete rollback followed by recovery; and real
LOGIN premature settlement, forged epoch/extra identity field/direct-write refusals
with the exact thirteen accessible API count. Existing stage1 and stage2 cases
remain registered and unchanged. Setup remains300s and each new native case30s;
SQL/runtime resource policy is unchanged.

The pure shared evaluator regression result at frozen `bcae710d1` remains172
passing tests in hosted42392036172. Stage1 catalog qualification at65b0a2559
remains11 passing native cases in42391295851. Stage2 combined native42392098914
failed during owner contract JSON installation before its cases; its eleven
stage1 passes remain evidence and the independently reviewed87a4c577b owner
serialization repair is normally merged here. These results do not qualify this
new version3 source. No local application, compiler, build or database check was
run. The whole compiler and affected canonical regressions remain separate gates.

Still open: unsupported recipient families, all-registry native parity, process
kill-lever/invocation integration for the full worker, abandoned-run owner recovery
and retention, resource/capacity measurements, final restricted owner/ACL and
guarded migration, protected package/scheduler acceptance. This checkpoint does
not remove page catch-up, any legacy dispatcher, fallback, audit, combined sweep,
or unrelated scheduled duty and cannot authorize worker deployment.

## Typed proposal repair before qualification

The isolated child normally merges reviewed registry-alias repair
`fab1452202ecdb79d88b0408542e5bbc7a0f29ad` before changing the stage3 guard. Its
stage2 `finish_event` body MD5 is `b317afa0442bac4e210c29c8856864bf`; stage3 now pins
that exact predecessor and uses the same unambiguous `registry` alias in its own
replacement. Preserve original87 run42392912609 (12PASS/10FAIL) and all prior
canonical evidence; these source changes do not relabel that failure.

Independent review found that text extraction admitted a string task count and
PostgreSQL timestamp casting admitted non-ISO task deadlines. Native validation
now requires JSON numeric integral count1..1000000, numeric integral safe epochs
0..9007199254740991, complete exact skip keys and canonical ISO timestamp syntax.
Actual event/recipient/run binding, source/epoch checks and native preparation
clock/deadline checks remain. Prepared timestamps additionally must convert to
finite native instants within the captured projection interval. This validates
wire types, not the truth of caller-proposed task counts, words or refusal reasons.

The grammar was derived by reading the actual installed **Zod4.6.7**, which matches
frozen482's pnpm importer and locked `zod@4.6.7` record. Lock SHA256:
`0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd`;
package integrity:
`sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==`.
Inspected local artifact:
`/Users/zenlam/Projects/ai-hr/.codex/worktrees/mainwt/node_modules/.pnpm/zod@4.6.7/node_modules/zod/src/v4/core/regexes.ts`,
SHA256 `fd08a3d605812f51ac57e5c5b327682f99aaf741cff30a9363cb4f6afc60cdc9`,
lines108–154. Stage3 setup pins the installed version and regex-source digest so
a future parser upgrade requires a reviewed parity refresh. Its default offset datetime requires a leap-calendar four-digit date,
uppercaseT/Z, seconds, optional fractional seconds and Z or colon offsets00:00 to
23:59. It rejects local/compact-offset dates, leap seconds and relative/infinite
PostgreSQL date spellings. Year0000 and23:59 offsets are canonical task wire values;
task deadlines remain strings instead of being coerced through PostgreSQL's different
timestamp parser. This does not qualify the separate mail transport's native date
casting behavior for those synthetic edge values; no transport is invoked here.

Canonical task people names use Zod `.trim()` (installed core/api.ts1180–1181 calls
JavaScript `input.trim()`). The private validator normalizes that ECMAScript whitespace
set, including NBSP/BOM, before persistence. String bounds count UTF16 code units,
including two per non-BMP character, instead of PostgreSQL codepoints. The same
length owner validates prepared subject/opening; only CR/LF are excluded from the
subject, matching the existing canonical prepared-word schema. Task order, original
IDs, word contents and timestamp strings remain; names receive the existing canonical
trim transform. No helper or source table is granted to the worker.

Two additional30s real-LOGIN cases supplement the original27 native cases (29 total):
malformed proposal clones cover string/NaN-like/decimal/negative/oversized count,
invalid calendar/clock/offset/infinite/relative deadlines, bad preparation timestamp
and epoch types/ranges, UTF16/trim name bounds, word bounds and missing skip keys.
Each refusal compares full preparation, notification/outbox, processing receipt,
cursor, native counters, batch and admission rows before/after. Typed positives
include a JSON numeric1.0, null deadline, leap years, fractional/offset/year edges,
maximum UTF16 name/word bounds and exact JS trimming. Their actual committed tasks
are parsed with the canonical mail schema and compared with its independently
computed normalized result. This positive case qualifies the bounded wire proposal,
not task semantics. The existing actual legacy/native nonempty task parity remains
separate and unchanged. Its proposal fixture now derives expiry through the same
canonical helper, retaining the captured midnight/window boundary.

No local app/DB/runtime/compiler/build checks or source upload ran. Hosted29-case
native qualification, canonical regressions and compiler/build remain pending;
production remains held.
