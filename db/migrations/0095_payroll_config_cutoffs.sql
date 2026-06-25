-- Payroll Configuration tab (#feedback): per-purpose cut-off scheduling metadata.
-- Adds overtime / claim / unpaid-leave / attendance cut-off days to company_payroll_config.
-- Scheduling METADATA only (no payroll-math change) — these join cut_off_day (the salary/inputs
-- cut-off) as scheduling reference; null = month-end / inherit. Nullable, no default (matches
-- existing cut_off_day / pay_day). Inherits the existing company_payroll_config_rls policy
-- (FOR ALL USING/WITH CHECK applies to all columns) and the ai_hr_app grant — no policy/grant change.
ALTER TABLE "company_payroll_config" ADD COLUMN "overtime_cut_off_day" integer;--> statement-breakpoint
ALTER TABLE "company_payroll_config" ADD COLUMN "claim_cut_off_day" integer;--> statement-breakpoint
ALTER TABLE "company_payroll_config" ADD COLUMN "unpaid_leave_cut_off_day" integer;--> statement-breakpoint
ALTER TABLE "company_payroll_config" ADD COLUMN "attendance_cut_off_day" integer;
