# Attendance day schedule correction — in progress

Verified parent: ca161dc08e7e580cb75e62ade4d49b0fa23aac60 (first schedule-group slice, PR120). This separate branch preserves the verified first slice and its frozen refs.

## Native owner seam authored

`packs/attendance/day-adjustment.ts` retains one native `saveAttendanceDayEdit` implementation. An optional existing transaction lets a later reviewed command commit its custody and actual native effects atomically. Opt-in event return exposes only the exact adjustment/event UUID and version; default callers keep `{version}`. `attendanceDayEditor` can read that same transaction. The existing Attendance module assertion is reused for the supplied transaction; no service-wide gate is bypassed.

Native validation, self/company/date checks, reason length, shift/day-kind/NULL criteria, leave-day restrictions, dependent credit and payroll protections remain in place. Native calculation, recompute, overtime-pattern refresh and payroll stale marking remain in their existing order. No native authorization, money calculation or user linking is added. No Assistant day correction is mounted by this seam alone.

Authored focused tests verify default result/audit shape, same-topTx row/event proof and read-your-own-write, atomic outer rollback, and module refusal on the supplied-transaction path. Existing Attendance day native regressions remain required. No local runtime checks were run.

## Reserved next action (not mounted)

Coordinator allocated UNAPPLIED PROVISIONAL0738 /idx717/version7/when1793330000075/breakpoints:true for `attendance.day_schedule.correct`: one other-person employment/date, schedule mode only. No overtime-row mode, real clock capture or holiday-column fallback. Typed date must participate in custody AAD. The native preview must retain locks before rollback and show actual day figures, overtime-pattern changes and processed-payroll stale consequences. Exact current topTx effect proof, byte bounds inside custody, replay/erasure/hybrid cases and current native authority are required before full mounting. No SQL journal entry is claimed by this seam checkpoint.

## Native effect/preview checkpoint before Assistant mounting

Allocated0738 contains scoped native snapshot/receipt capabilities and a rollback preview. It does not yet register an Assistant command or change native UI. Default and ordinary event-return paths keep their original event order/payload and result shape. Explicit schedule reviewEffects mode marks native payroll first, then appends the same correction event with opaque tuple digests and safe day/payroll-subject summaries. Overtime financial evidence is read separately through the native company financial reader.

Retained locks precede the SAVEPOINT; preview adjustment, day, pattern, payroll and audit writes roll back. New earning-label locks are reacquired after rollback and displayed values checked. Current proof requires the exact event, adjustment and changed effect tuples in the top transaction. Historical reads authenticate original native evidence without requiring current day/payroll values to match. Native clocks and unrelated payroll fields are digest-bound unchanged. Large/inaccessible evidence requires native handoff.

Authored hosted coverage includes empty day preview, real calculated figures and unchanged punches, stable repeats, outer rollback, stale/self/date/mode refusal, historical/current and SAVEPOINT distinction, processed payroll consent/stale mark, altered figures and exact native pattern money/earning lines. Actual hosted results pending.

Mounting dependency: native saveAttendanceDayChangesAction is a composite schedule/overtime entrypoint. The inventory must disclose missing overtime mode rather than mark the whole composite covered. A shared representation decision belongs to the coordinator; this checkpoint does not redesign inventory semantics or mount the new command.

The current native projection includes bounded original cash/duration refusal issues and policy refusal reasons, keeping a recorded refusal distinct from a payable result. Current earning code/name are authorized display decorations, as on the native UI; monetary amounts and policy/version/assignment evidence refer to the immutable recorded revision. The private preview digest also binds the proposed header input/approval/reference/duration digests, excluding ephemeral preview IDs/timestamps. Processed batches require both current native row writes and their native recalc events even when already stale. A refused marker with no new calculation requires the native refusal audit for a captured day.
