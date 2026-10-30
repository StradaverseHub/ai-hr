-- Coordinator allocation0746/idx725/version7/when1793330000083. UNAPPLIED PROVISIONAL DEV ONLY.
-- Lifecycle-owned purpose projection. No case SELECT grant, no Personnel business effect.
CREATE FUNCTION app.onboarding_draft_discard_absence_context(p_draft uuid,p_company uuid,p_person uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();draft_id uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR p_draft IS NULL OR p_company IS NULL
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 -- Called after Access by Personnel. Also fail closed for a direct app-role call; never wait while
 -- holding another owner's data locks. These bytes match the canonical Access and onboarding owners.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL
   AND NOT app.login_blocked(a.id) AND a.person_id IS NOT DISTINCT FROM p_person
   AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=a.person_id AND p.tenant_id=t))
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=a.id AND r.tenant_id=t
    AND r.role::text IN ('hr_admin','super_admin') AND r.role::text=ANY(app.current_roles()))) THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 -- Exactly audit-chain -> onboarding, as lockOnboardingTx and persisted audit-chain trigger.
 IF NOT pg_try_advisory_xact_lock(hashtext('audit-chain:'||t::uuid::text)) THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(t::text||':onboarding',0)) THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 LOCK TABLE public.lc_onboarding_case IN SHARE MODE NOWAIT;
 -- Separate VOLATILE statements use fresh READ COMMITTED snapshots AFTER the membership fence.
 -- Do not turn this owner STABLE or combine the absence read into a pre-lock snapshot/CTE.
 SELECT id INTO draft_id FROM public.employee_draft WHERE id=p_draft AND tenant_id=t
  AND company_id=p_company AND (app.is_self_person(created_by_person_id) OR app.is_admin_for(company_id))
  AND app.access_workforce_draft(company_id,created_by_person_id,'read')
  AND app.access_workforce_draft(company_id,created_by_person_id,'edit') FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 -- Complete visibility is internal only: every retained status/company counts, even module OFF/config0.
 IF EXISTS(SELECT 1 FROM public.lc_onboarding_case c WHERE c.tenant_id=t AND c.source_draft_id=draft_id) THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION app.onboarding_draft_discard_absence_context(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_draft_discard_absence_context(uuid,uuid,uuid) TO ai_hr_app;
