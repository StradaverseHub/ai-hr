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
