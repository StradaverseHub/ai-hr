-- BK23: WITH CHECK does not constrain DELETE. Preserve existing SELECT/INSERT/UPDATE
-- policies and intersect ordinary DELETE with its actual current write authority.
CREATE POLICY payroll_cycle_delete_authority ON public.payroll_cycle AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING (app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint
CREATE POLICY employee_loan_delete_authority ON public.employee_loan AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING (app.principal_snapshot_current() AND app.can_admin_employment(employment_id));
--> statement-breakpoint
CREATE POLICY loan_repayment_delete_authority ON public.loan_repayment AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING (app.principal_snapshot_current() AND app.can_admin_employment(employment_id));
--> statement-breakpoint
-- Removing the last scope widens a delegation to all tasks. Only its scoped HR owner or
-- the actual self-service delegator may remove that restriction, never a tenant reader.
CREATE POLICY reporting_line_scope_delete_authority ON public.reporting_line_scope AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING (app.principal_snapshot_current() AND EXISTS (
  SELECT 1 FROM public.reporting_line rl JOIN public.employment e
   ON e.id=rl.subordinate_employment_id AND e.tenant_id=rl.tenant_id
  WHERE rl.id=reporting_line_id AND rl.tenant_id=app.current_tenant_id()
   AND (app.is_admin_for(e.company_id) OR (rl.line_type::text='delegate' AND EXISTS (
    SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
     AND u.tenant_id=rl.tenant_id AND u.person_id=e.person_id)))
 ));
--> statement-breakpoint
-- There is no ordinary native DELETE command for dated adjustment history. The editor
-- upserts and retains provenance; explicitly undo bootstrap's default DELETE grant.
REVOKE DELETE ON public.attendance_day_adjustment FROM ai_hr_app;
