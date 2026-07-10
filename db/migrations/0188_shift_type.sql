-- f3321963 — Shift Settings Enhancement & Simplified Shift Configuration (Phase 1 foundation).
--
-- shift.type — the reporter's "Shift Type": which attendance/scheduling behaviour a shift template follows.
--   'normal'      = fixed Time-In/Time-Out schedule (today's behaviour). DEFAULT, so every existing shift is
--                   byte-identical (NULL/absent ⇒ 'normal').
--   'semi_flexi'  = flexible start within a window (earliest-in / latest-out / required hours); breaks are
--                   always Flexible + no clocking required (enforced by the service).
--   'full_flexi'  = employee sets their own hours, only the required working + break hours matter. Reserved
--                   for a FUTURE enhancement (the reporter marked it so) — the enum value is accepted for
--                   forward-compatibility but the setup UI disables the option.
-- CHECK-constrained to the three values. This is an ADDITIVE, backward-compatible column: the attendance
-- engine (core/attendance.ts scheduleFor / deriveAttendance) keeps its single-window Normal behaviour; the
-- Semi/Full-Flexi engine branches are deferred Phase-2/3 work. No RLS change (column on the already-policed
-- shift row).
--
-- NOTE this is DISTINCT from employment.shift_type ('fixed'|'roster', migration 0162) which is a per-EMPLOYEE
-- assignment MODE, not this per-TEMPLATE type.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guard); integration may renumber this file.
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_type_check" CHECK ("type" IN ('normal','semi_flexi','full_flexi'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
