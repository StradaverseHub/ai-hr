-- Company deletion sees the Probation reshape's owner-only company referrers (Probation Confirmation build; the release
-- gate's company-referrer inventory). Tag 5766 / idx 5166 / when 1793330005466, assigned by the build coordinator.
--
-- core/company-refs.ts declares every foreign key to company.id; deleting a company refuses while a declared row
-- exists. Three tables added by this build are owner-only (forced row security, no application grant), so the
-- application role cannot see their rows: probation_access_member (5763, company and business group),
-- probation_form_import (5762) and probation_settings_scope_member (5742). This adds the one read-only owner function
-- their declarations name, built exactly like app.replan_retained_company_in_use (0953): the caller must be a current
-- administrator of the company in the current tenant, and it answers only whether any such row exists.
-- No table, row, policy or grant on an existing object changes.
CREATE FUNCTION app.probation_reshape_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE(app.principal_snapshot_current() AND app.is_admin_for(wanted_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()),false)
  AND (
   EXISTS(SELECT 1 FROM public.probation_access_member h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_access_member h WHERE h.tenant_id=app.current_tenant_id() AND h.business_group_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_form_import h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
   OR EXISTS(SELECT 1 FROM public.probation_settings_scope_member h WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=wanted_company)
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_reshape_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_reshape_company_in_use(uuid) TO ai_hr_app;
