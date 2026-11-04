-- Retained approved-feedback scopes never become an opaque FK refusal or an implicit delete.
CREATE FUNCTION app.approved_feedback_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND app.is_admin_for(p_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()) AND (
 EXISTS(SELECT 1 FROM public.probation_activation_request r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=p_company)
 OR EXISTS(SELECT 1 FROM public.reward_company_classification r WHERE r.tenant_id=app.current_tenant_id() AND (r.company_id=p_company OR r.canonical_company_id=p_company))
 OR EXISTS(SELECT 1 FROM public.company_organisation_mapping m WHERE m.tenant_id=app.current_tenant_id() AND (m.company_id=p_company OR m.parent_company_id=p_company OR m.business_group_id=p_company))
 OR EXISTS(SELECT 1 FROM public.company_organisation_mapping m JOIN public.business_unit b ON b.id=m.business_unit_id AND b.tenant_id=m.tenant_id WHERE m.tenant_id=app.current_tenant_id() AND b.company_id=p_company)
 OR EXISTS(SELECT 1 FROM public.company_organisation_run_row r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=p_company)
 OR EXISTS(SELECT 1 FROM public.employment_organisation_classification r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=p_company)
 OR EXISTS(SELECT 1 FROM public.company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND (p_company=ANY(r.company_ids) OR p_company=ANY(r.authority_company_ids)))
 );
$$;
REVOKE ALL ON FUNCTION app.approved_feedback_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approved_feedback_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Canonical deletion authority follows the reviewed current parent, matching company RLS.
CREATE OR REPLACE FUNCTION app.delete_unused_usage_snapshots(p_company uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(
  SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id),c.id))
 ) THEN RAISE EXCEPTION 'not permitted to remove usage records for this company' USING ERRCODE='42501';END IF;
 DELETE FROM public.usage_snapshot u WHERE u.company_id=p_company AND u.tenant_id=app.current_tenant_id()
  AND u.active_employments=0 AND u.active_users=0 AND u.payslips_generated=0;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
