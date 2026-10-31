# Performance legacy review postimage repair

Development only. Release hold; no installation, integration, merge or deployment authority.
Scheduling PR146 / d3eb7aae8c29fe3f482dbf18ccd455623aa35ef6 remains an immutable input.
Coordinator provisionally allocated 0750 / idx729 / version7 / when1793330000087.
This SQL source is not journaled or runtime verified until independent review permits mounting it.

## Closed scope

Only existing goal approval, check-in cancellation and check-in completion use the new adapter.
Other kinds delegate to their existing functions. No new action, ledger or permission is introduced.
The ordinary native calls retain their original audit and authority behavior. Reviewed source AND writer calls explicitly opt in; existing default source/digest writer pairs remain valid.

Under existing Access/native subject locks, prepareNative derives private expectations from the
actual stored row before createReviewCustody seals its body and AAD. The guarded SQL constructor
recomputes those expectations and treats supplied commitments only as stale assertions.
Goal approval changes approval status, approving USER and the two native SQL timestamps only.
Cancellation changes status only. Completion changes status, the captured native JS clock and
reviewed notes only. Preservation comes from DB notes; replacement uses the same native JS trim
owner, including Unicode whitespace. SQL does not invent another trim implementation.
Pure typed serializers set UTC locally; authority functions keep their caller timezone.

Reviewed native functions inspect actual persisted rows after UPDATE triggers and after appendEvent.
The SQL completion owner verifies the actual row, original event, top transaction and bindings,
then rechecks after ledger UPDATE and ciphertext DELETE triggers. Sensitive expectations clear
on completion and every retirement, including canonical erasure with an already absent body.

Minimal protected version, original event reference and DB-assigned root xid8 survive completion.
Completed binding metadata cannot change or disappear, including action-kind exits. Raise-only
BEFORE writer guards close the exact subject row, original/subject aggregate events, actor identity
and subject employment identity for the rest of that root transaction. They do not depend on body
presence, a caller GUC, deferred constraints or event existence. Child savepoints, context changes
and SET CONSTRAINTS ALL IMMEDIATE cannot end those guards. Same-transaction erasure refuses;
later transactions may use canonical erasure or legitimate native edits.

Actual principal, visibility, decision authority and subject binding are checked at admission and
final completion with Access locks. Later role/delegation/reporting-line revocation in the same
transaction need not retroactively invalidate the effect. History recovery rechecks CURRENT authority.
Historical pending packets lacking proof retire and require fresh human review. Historical completed
packets retain their immutable audit but cannot acquire a retroactive proof from today's row.
New qualified receipts recover their original event after later legitimate goal edits.

## Honest goal-review boundary

The bounded Assistant goal card requires general employee visibility for participant labels.
Native goal RLS also admits performance_comp_partner functional scope; a whole-scope delegation
can make that native door eligible while general employee visibility remains false. The real positive
native/negative Assistant fixture documents this gap. The broad native export remains backlog,
registry entryPoints is empty, six locales explain the scope and retain Open Performance.
There is no new SECURITY DEFINER person-name projection and no claim of whole-actor parity.

## Verification contract

The tracked focused plan separates proof/custody, native/shared-ledger and boundary/UI groups.
Every group requires whole-repository compiler verification on standard public GitHub-hosted runners,
full 40-character frozen SHA, unique immutable branch alias. All planned jobs must finish before
repairs; retain original failures and genuinely unaffected receipts on their actual SHAs.

New actual DB fixtures cover UPDATE/event/pre-completion/post-completion/body triggers, preserved
and Unicode replacement notes, forged prepare commitments, UTC serialization, old pending/completed
packets, privacy erasure with/without bodies, later goal edits, genuine functional/delegation contrast,
real authorized app-role mutation contrasts, immediate constraint flush, child/prior transactions,
context changes, ledger anchor removal and OLD/NEW event/employment retargeting. Existing per-kind
hybrid scans include the six new proof fields. Foreign-family scans gain xid8/date handling without
changing their 23514 assertions.

No local application tests, test collection, compiler, build, DB or dev server is authorized. Static
source-manifest regeneration/check and git diff checks are the only local verification performed.
