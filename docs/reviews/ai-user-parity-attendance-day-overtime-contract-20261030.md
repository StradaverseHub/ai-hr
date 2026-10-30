# Proposed contract: reviewed dated overtime-row correction

Status: source-reviewed proposal only, 30 October 2026. No action, adapter, executable migration or journal entry is implemented by this document. Coordinator review and one migration allocation are required before the migration-bearing slice is mounted.

Base: exact frozen PR127 head `ce0ace24ed0957d9f1655b8a6e25c13d352edfe8`. The schedule correction candidate remains unchanged. This separate contract branch intentionally preserves the held parity stack; freshly fetched main and alpha are both `d6cb83d620d8d4380c981a72fc41628780840b4e` (299 ahead / 107 behind at the base). It is not an integration or release base decision.

## Proposed action and actual native owner

Proposed ID: `attendance.day_overtime.correct`, module Attendance, human tier `approve`, unit one employment/date with selected existing configured overtime-row decisions. Proposed route `/assistant/day-overtime`.

```text
Existing AttendanceDateOvertime form
  saveAttendanceDayChangesAction(kind=overtime)
    scopedAdmin + listEmployees(current selected company filter)
      packs/attendance/service#saveAttendanceDayEdit
        native adjustments, calculated day, pattern refresh, payroll stale mark, native audit
```

The form already exists separately from the schedule form in [attendance-day-editor.tsx](../../components/attendance-day-editor.tsx). Its server export is still the compatibility composite in [actions.ts](../../app/attendance/individual/[date]/actions.ts); the inventory correctly leaves that composite in backlog. The deterministic business owner is [day-adjustment.ts](../../packs/attendance/day-adjustment.ts), exported through the Attendance facade. An eventual genuinely mounted overtime-only adapter may delegate the unchanged composite after snapshotting FormData and refusing other modes, as the schedule adapter does. Do not invent an unmounted native entrypoint or relabel the composite as covered before both modes are represented accurately.

Dated legacy overtime rows are distinct from captured clocks, requested aggregate overtime approvals, dated schedule corrections, unclocked-work requests and policy formula definitions. This contract changes none of those proposals or permissions.

## Authority and identity

| Boundary | Required behavior |
| --- | --- |
| Mounted native form | `scopedAdmin()` resolves a real session via `requireAdmin`; `listEmployees` filters the selected company context before delegation. Company selection is a UX narrowing of authorized companies, not an authority grant. |
| Native owner | Attendance module gate, actual `app.can_admin_employment`, same-PERSON refusal, current baseline and native business validation. Preserve default internal call behavior; do not retrofit Assistant-only actor rules onto the native service. |
| Assistant | Existing `withAgentActionGuard` at approve tier: current principal snapshot, resolved entitlements, actual Assistant allowance, action/module pauses and tier. Repeat native HR/company checks using fresh DB facts, not posted roles/company. |
| USER/PERSON | Genuine unlinked USER may administer an authorized other PERSON. A PERSON link is not a prerequisite. SYSTEM, missing USER, forged actor, another USER and another tenant cannot use this human-review command. A second employment of the caller's PERSON is still self. |
| Financial view | Keep the existing native financial-reader permission. A caller allowed to write but unable to review relevant financial evidence must use the native handoff; never add a salary or financial read grant to make a preview work. |
| Recovery | Before nomination/decryption, recheck actor and current subject company/person binding. Recorded receipts can bypass only new-write closed-payroll/credit checks, not current read authority. A pending review that loses scope cannot be confirmed. Existing own-discard semantics may retire ciphertext without exposing its contents. |

Use the same native HR/company predicate semantics verified for the schedule correction, without broadening the shared generic-assigned same-PERSON rule. Add one action to the existing disjoint Attendance role partition; preserve all earlier actions, labels and variants. Expected additive role coverage is the existing eleven roles for this action; no test result is claimed here.

## Human input and budgets

Strict human payload, version 1:

```ts
{
  action: 'attendance.day_overtime.correct',
  contractVersion: 1,
  subjectId: employmentId,
  employmentId: UUID,
  date: ISODate,
  baseline: SHA256,
  rows: Array<{key: string, minutes: integer | null}>,
  reason: string,
  confirmPayrollRecalculation: boolean
}
```

- `subjectId` must equal `employmentId`; all actor, company, amount, bucket, calculation, timestamp, new-row and receipt fields are rejected.
- One to one hundred distinct row keys; keys come from the current native editor, each nonempty and at most 500 characters. Exact posted order is retained for review/commitment; no silent deduplication or key substitution.
- `minutes: null` explicitly returns that row to Auto. Zero is an explicit manual value, not reset. Non-null values are safe whole integers from 0 through 1440; the native owner additionally refuses sums exceeding recorded work.
- Native posted `rows` JSON is limited to 20,000 UTF-16 code units by its existing adapter. Preserve that limit; the Assistant may additionally bound UTF-8 bytes to 20,000 as an explicit transport narrowing, never silently truncate.
- Trimmed reason is 1–500 characters. Processed payroll requires explicit consent even if it was already stale.
- Proposed review/receipt output budget remains 48,000 UTF-8 bytes inside the custody transaction. Native row/punch/financial-line/payroll/reference bounds and the 120,000-byte safe-witness cap remain enforced. Oversized valid native state hands off, with no prepared ledger row or ciphertext left behind.

## Creation versus existing state

The target employment and date nomination must be real and authorized. Overtime keys are derived native configuration rows, not arbitrary IDs for creating new rate definitions. A retained orphan manual key can be selected only to reset it; it cannot receive new manual minutes.

`saveAttendanceDayEdit` always inserts or updates the date's `attendance_day_adjustment`, increments its version, records reason/actor/time and emits `attendance.day.corrected`. It can create the first adjustment row even when the selected Auto reset removes no existing override. That is an actual native write, not a no-op receipt. Do not skip the write, synthesize an event, or invent an unchanged-result category.

A new manual value requires native `complete`: non-policy-raw, recorded check-in and check-out, and an applicable nonorphan row. A null reset is evaluated before those completeness/orphan checks in the owner. Preserve the distinction: clearing a stale override is not rejected merely because adding a new one would be refused. Any later native recomputation refusal still aborts the whole transaction.

No employment, punch, clock capture, approval request, payment or TOIL credit is created by this command. A calculated overtime source/revision may be created only by the actual native refresh path, as observed in its returned evidence.

## Native effect contract

| State | Permitted effect and required retention |
| --- | --- |
| Adjustment | Exact selected manual-map edits only; preserve every unselected manual entry including its provenance. Preserve shiftId and dayKind exactly. Native reason/actor/time/version are recorded; version advances once. |
| Native overtime rows | Expose calculated, approved Auto baseline, current effective minutes and proposed effective minutes separately. Return to Auto uses the native approved baseline, which can differ from original calculated minutes. Never compute that baseline in Assistant code. |
| Calculated attendance | If recorded check-in exists, native calculation/recompute owns all thirteen minute figures, status/day type and trace. Preserve original punch set, captured-clock envelope and unrelated attendance columns. No check-in means do not invent a calculated attendance row. |
| Pattern calculations | Native refresh owns recorded/refused marker, revision, duration, amount and earning lines. Retain immutable prior revisions and read historical amounts through `readOvertimePatternCalculationTx`. |
| Payroll | Native owner locks covering runs, refuses closed runs and marks affected processed runs stale, including already-stale runs. Preserve unrelated batch facts and other employees' recalc membership. Explicitly show period/run sequence/date/own stale state. |
| Audit | Same native `attendance.day.corrected`, `kind=overtime`; exact actor, tenant, employment/date, adjustment and related calculation/refusal/payroll events. Current proof requires actual top-transaction rows/events, not preview SAVEPOINT effects or an old event. |

The native calculation input explicitly treats recorded legacy manual rows as `approval.status=unknown` and `approval.minutes=unknown(legacyManualOvertimeNeedsReview)` ([overtime-input.ts](../../packs/attendance/overtime-input.ts)). A manual row therefore must not be presented as an approved pattern payment. The review displays actual native ready/ineligible/refused/unavailable states and exact issues. Resetting to Auto may restore a different native outcome, which must also come from a real preview. Existing [canonical-input cases](../../test/overtime-canonical-input-db.test.ts) pin this refusal behavior; they have not been rerun for this proposal.

The existing schedule-only `reviewEffects` option and SQL0738 receipt deliberately refuse overtime or require unchanged manual rows. Do not weaken those checks or edit historical SQL. The future OT branch needs its own opt-in proof path, preserving the schedule branch byte-for-byte where possible and its public contract exactly.

## Locking, preview and custody

1. Resolve fresh actor/entitlements/allowance/pause and native subject scope. For resume, read minimal own nomination metadata before accessing ciphertext. The review Binding includes tenant, USER, nullable caller PERSON, employment, current company, subject PERSON and typed date.
2. Follow the existing native lock order: access/leave dependency interlocks, subject advisory lock, covering payroll and overtime-source locks, dependent-credit refusal, actual day row and baseline read. Retain pre-preview locks outside the SAVEPOINT. Do not lock the custody row before native business locks; keep existing custody NOWAIT behavior.
3. Add a narrow native overtime review admission seam that shares the exact owner's validation and lock owner. Do not invoke the schedule-only validation helper with fabricated fields. Do not duplicate validation/calculation in the Assistant adapter.
4. Capture native before state and authorized native financial views. Within a SAVEPOINT call the same writer in the explicitly opted-in OT evidence mode, read actual native after state and related events, then rollback and release in `finally`. Retain or reacquire earning-label locks and verify labels after rollback.
5. Private commitment includes actual input/baseline, selected rows/order, native before/after views, native canonical input/approval/reference/duration digests and fresh entitlements. Exclude only newly generated preview IDs/times from replay equality, never user choices or financial provenance. Prove repeated previews are stable before mounting custody; manual actor/recordedAt values must not cause an invented stable hash or omitted money evidence.
6. Reuse `createReviewCustody`, the existing ledger/crypto/nonce/erasure owners, ten-minute expiry, five-pending and twenty-per-ten-minute limits. Date participates in AAD and private commitments. Parse the total public Prepared budget before committing the ciphertext insert.
7. Confirmation repeats the real preview, rejects stale/private-commitment mismatch, performs the actual native write in the same top transaction, verifies current exact native effects and compares human-visible before/after to the reviewed values. Schedule and OT reviews on the same date share native interlocks: the first write invalidates the other's baseline; do not invent cross-kind completion or silently replace its content.
8. Completion stores only the authenticated native event ID, clears ciphertext/digests, and uses the existing native-outcome target/erasure machinery. Replay returns the same completion without a second write. Historical reopen uses the original immutable witness and native financial revision under current authority, not today's mutable day equality.

## Privacy and exact effect proof

Subject-readable audit witnesses may contain existing native day/legacy-row summaries and own processed-run metadata, but no new raw salary, full financial evidence, financial-content hashes, unrelated payroll contents or unrelated-recipient hashes. Financial row references use identity metadata only; native financial readers independently validate immutable contents. Unrelated payroll retention fingerprints remain transient/private and are stripped before native audit payload construction.

The OT proof must bind `kind=overtime` and date, adjustment version/actor/reason, unchanged schedule overrides, retained unselected manual entries and the selected actual reset/manual results. The private native before/after map may attest provenance; public rendering does not need other actors' full metadata. Checks of new native map fields must use the real writer's recordedAt/actorId, not caller-posted timestamps. Capture/adjustment row identity hashes are not substitutes for actual current row comparison.

Keep current top-transaction proof for calculated rows, newly changed pattern source/revision/evidence/parts/lines, every processed payroll row and related native audits. Keep original punches and non-calculated clock fields identical. Historical mode authenticates the same immutable original event and related evidence without reopening a payroll. Reuse safe helpers only when their semantics match; do not rename the existing schedule receipt into a permissive multi-kind verifier.

## Exact migration requirement for coordinator allocation

Request **one new, unapplied development migration**, provisional private suffix `assistant_attendance_day_overtime_correction`; proposed helper prefix `assistant_attendance_day_overtime_*`. No executable filename, journal index, version or timestamp is claimed. It must append after the reconciled accepted ledger and preserve all existing migration bytes, including0738.

Required operations in that single migration:

1. Register only `attendance.day_overtime.correct` in the existing closed kind table. Preserve the existing membership FK; no rebuilt global allowlist.
2. Add typed `day_overtime_date date` nomination to the existing review ledger. Require it only for this kind and require NULL for every predecessor; retain the schedule date's existing rule. Bind subject PERSON/company/employment using current native identity/scope.
3. Add only necessary actor/legacy-column/decision/receipt CHECK branches. Select the actor rule by actual column dependencies and expected predecessor markers before deparsing; log raw expression bytes, use one canonical bounded null branch and carry the prior predicate once. Preserve dedicated predecessor checks and refuse drift.
4. Preserve original generic/assigned index predicates while excluding only this new dated kind, then add one pending uniqueness rule for tenant/kind/USER/employment/date. Existing schedule and other pending semantics survive.
5. Add narrow scoped native effect state/proof helpers only as needed for OT, plus closed `prepare/subject/read/discard/index/complete` command and private metadata projector. No broad SELECT grant, new ledger, new crypto owner or shared runtime redesign.
6. Extend the exact existing native-outcome completed/target/choices owners for this one kind with marker/count guards. Reuse generic target capture and person/employment erasure. Completion calls the OT current proof before persisting event ID and clearing private content.
7. Revoke PUBLIC/private-helper access and grant only necessary scoped entrypoints to `ai_hr_app`. Preserve SECURITY DEFINER search_path pinning and native authority on every operation.

Coordinator decisions requested: confirm proposed action/route/tier and allocate the single migration identity. The existing crypto/custody contract already represents the typed date; no shared engine decision is requested. Full mount and migration-bearing hosted checks wait for the allocated identity.

## Verification plan and review handoff

No local runtime, tests, collection, compiler, DB, seed or server is authorized for this proposal. After implementation, freeze an exact full SHA and run planned groups on standard public `ubuntu-24.04` via `alpha-focused-checks.yml`, whole-repository typecheck true on every group. All planned jobs finish before repairs; retain actual successful evidence and original failures.

Focused behavior coverage must include:

- Actual native create-first-adjustment and update-existing paths; selected-row manual/zero/null reset, unselected provenance retention, orphan reset and incomplete-day reset, duplicate/foreign keys, fractions/range/over-work refusal, approved Auto baseline, policy-raw behavior, Full Flexi closed sessions and unchanged captured clocks.
- Real pattern-native legacy-manual refusal, exact amount/earning-line evidence where native Auto permits it, reset restoration, stable repeated preview and same-parent preview-to-actual top-transaction proof. No expected-money weakening or guessed formula.
- Processed payroll consent/already-stale audits, closed payroll/dependent credit refusals, unchanged unrelated payroll data; current/historical receipt and wrong-date/old-event/SAVEPOINT-only proof refusal.
- Encryption/date AAD, stale config/day/approval/subject binding, concurrent exactly-once confirmation, cross-kind schedule/OT stale behavior, lost-response replay, expiry, erasure, allowance/pause revocation, genuine unlinked USER, SYSTEM/self/foreign tenant/USER, native role partition, old-kind/hybrid/null guards and inside-transaction oversized-output rollback.
- Strict transport/output budget, genuinely mounted OT adapter and inventory guard, six-locale before/after/consent/refusal/recovery controls, mobile/desktop captures and applicable native schedule/OT/shared regressions. Component fixture screenshots remain distinct from authenticated server journeys.

Open proof obligations are implementation-specific native OT evidence admission and stable preview/current proof; they are not resolved by schedule results from PR127. This document provides the concrete contract and migration request only. Calendar and dated-shift arrangement remain separate native gaps with different effect sets.
