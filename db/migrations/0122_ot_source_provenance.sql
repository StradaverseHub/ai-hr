-- Fix-5 (audit M#17) — Overtime provenance. The four manual OT buckets are RM amounts the admin keys;
-- a SEPARATE "Prefill OT from attendance" runs the statutory s.60/60A/60D engine. Before this column there
-- was no flag distinguishing an attendance-derived OT total from a manually-keyed one, so a casual manual
-- Save could silently clobber a statutory prefill (and vice-versa) with no signal.
--
-- ot_source mirrors the existing tp1_source provenance pattern on this same table:
--   'attendance'  the OT total was produced by prefillOvertimeFromAttendance (the statutory engine)
--   'manual'      the OT total was last keyed by the admin (setPayrollInput)
--   NULL          legacy / no OT write recorded (back-compat — every existing row stays valid)
--
-- Additive + nullable + backfill-safe. The existing payroll_input RLS policies and ai_hr_app DML grants
-- cover this column by inheritance — a column add needs no new policy or grant.
--
-- Rollback:
--   ALTER TABLE payroll_input DROP COLUMN ot_source;
ALTER TABLE "payroll_input"
  ADD COLUMN IF NOT EXISTS "ot_source" text;
