-- Owner decision 12 November 2026 (Manager Today, item 4): a per-company "minimum people present" leave setting that the
-- approver recommendation (core/recommenders/leave-decision.ts, team_coverage) checks a leave request against.
-- DRAFT, UNALLOCATED: 9770 is from the coordinator-provided 9770-9779 block; the final tag, idx and `when` are assigned
-- at integration (docs/MIGRATION-ALLOCATION.md).
--
-- One nullable column on `company`, beside the other per-company leave settings (leave_multi_approval, leave_cycle,
-- leave_half_day_full_deduction, escalate_after_days). `company` already has row security, its admin-for-company update
-- policy and the table-level app grant (0324), so the column needs no policy or grant of its own.
--   leave_team_minimum_present — the fewest people of a team who must be present on any day. NULL = no minimum (every
--                                existing row, and the recommendation is unchanged). No default and no backfill.
-- The CHECK accepts NULL and whole numbers from 0; every row holds NULL when it is added, so validation passes.
--
-- Rollback (manual, only if never relied upon):
--   ALTER TABLE company DROP CONSTRAINT company_leave_team_minimum_present_check;
--   ALTER TABLE company DROP COLUMN leave_team_minimum_present;
ALTER TABLE company ADD COLUMN leave_team_minimum_present integer;
--> statement-breakpoint
ALTER TABLE company ADD CONSTRAINT company_leave_team_minimum_present_check CHECK (leave_team_minimum_present IS NULL OR leave_team_minimum_present >= 0);
