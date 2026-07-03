-- Feedback request 31474452: "Half Day" work-schedule day type + leave-deduction toggle.
--
--   • attendance_policy.half_working_days — ISO weekday numbers (1=Mon..7=Sun) marked as a HALF working day
--     on the company work schedule (mirrors working_days). Disjoint from working_days by CHECK — a weekday is
--     Full (in working_days), Half (in half_working_days), or Rest (in neither). Additive + defaulted to '{}'
--     so every existing company keeps exactly today's Full/Rest schedule.
--   • company.leave_half_day_full_deduction — per-company toggle. OFF (default): leave taken on a Half day
--     deducts 0.5 day. ON: it deducts 1.0 day (the reporter's "count as 1 full day" ask). Full working days
--     are completely unaffected by this column either way.
--
-- No RLS changes: both tables' existing row-level policies already cover any column on the row (RLS predicates
-- here are row-scoped by company/tenant, not column-scoped), so the new columns inherit the current policies.
ALTER TABLE "attendance_policy" ADD COLUMN "half_working_days" integer[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "attendance_policy" ADD CONSTRAINT "attendance_policy_working_half_disjoint" CHECK (NOT (working_days && half_working_days));--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "leave_half_day_full_deduction" boolean NOT NULL DEFAULT false;
