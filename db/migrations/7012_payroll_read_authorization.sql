-- These definers call authorization code that reads the forced-RLS company hierarchy.
-- Ordinary owner-exempt relations and all explicit tenant and company checks are unchanged.
ALTER FUNCTION app.payroll_tax_basis_original_employer_read(uuid) SET row_security = on;
ALTER FUNCTION app.payroll_tax_import_source_revision(uuid) SET row_security = on;
ALTER FUNCTION app.payroll_import_tax_reader_compatible(uuid, uuid, jsonb) SET row_security = on;
ALTER FUNCTION app.payroll_tax_basis_reader_compatible(uuid, uuid) SET row_security = on;
ALTER FUNCTION app.pay_formula_saved(text) SET row_security = on;
ALTER FUNCTION app.pay_formula_active(text) SET row_security = on;
ALTER FUNCTION app.pay_formula_category(uuid, text) SET row_security = on;
--> statement-breakpoint
-- Validate the human snapshot once per statement, including reads through security-invoker
-- history views. Existing permissive policies still decide which rows each actor can read.
CREATE POLICY payroll_batch_current_human_read ON public.payroll_batch
  AS RESTRICTIVE FOR SELECT TO ai_hr_app
  USING ((SELECT app.current_user_id() IS NULL OR app.principal_snapshot_current()));
CREATE POLICY payslip_current_human_read ON public.payslip
  AS RESTRICTIVE FOR SELECT TO ai_hr_app
  USING ((SELECT app.current_user_id() IS NULL OR app.principal_snapshot_current()));
