-- Bank imports retain the same current-principal authorization, native locks and audits.
-- A transaction-local marker avoids rebuilding the full visibility array for authorized
-- company-administrator point reads. The administrator condition is already contained
-- in the original payroll-admin visibility arm; the marker grants no authority.
-- Unset and unrecognized markers use the original predicate. WITH CHECK, roles,
-- command and additive named-agent policies remain unchanged.
ALTER POLICY employment_rls ON public.employment
USING (
  (voided_at IS NULL)
  AND (tenant_id = app.current_tenant_id())
  AND CASE WHEN (SELECT current_setting('app.bank_import_point_read', true)) = 'on'
    THEN CASE WHEN app.is_admin_for(company_id) THEN true ELSE
      ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id = ANY ((SELECT app.visible_employment_ids())::uuid[])) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id))))
    END
    ELSE
      ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id = ANY ((SELECT app.visible_employment_ids())::uuid[])) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id))))
  END
);
