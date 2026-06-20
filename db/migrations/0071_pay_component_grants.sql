-- Wave 3 follow-up: explicit ai_hr_app grants for the typed pay-component tables. 0065 RLS assumed the
-- cluster's DEFAULT PRIVILEGES would auto-grant arwd (as the deploy bootstrap configures), but a DB
-- migrated purely from db/migrations/ (fresh CI / clean provisioning) has no such default, leaving the
-- app role unable to touch these tables. Every other table grants explicitly in its RLS migration; do the
-- same here. Idempotent. (RLS policies in 0065 still govern row visibility + admin-only writes.)
GRANT SELECT, INSERT, UPDATE, DELETE ON pay_component TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_pay_component TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_batch_component TO ai_hr_app;
