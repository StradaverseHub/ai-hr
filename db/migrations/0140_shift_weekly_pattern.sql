-- R7 Multi-Shift Attendance — PHASE 2 (weekly pattern). Additive ALTER TABLE shift, modelled on 0139:
--   • weekly_pattern — ISO weekday numbers (1=Mon … 7=Sun) that are WORKING days for this shift; the rest
--     of the week is the complement (rest days). Mirrors attendance_policy.working_days. NULLABLE: null ⇒
--     no pattern set, the shift cannot drive generateRosterFromTemplate (core/roster.ts) and every existing
--     shift keeps today's behaviour untouched.
--
-- RLS/policies on shift already exist and are unchanged; grants are table-level (0075), so the added
-- column needs no new grants.

ALTER TABLE "shift" ADD COLUMN "weekly_pattern" integer[];
