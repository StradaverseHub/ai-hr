# Payroll closed-run reopening: proposed complete review contract

Status: coordinator-approved reopening contract, now implemented in draft PR119. Focused verification is in progress; successful Assistant confirmation is not yet established. Selected intent is **reopen one existing closed run**; reset and recalculation remain separate capabilities. Release hold remains.

## Actual native owner and effects

`core/payroll.ts#unlockClosedBatch` (through Payroll pack facade) clones caller and input, requires `payroll.unlock_enabled`, trims and requires a reason, then owns one `withTenant` transaction. `lockNativePayrollBatchPeriodTx` owns native access/principal and the nominated company/month period key before reading the run; it rereads the same company/month/parent binding. It does not create a new pay period. The owner reads the RLS-visible batch, checks company-specific configurable `payroll.unlock`, requires closed status, and refuses `app.payroll_history_batch_adopted(batchId)`.

`batchDownstreamWarnings` is the sole warning owner: payment-summary-export event existence yields the legacy `paymentDisbursed` warning (this is **not independently verified bank disbursement**); statutory rows for the company/month yield filed boolean/count using canonical filed statuses and total report count. Proposal labels the payment warning as recorded payment export, preserving native field semantics without claiming bank settlement.

Actual writes, in order, in that transaction:

1. Transaction-local `app.unlock_batch` escape hatch; update exactly the nominated payroll_batch status closed → processed. Existing closedAt/releasedAt, payslips, amounts, totals, GL, claim/loan rows remain untouched by this owner.
2. Read parent pay_period. Only when closed, set transaction-local `app.unlock_pay_period` and update that parent status closed → open. An already-open parent stays open. No sibling run is unlocked.
3. Insert one payroll_status_history row: action unlock; closed → processed; native actor identity; trimmed reason; before `{status:closed,periodReopened}`; after `{status:processed,warnings}`.
4. Append `payroll-batch.unlocked` for the batch with company, month, reason, warnings and reopenedPeriod.
5. Only if parent changed, append `pay-period.reopened` for the parent with batchId and reason.

All failures roll back all writes. No money calculation, deletion, payslip republication, payment reversal, export recall or statutory withdrawal occurs. Reopening enables later edits; that consequence must be stated plainly in human review.

## Bounded human contract

Proposed action `payroll.reopen`, contractVersion 1. Human content: batchId UUID, reason trimmed nonempty <=4000 characters, `confirmReopenClosedRun:true`, `acknowledgeRecordedDownstreamWarnings:true`. The model can nominate only a batch ID; it cannot author reason or either consent. Server-generated source contains company name/ID, period ID/month, run type/sequence/cycle label, batch before closed/after processed, parent before open|closed/after open, boolean parentWillReopen, the four native warning fields, and an explicit consequence string. No employee names, pay values, bank details or statutory document content in the browser review.

Private canonical fingerprint covers actual run binding/state and relevant row versions, parent state/version, imported-adoption witness, canonical warning evidence identities and statuses, selected current unlock permission/switch/actor/tenant binding and reason. Fresh canonical comparison before effects refuses changes to any reviewed fact. Permission is native configurable payroll.unlock plus actual financial company scope; **no invented HR-only floor**. A real USER without PERSON is supported; SYSTEM/model/bootstrap/provider paths refuse at Assistant guard while ordinary native SYSTEM semantics remain intact.

Warnings can change via statutory/payment writers outside period ownership. Recompute them at confirmation under READ COMMITTED and refuse mismatch; do not claim period ownership serializes every external writer. Freeze the authoritative source read's witness and execute immediately in the same transaction. If stronger prevention than this read-at-confirm boundary is required, enumerate writers and coordinate a shared lock rather than silently broadening native locking.

## Native transaction seam

The existing unlock body is extracted into `unlockClosedBatchTx(tx,ctx,input)` in the same owner file, retaining identical checks, native period lock, effect order and public return semantics. Public `unlockClosedBatch` keeps its captured caller/input and wraps the Tx owner, returning its historical `{warnings,reopenedPeriod}` only. The Tx seam additionally returns statusHistoryId, unlockedEventId and nullable periodReopenedEventId. These UUIDs are preallocated by the native server owner and inserted explicitly, so INSERT RETURNING adds no new audit SELECT requirement for payroll partners. Both native event payloads link the exact history and conditional parent event. The original body remains the single mutation implementation; no latest-event inference is used.

Add pack-exported reviewed helpers for preflight/source fingerprint and reconciliation. Assistant interval owns fresh access, current user and financial company scope, exact batch/month key and nominated binding before custody. Guard uses `withAgentActionGuard(...,'payroll.reopen','approve')`, payroll entitlement and native unlock permission/switch. Confirm executes native Tx seam within the **same top-level custody Tx**, never nested withTenant. SQL completion verifies exact native history/event references, actor, tenant, aggregate, reason and conditional parent event. A historical completed receipt may report later current state separately (reclosed run or changed parent), without rerunning unlock.

## Existing encrypted custody and recovery

Use createGenericOwnReviewStore (as payroll-close-review-store), seal/open source envelope and current actor/key binding; index/discard/expire/reopen and uncertain-outcome semantics stay in shared machinery. Store target erasure links for the author PERSON when present and native run's affected employment/person cohort in private metadata, never browser props. Confirm must atomically bind stored actionId and expected keyed review digest to exact effect IDs. SQL uniqueness guards replay. Reconcile completed entries by those IDs; missing/foreign/mutated evidence refuses instead of retrying a business mutation. Reopening a review UI is a read/recovery operation; distinct from reopening a payroll run.

## Coordinator allocation and resolved shared boundaries

**Allocated UNAPPLIED development identity:** 0734_assistant_payroll_reopen_review / journal idx714 / version7 / when1793330000071. The closed purpose is `assistant_payroll_reopen_review_v1`: dedicated columns and narrow functions on the SAME existing encrypted ledger, exact native proof/FK validation, action-kind insertion and privacy/erasure integration. No second ledger and no existing applied SQL edits. This identity permits isolated development CI; it is not an installation reservation.

Coordinator approved additive registry/browser/outcome entries at approve/payroll tier, native configurable unlock authority, full run-cohort plus optional author privacy binding, recorded-payment-export wording and same-transaction READ COMMITTED confirmation-boundary comparison. No future/external-writer serialization is claimed.

Actual 0704 membership is a registry FK: the obsolete action-kind CHECK is absent. Only the unique actor-scope and named legacy receipt-column CHECK receive new-kind branches. Every other predecessor CHECK stays physically unchanged with verified name/raw-predicate hashes; a separate finite new-kind CHECK enforces all legacy dedicated columns NULL and the new run/period/event/state shape. Metadata-only diagnostics report constraint names and byte sizes before deparse.

The exact isolated source repairs d7c/9bd/22a/f82/b55 were authorized by the coordinator. The SQL repairs affect only this held stack's never-applied source files; they do not modify accepted historical SQL or authorize merging this divergent stack into main.

## Acceptance cases and focused verification

- Native parity: closed parent → processed/open + exact history + both exact events; already-open parent → processed/open + exact history/batch event only; independent expected event payloads and unchanged payslip/totals/claim/loan/GL/sibling rows.
- Direct native vs reviewed Tx behavior parity with native permission remapping, tenant and company scope, payroll partner, HR/super admin, real unlinked USER; SYSTEM retained natively/refused by Assistant.
- Disabled switch, blank reason, draft/processed run, adopted history, invisible/foreign batch, revoked grant and stale carrier all refuse with zero durable writes.
- Stale parent, run change/reclose, warning event/report status change, import adoption and reason tampering between prepare/confirm refuse; concurrency with native unlock/close honors period lock and exactly one action completes.
- Exact proof rejects unrelated batch, tenant, actor, earlier unlock event/history, missing conditional parent event and duplicate completion; lost response recovery emits historical receipt without a second mutation.
- Ciphertext/digest/actor/action/foreign-key substitution, expiration, discard, key loss, erasure and private-source budget tests reuse shared harness. Six-locale DOM/body budgets, no raw source/warning evidence IDs, refresh revocation and explicit human reason/consent.
- Hosted exact-SHA focused native/source/custody/browser/role tests plus typecheck; no migration-bearing dispatch before slot allocation. Rendered authenticated journey and installed acceptance remain separate, unreached claims.
