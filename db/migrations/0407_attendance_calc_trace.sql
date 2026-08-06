-- 7c834696 POINT 3 — store the WORKING behind each day's lateness, early-out and overtime figures.
--
-- The reporter's ask: "Every lateness, early out and overtime figure gains a hover that shows how it was
-- arrived at: the shift times used, the break deducted, the raw clock in and out, the rule that applied,
-- the step-by-step working, the rounding, and the final result."
--
-- ── WHY A STORED COLUMN AND NOT A READ-TIME RECOMPUTE ────────────────────────────────────────────────
-- The approved plan's build note said this "depends on nothing new being stored" and should be emitted
-- from deriveAttendance. Both halves cannot hold at once: deriveAttendance runs at WRITE time (check-in,
-- check-out, correction approval, punch import) and the Records screens read rows written weeks earlier.
--
-- Reconstructing at read time is not safe here. Shifts, rosters and attendance rules are effective-dated
-- AND editable in place — a rule's OT bands can be re-typed without moving any effective date. A day
-- computed in June, re-explained in August against the edited ladder, would print working that does not
-- add up to the number printed beside it, on the one screen whose entire purpose is auditability.
--
-- core/pcb-explain.ts settled this pattern for payslips and states it plainly: "a panel that re-derived
-- the figure could disagree with the figure it claims to explain, which is worse than no panel." Same
-- shape here — the engine stamps as it computes, and a row with no trace says so.
--
-- ── NULLABLE, AND NOT BACKFILLED ─────────────────────────────────────────────────────────────────────
-- Every existing row gets NULL and the panel reports "no working was recorded for this day". Measured on
-- production 2026-08-06: 243 attendance days, so essentially all of them until they are next re-derived.
-- A backfill is IMPOSSIBLE and it matters that this is written down rather than left as a to-do: the
-- inputs a trace needs (the shift, roster and rule AS THEY WERE) are exactly what cannot be recovered for
-- a past date. Inventing one from today's configuration is the failure this column exists to prevent.
--
-- No GRANT: nothing is created, and attendance's grants already cover ai_hr_app.

ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "calc_trace" jsonb;--> statement-breakpoint

COMMENT ON COLUMN "attendance"."calc_trace" IS
  'The working behind late_minutes / early_out_minutes / ot_minutes and the OT split, stamped by the engine as it computes them (core/attendance-trace.ts, versioned). NULL = written before 7c834696 point 3, or by something that did not re-derive the day; the panel says so rather than reconstructing. NEVER backfill: the shift/roster/rule as they were on a past date cannot be recovered, and inventing them is the defect this column prevents.';
