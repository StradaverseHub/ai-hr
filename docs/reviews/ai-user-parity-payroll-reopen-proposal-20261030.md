# Payroll closed-run reopening: proposed complete review contract

Status: source-traced proposal for coordinator review; no execution adapter mounted. Recovery handoff PR119 remains partial coverage. Selected intent is **reopen one existing closed run**, not reset or recalculate it.

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

## Proposed minimal native seam

Extract the existing unlock body into `unlockClosedBatchTx(tx,ctx,input)` in the same owner file, retaining identical checks, native period lock, effect order and public return semantics. Public `unlockClosedBatch` keeps its captured caller/input and wraps the Tx owner, returning its historical `{warnings,reopenedPeriod}` only. Tx seam additionally returns the inserted statusHistoryId, unlockedEventId and nullable periodReopenedEventId by RETURNING/native appendEvent IDs. Do not infer “latest event”. Reuse the original body; no second mutation implementation.

Add pack-exported reviewed helpers for preflight/source fingerprint and reconciliation. Assistant interval owns fresh access, current user and financial company scope, exact batch/month key and nominated binding before custody. Guard uses `withAgentActionGuard(...,'payroll.reopen','approve')`, payroll entitlement and native unlock permission/switch. Confirm executes native Tx seam within the **same top-level custody Tx**, never nested withTenant. SQL completion verifies exact native history/event references, actor, tenant, aggregate, reason and conditional parent event. A historical completed receipt may report later current state separately (reclosed run or changed parent), without rerunning unlock.

## Existing encrypted custody and recovery

Use createGenericOwnReviewStore (as payroll-close-review-store), seal/open source envelope and current actor/key binding; index/discard/expire/reopen and uncertain-outcome semantics stay in shared machinery. Store target erasure links for the author PERSON when present and native run's affected employment/person cohort in private metadata, never browser props. Confirm must atomically bind stored actionId and expected keyed review digest to exact effect IDs. SQL uniqueness guards replay. Reconcile completed entries by those IDs; missing/foreign/mutated evidence refuses instead of retrying a business mutation. Reopening a review UI is a read/recovery operation; distinct from reopening a payroll run.

## Requested allocation and shared questions

**One append-only migration slot requested**, private unique name `assistant_payroll_reopen_review_v1`: new dedicated encrypted-custody table/functions/grants/RLS and exact native proof FK/reference validation, action-kind insert for payroll.reopen, privacy/erasure integration with existing helpers. No existing applied SQL edits. Coordinator assigns executable number/journal identity before migration-bearing checks.

1. Approve additive `payroll.reopen` registry/browserOwner/outcome-reader/shared route union entries, keeping approve/payroll policy and existing owners unchanged?
2. Confirm one migration can carry custody, action-kind declaration and erasure registration using current coordinator contracts, or allocate split slots if ownership requires it?
3. Confirm native warning's payment-export evidence is presented as recorded export, and confirmation read-at-boundary semantics above are acceptable; otherwise identify the broader writer-lock requirement before implementing it.
4. Confirm erasure binding should follow close's complete run cohort (plus optional author person), even though no per-person pay row changes occur.

## Acceptance cases required before mounting

- Native parity: closed parent → processed/open + exact history + both exact events; already-open parent → processed/open + exact history/batch event only; independent expected event payloads and unchanged payslip/totals/claim/loan/GL/sibling rows.
- Direct native vs reviewed Tx behavior parity with native permission remapping, tenant and company scope, payroll partner, HR/super admin, real unlinked USER; SYSTEM retained natively/refused by Assistant.
- Disabled switch, blank reason, draft/processed run, adopted history, invisible/foreign batch, revoked grant and stale carrier all refuse with zero durable writes.
- Stale parent, run change/reclose, warning event/report status change, import adoption and reason tampering between prepare/confirm refuse; concurrency with native unlock/close honors period lock and exactly one action completes.
- Exact proof rejects unrelated batch, tenant, actor, earlier unlock event/history, missing conditional parent event and duplicate completion; lost response recovery emits historical receipt without a second mutation.
- Ciphertext/digest/actor/action/foreign-key substitution, expiration, discard, key loss, erasure and private-source budget tests reuse shared harness. Six-locale DOM/body budgets, no raw source/warning evidence IDs, refresh revocation and explicit human reason/consent.
- Hosted exact-SHA focused native/source/custody/browser/role tests plus typecheck; no migration-bearing dispatch before slot allocation. Rendered authenticated journey and installed acceptance remain separate, unreached claims.
