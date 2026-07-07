-- Per-employee DEFAULT shift (feedback ec4cbf63 "Configurable Multi-Shift Attendance Management", rev-6 —
-- the contested half: "assigned to the staff in their profile"). The shift catalogue + Attendance-Policy
-- relocation shipped earlier (3df577a); this adds the missing binding: which shift a person NORMALLY works,
-- set once on the personnel profile instead of painting every date on /roster.
--
-- Resolution order in core/attendance.ts scheduleFor becomes: dated roster row → THIS default shift (its
-- weekly_pattern decides working vs rest day) → flat company attendance policy. Null ⇒ today's behaviour.
--
-- Mirrors the employment.payroll_policy_id precedent end-to-end: nullable uuid on employment, ON DELETE SET
-- NULL (deleting a shift falls the employee back to the company policy, never an FK error). The service
-- (core/roster.ts assignDefaultShift) additionally validates same-company + non-archived at assignment time
-- — RLS cannot catch a same-tenant cross-company mis-assignment.
--
-- No RLS change: default_shift_id is a column on employment, already covered by employment's row policies
-- (admin-gated writes, same as payroll_policy_id / geofencing_enabled).
--
-- Idempotent (IF NOT EXISTS / duplicate_object guard): integration may renumber this file.
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "default_shift_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "employment" ADD CONSTRAINT "employment_default_shift_id_shift_id_fk" FOREIGN KEY ("default_shift_id") REFERENCES "public"."shift"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
