-- Approved 989bdb77: page only held-manager metadata under full case authority.
-- Evaluate principal/config/grants once, then join companies and cases set-wise. No private case blobs leave SQL.
CREATE FUNCTION app.lifecycle_manager_recovery_page(p_after text DEFAULT '',p_limit integer DEFAULT 100)
RETURNS TABLE(case_id uuid,company_id uuid,revision integer,run jsonb,facts jsonb,total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE uid uuid:=app.current_user_id(); tenant uuid:=app.current_tenant_id(); grants jsonb; sections jsonb; off_allowed boolean;
BEGIN
 IF p_after IS NULL OR length(p_after)>800 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid recovery page'; END IF;
 IF uid IS NULL OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM public.app_user u WHERE u.id=uid AND u.tenant_id=tenant AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 ) THEN RETURN; END IF;
 -- The same authority owners as lifecycle_recipient_case_allowed/lc_v9_off_access.
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)),'[]'::jsonb) INTO grants FROM app.current_grants() g;
 sections:=app.onboarding_v9_sections();
 SELECT coalesce(cfg.data->'access'->'offboarding' ? uid::text,false) INTO off_allowed FROM public.lc_onboarding_config cfg WHERE cfg.tenant_id=tenant;
 RETURN QUERY
 WITH companies AS MATERIALIZED (
  SELECT co.id FROM public.company co WHERE co.tenant_id=tenant AND app.grants_admin_for(grants,co.id)
 ), candidates AS MATERIALIZED (
  SELECT DISTINCT h.case_id,h.company_id,h.module FROM public.lc_v9_email_hold h JOIN companies co ON co.id=h.company_id
  WHERE h.tenant_id=tenant AND h.released_at IS NULL
   AND (h.module='off' AND coalesce(off_allowed,false) OR h.module='onb' AND sections->>'actions'='allowed' AND sections->>'hr'='view')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.missing) m WHERE m->>'reason'='no supervisor on the Personnel record')
 ), cases AS MATERIALIZED (
  SELECT c.id,c.company_id,c.revision,c.data->'facts' AS facts,c.data->'runs' AS runs
  FROM public.lc_v9_case c JOIN candidates h ON h.case_id=c.id AND h.company_id=c.company_id AND h.module='off'
  WHERE c.tenant_id=tenant AND c.module='off' AND c.data->>'state'='submitted'
  UNION ALL
  SELECT c.id,c.company_id,c.revision,jsonb_build_object('joinDate',coalesce(p.data->'source'->>'joinDate',c.data->'source'->>'joinDate'),'lastDay',''),p.data->'lifecycleV9'->'runs'
  FROM public.lc_onboarding_case c JOIN candidates h ON h.case_id=c.id AND h.company_id=c.company_id AND h.module='onb'
  JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  WHERE c.tenant_id=tenant AND c.data->>'state'='submitted'
 ), held AS (
  SELECT c.id,c.company_id,c.revision,c.facts,r FROM cases c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.runs,'[]')) r
  WHERE r->>'status'='waiting' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r->'hold'->'missing','[]')) m WHERE m->>'role'='supervisor' AND m->>'reason'='no supervisor on the Personnel record')
 ) SELECT h.id,h.company_id,h.revision,
  jsonb_build_object('id',h.r->>'id','date',h.r->>'date','definition',jsonb_build_object('trigger',h.r->'definition'->'trigger'),'hold',jsonb_build_object('stepId',h.r->'hold'->>'stepId','at',h.r->'hold'->>'at')),
  jsonb_build_object('joinDate',h.facts->>'joinDate','lastDay',h.facts->>'lastDay'),count(*) OVER()
 FROM held h WHERE h.id::text||':'||(h.r->>'id')>p_after ORDER BY h.id::text,h.r->>'id' LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_manager_recovery_page(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_manager_recovery_page(text,integer) TO ai_hr_app;
