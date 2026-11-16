# Comprehensive employment movement maintenance

**Status:** Proposed implementation; business scope approved in feedback 8cff7fef.
**Date:** 17 November 2026 (MYT).
**Deciders:** The owner approved the feedback plan and instructed on 17 November that **all three
stages must be completed before any staging release**. This overrides that plan's earlier per-stage
staging cadence. Source implementation, hosted verification, review and installation remain distinct.

## Context

The approved scope joins complete per-event employment information, historical maintenance, original
hire corrections, salary recording choices and order-independent payroll-history import. Existing
assignment, reporting, compensation, cost allocation and payroll owners already enforce permissions,
dates and audit. Extending only the visible form would leave those owners and their projections in
disagreement. The existing probation/notice/confirmation foundation has a frozen, passing development
checkpoint; it is not completion of Stage 1.

A correction must preserve every finalized payroll result, payslip and statutory artifact while changing
the employment facts HR intends to record. A prior financial result is evidence of what was paid; it
must not become the mutable owner of corrected employment information.

## Decision and implementation requirements

### Owners

| Fact | Owner and history |
| --- | --- |
| Company and organisation placement; employment type | Dated, bitemporal assignment spine, with existing label/company validation |
| Group/current-company join dates, grade, periods, lifecycle dates and organisation labels | Employment information owners and their dated, audited event projection |
| Direct Superior | Dated reporting line owner with cycle and scope checks |
| Cost center allocation | Existing dated allocation sets and revision checks |
| Salary and pay structure | Compensation owner; immutable amount references in movement audit |
| Payment method | One dated payment-method history owner, with the current column maintained as its projection |
| Event type, Effective Date, same-day order, correction/deletion status | Canonical Movement ledger/projection |
| Finalized payroll figures and retained documents | Payroll/payslip owners; never a movement writer |

New Event, Edit and Correct Hire Details must consume one complete employment-information contract and
shared controls. Import maps to that same contract and calls the same commands. Every supported event
has complete information and its own historical before/after, including unchanged fields. Monetary
amounts stay in compensation rows and are referenced by ID, never copied into unrestricted events.
Legacy missing facts are identified as unrecorded rather than silently supplied from today's profile.

### Effective dates and corrections

The latest applicable event is selected by business Effective Date. Scheduled events do not alter
current information early. A correction retains the selected date and appends its preimage, postimage,
reason, actor and linkage; it does not update or delete a `domain_event`. Replacing or deleting an event
rebuilds the affected timeline through the canonical owners, retaining all previous versions.

Any historical event, including the original Hired event, may be corrected under fresh maintenance
permissions. Later intentional field changes remain boundaries; inherited fields are re-evaluated.
Unknown or conflicting history must identify the particular event/field, with no partial writes.

A same-day clash presents the existing event and the proposed event and requires an explicit sequence
resolution or moving/keeping an event. Saving or correcting timestamps never resolve the clash. The
chosen order and actor are audited. Invalid lifecycle ordering is refused with the conflicting events.

Delete is a compensating operation behind a separately configurable company-scoped movement-delete
permission, in addition to maintenance authority. The original event, deletion reason, actor and time
remain in audit. Deletion cannot manufacture an employment period without a valid start.

### Payroll protection and open calculations

For Movement maintenance, replace the per-save closed-payroll acknowledgement with an informational
preservation notice. This supersedes **only the acknowledgement requirement** in ADR-0164 for Movement
commands. Fresh permissions, historical-company rights, retained-document preservation and all financial
writer guards remain in force. No posted flag becomes an authority grant, and no user acknowledgement
is fabricated in audit. The canonical command owns its transaction-bound correction authority.

Closed payroll, issued payslips, statutory results and EA information are never reopened, recalculated
or rewritten. A corrected company or salary can differ from what a closed payroll paid; record that
mismatch for an authorized payroll adjustment instead of blocking employment history maintenance.

Compensation versions used as payment evidence remain intact. Employment-effective salary intention
must be distinguishable from the protected storage interval where an existing closed-payroll correction
places a new salary version. Dated employment/payroll input readers must use the corrected intention;
closed results continue to use their retained financial rows and salary-basis evidence. This must be
implemented by the compensation owner, not by a second salary table or UI arithmetic.

Determine the old/new affected field windows. Mark and, through the existing deterministic payroll
processor, reprocess only the affected employee in overlapping **open** runs. Assignment, grade and
Direct Superior changes join the same owner as compensation. Preserve unrelated employees and periods.
Long timeline work uses the existing bulk-job kernel; it must not hold an exclusive Access lock or run
an unbounded per-company/per-employee web loop.

### Salary recording

Basic Salary Add/Edit presents three explicit choices: create a configured movement event; amend the
latest applicable event without another visible movement; or record a salary amendment without an
employment event. Salary, payment method and Effective Date travel together in one transaction.
Updating an existing event identifies its date explicitly; a different intended salary date requires a
new event/amendment or an explicit event-date correction, never a silent replacement with today's date.

### Payroll history import

Use the dated employment/company spine for the imported period, independent of save/import order. A
known history gap never falls back to today's company. Admit both companies' valid portions of a split
month, retaining the import's financial amounts. Store/prove the relevant coverage period and reject
ambiguous or mismatched employee/company/period bindings with row-specific explanations. Loading a
later movement first must not prevent inserting the earlier Hired/placement history later.

## Options considered and trade-offs

Keep canonical dated owners and add complete event projection/reference evidence (chosen), or maintain
an independent mutable history JSON store. The latter is simpler for a form but duplicates employment,
salary and company truth and cannot safely drive payroll. The chosen design requires broader owner,
replay and reader changes, but shares authorization, validation and temporal rules across every entry.

In-place rewrites of original events or closed compensation/payroll evidence are rejected: they remove
the independent pre-correction facts the requested audit and payroll protections require.

## Verification and release

Use real, authorized fixture data for full-field round trips; multiple later movements and original
hire corrections; same-day resolution; deletion permission and audit; future/as-of projection; closed
payroll/payslip/statutory preservation; targeted open-run recalculation; all three salary choices;
payment-method dates; import orders A/B; and a mid-month company transfer. Failure and cross-tenant/
company paths must leave no partial writes. Changed group read shapes need the repository's 70-company,
1,000-employment equivalence/scale fixture.

Run focused checks, whole-repository types and builds on standard GitHub-hosted runners. Finish all
three stages and their integrated verification before the normal review, full release checks and
shared staging queue/lease. This ADR grants no production deployment authority.

## Development evidence and remaining admission work

- The employment-period foundation at `01c70c023d14698c52961bbc08797d3a200c6418` passed 224 focused checks, whole-repository type checks and the production Linux build (Actions 43901661757).
- Checkpoint `71b0d79f69f8cf348f99e86f3bc4f132f832c0bd` passed all 100 selected non-database checks, whole-repository type checks and the production build (Actions 43911072314). Its database phase stopped in the new payment-method reader because the legacy enum branch needed an explicit text cast; no DB behavior pass is claimed. The original job log and PostgreSQL evidence were retained.
- Subsequent work adds historical deletion replay across later Entity Transfers, explicit same-date conflict admission and legacy pending-conflict cancellation, a bounded Workforce-only payroll invalidation owner, and the Salary Add/Edit recording choices. These require their own frozen hosted verification.
- This remains an integrated development candidate: complete original-hire information maintenance, full event information evidence, bounded replay effects and complete rendered acceptance remain required. No staging or production installation, full-gate receipt or acceptance is claimed.

## Implementation boundary under verification

Original-hire information extends the existing lineage walker: the five core header fields use proven
inherited spans, while later deliberate grade/join/type/company changes remain boundaries. Paid hire
salary correction and dated salary amendments retain compensation references for fully closed intervals
and write only the remaining open interval. No salary amount is copied to their audit payloads.

A company correction must also satisfy the native company-scoped catalogues. Required placement
values must be corrected in the same form when they do not apply to the corrected employer. Incompatible
inherited current grades and company-scoped labels are cleared from the live projection and explicitly
flagged for review; their recorded assertions and issued payroll evidence remain recorded. Explicitly selected
replacement grades must pass the corrected company's native validation. Incompatible allocation revisions
are retired through the allocation owner, preserving every previous percentage row and audit reference.
A native empty destination-company revision requires explicit review and replacement (or confirmation
of no allocation). The ordinary transfer clear requirement and the final allocation/company invariant
remain unchanged. Corrected company or salary
periods that overlap finalized payroll show an adjustment-review notice with the affected months.

A compensating method deletion removes the selected active dated revision and restores a prior
same-day revision only when one actually existed. It does not insert a copied predecessor as a new
dated decision. This lets a subsequent correction to the original hire method continue to inherit
through the removed event. The immutable source events and explicit inverse remain in audit.

A later decision that becomes redundant after an older edit/delete remains recorded as a retained
intent. Its nonfinancial targets and original compensation reference allow a subsequent replay to
restore that decision if it becomes relevant again. Entry timestamps do not choose business order.

Movement payroll preservation now delegates to one shared metadata reconstruction implementation with
a closed-only mode. Legacy Information-Only Correction retains its existing all-output behavior. The
trusted system sweep records a system actor explicitly and refreshes payment-method current projections
from dated history without creating new history decisions. Intermediate inverse/replay invalidations
are deferred; one set-wise bounded union of changed intervals marks the final employee/run subset.

Full integration, company-assignment follow-up behavior, complete form coverage, security review,
rendered journeys and release gates are still required. Development checkpoints are not staging acceptance.
