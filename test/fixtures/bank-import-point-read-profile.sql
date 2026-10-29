-- PRIVATE REVIEW DRAFT ONLY. Unallocated; never add directly to a live database.
-- Requires the final verified preceding source/ledger and central allocation.
-- The hint is an optimization, never authority. app.is_admin_for(company_id)
-- is already a subset of the original employment visibility predicate.
-- ALTER POLICY changes only USING: roles, command, WITH CHECK and additive
-- named-agent policies remain untouched. No function replacement is proposed.
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
