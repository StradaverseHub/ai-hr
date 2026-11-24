-- The nightly sweep preserves closed payroll before it applies a due movement (5777, b39ffe04c).
-- 5777 made the sweep a system actor: no signed-in user, recorded_by NULL, preservationActor 'system',
-- admitted through app.access_workforce_owner_company. information_snapshot_insert (0698) still requires
-- recorded_by = app.current_user_id(), so on an installation whose storage owner is NOT a superuser (staging,
-- production) the snapshot INSERT is refused by row security and every due movement for an employee with a
-- closed payslip that has no snapshot yet stays Pending. CI connects as a superuser, which bypasses row security.
-- This adds the missing INSERT policy for exactly the admission app.preserve_payroll_metadata already enforces
-- for the system path: storage-owner session, no user, workforce maintain on the employment, administrator
-- grant on the paying company, and a CLOSED payslip of this employment paid by that company.
-- The user path (information_snapshot_insert) and the Contract path (contract_posting_snapshot_insert) are unchanged.
CREATE POLICY information_snapshot_system_preserve_insert ON public.information_payslip_snapshot FOR INSERT TO ai_hr_owner
 WITH CHECK(
  tenant_id=app.current_tenant_id()
  AND recorded_by IS NULL AND app.current_user_id() IS NULL
  AND document_metadata->>'preservationActor'='system'
  AND app.access_workforce_storage_owner()
  AND app.access_workforce_employment(employment_id,'workforce.maintain')
  AND app.is_admin_for(company_id)
  AND EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
   WHERE p.id=information_payslip_snapshot.payslip_id AND p.employment_id=information_payslip_snapshot.employment_id
    AND p.tenant_id=information_payslip_snapshot.tenant_id AND b.tenant_id=information_payslip_snapshot.tenant_id
    AND b.company_id=information_payslip_snapshot.company_id AND b.status='closed'));
