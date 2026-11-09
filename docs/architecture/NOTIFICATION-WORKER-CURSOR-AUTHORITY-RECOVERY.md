# Native notification cursor purpose recovery

Isolated unnumbered prototype recovery from `fab1452202ecdb79d88b0408542e5bbc7a0f29ad`.
Preserve sole hosted42394270761:14PASS/8FAIL. Seven failures reached batch settlement
and refused `Complete tenant notification projection authority is required`; the
controlled late-commit case reached its unchanged30s timeout. These are real failed
results, not accepted source. No test result is transferred to this repair.

## Actual authority mismatch

`notification_worker.finish_batch` updates native processing receipts then writes
`notification_cursor`. The0582 `app.guard_notification_global_cursor` correctly
checks actual connection-owner/explicit-role authority or the current human group
administrator. A restricted notification LOGIN intentionally satisfies neither.
An intervening SECURITY DEFINER `current_user` is not owner connection authority;
forged context/GUCs cannot supply the missing worker purpose. Removing the trigger,
granting owner/SET ROLE access or relaxing its normal human branch would violate the
boundary.

The owner-installed stage2 prototype now guards the exact original cursor trigger's
complete body, owner/job-owner identity, language/signature/result/security/settings/
cost/defaults/ACL metadata before replacing it. Historical SQL stays unchanged.
Only the restricted session login takes the new purpose branch; it never falls
through to the old human GUC branch. Every other connection retains the original
owner/human predicates and immutable cursor identity rule.

The new **owner-only** `app.notification_worker_cursor_admitted` function reads exact
protected batch state, then repeats the existing actual LOGIN OID/profile, run,
backend PID/start, transaction xid, tenant, standing, consumer and time admission.
It requires one matching protected batch, nonempty complete admitted events and
matching current completed processing receipts. It accepts only the exact actual
batch maximum/monotonic value for that consumer's cursor and the unchanged other
consumer. DELETE is refused. No new public API, helper EXEC for app/worker, table,
sequence, schema usage, role edge or environment/GUC authority is granted. Inside
the existing fixed `finish_batch` definer, its actual owner executes this owner-only
purpose check; ordinary app calls never enter it. The existing app-helper contract
freezes both reviewed new function bodies after installation.

Both cursor columns are nullable in the actual schema. The former prototype wrote
an inactive0 on INSERT and `greatest(other,0)` on conflict, changing an unrelated
NULL cursor. Settlement now inserts NULL for the inactive consumer and updates only
the admitted consumer's column, preserving unrelated NULL/nonzero state exactly.
This aligns global settlement with the existing canonical legacy dispatcher. The
old prototype's inactive0 expectations are changed explicitly, not normalized away.
Native worker validation applies to all cursor writes, including assessment-only
writes whose global field remains NULL. Stage2's positive projection fixtures exercise
the global consumer; actual assessment-consumer preparation remains a separate
stage3 qualification after integration. No all-family claim is made here.

The shared fixture records the actual original guard definition/full metadata before
stage installation, refuses a preexisting helper and, after closing its owned worker
connections, restores/compares the exact old guard and drops only its new helper
before removing owned private schemas. Installation is one owner transaction, so a
failed source/guard installation leaves no partial extension. The mechanism applies
to non-stage1 installations without changing stage1's capability contract.

## Honest pending recovery fixture

The timed-out fixture inserted an uncommitted same-tenant audit event, held its
transaction open, then waited for a second same-tenant write before releasing it.
The current0864 `domain_event_chain_tg` calls0863 `_domain_event_next`, which holds
`audit-chain:<tenant>` until transaction end. The second writer cannot finish that
fixture schedule before release. No trigger/lock/sequence is disabled or rewritten
and no timeout is increased.

The replacement test uses genuine normally committed older/newer events, temporarily
marks only the exact owned older processing intent settled, projects the other two
and observes the actual newer cursor. It restores only that older intent, proves its
native sequence is below the existing cursor, then projects it exactly once without
lowering the cursor. A separate exact overlapping processed intent is restored and
must create zero duplicates. This models **durable pending recovery**, not concurrent
canonical audit commit ordering. The independent stage1 late-allocation/admission
control remains unchanged and keeps its explicitly different source-allocation claim.

## Prepared native proof and limits

Nine additional real-LOGIN purpose-fault cases preserve native trigger execution:
wrong tenant, consumer, unrelated column, backend start, xid, no admission, unfinished
event, unfinished receipt and a genuinely current foreign human-GUC claim. Fixed
owner-installed faults operate immediately before the real cursor guard. The latter
control first proves the canonical human predicates actually evaluate true, then
still requires native purpose refusal. After each refusal, all source/projection/
outbox/receipt/cursor facts and native counters must remain unchanged; dropping the
fault permits exact normal settlement. Two additional native positives retain an
existing unrelated NULL/nonzero cursor. Existing forged direct writes, stale/copied
batches, foreign backend/transaction/tenant, unsupported-family rollback, consent,
legacy parity and effect-fault controls remain.

The sole lifecycle selector now prepares33 cases (original22 plus11). Source-only
static checks establish no execution, acceptance, throughput or installation claim.
Hosted affected native/canonical/compiler/build qualification and independent review
remain pending. No local app/DB/runtime/compiler/build check, upload, provider,
transport or installation ran. Production remains held.
