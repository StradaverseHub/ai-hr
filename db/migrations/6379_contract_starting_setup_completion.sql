-- Complete six email defaults and explicit business-group BP access readiness.
CREATE OR REPLACE FUNCTION app.contract_shared_setup_read(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract setup is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('v9Ready',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),'installed',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=app.current_tenant_id() AND company_id=p_company) AND 23=(SELECT count(*) FROM(
  SELECT id FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
  UNION SELECT template_id AS id FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND template_id BETWEEN 'c017ac70-0000-4000-8000-000000000101'::uuid AND 'c017ac70-0000-4000-8000-000000000106'::uuid
  UNION SELECT workflow_id AS id FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND workflow_id BETWEEN 'c017ac70-0000-4000-8000-000000000201'::uuid AND 'c017ac70-0000-4000-8000-000000000212'::uuid) definitions),
 'jobId',(SELECT id FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND kind='contract_setup' AND company_ids @> ARRAY[p_company] ORDER BY created_at DESC,id LIMIT 1),
 'canInstall',app.automation_can_manage('contract_staff','workflows') AND app.automation_can_manage('contract_staff','templates') AND app.contract_company_writable(p_company),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name') ORDER BY g->>'name',g->>'id') FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',routing_id,'name',name) ORDER BY name,routing_id) FROM(SELECT DISTINCT ON(routing_id) routing_id,name,retired FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC) latest WHERE NOT retired),'[]'::jsonb),
 'missing',CASE WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Contract group projection is not initialized. Ask an authorized On/Off Boarding administrator to complete native setup; shared groups are retained.') WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Create the real assignment groups in HR Automation first.') ELSE jsonb_build_array('Map populated People Ops and posting approver groups, and BP and CEO routings before installing the starting configuration.') END) INTO result;
 result:=result||jsonb_build_object('accessReady',EXISTS(
  SELECT 1 FROM public.contract_access_role r JOIN public.contract_access_member m ON m.tenant_id=r.tenant_id AND m.role_id=r.id
  JOIN public.app_user u ON u.tenant_id=m.tenant_id AND u.id=m.user_id JOIN public.person person ON person.tenant_id=u.tenant_id AND person.id=u.person_id
  JOIN public.company company ON company.tenant_id=m.tenant_id AND company.id=p_company
  WHERE r.tenant_id=app.current_tenant_id() AND lower(r.name)='people business partner' AND r.permissions @> ARRAY['view','decide']::text[]
   AND m.revoked_at IS NULL AND m.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (m.valid_to IS NULL OR m.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND m.business_group_id=coalesce(company.parent_company_id,company.id) AND (m.company_id IS NULL OR m.company_id=p_company)
   AND app.contract_verified_human(u.id)));
 IF NOT (result->>'accessReady')::boolean THEN result:=jsonb_set(result,'{missing}',(result->'missing')||jsonb_build_array('An Access administrator must explicitly assign the People Business Partner role (View cases, Submit decisions) for this business group. Signing routing does not grant access.'));END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_read(uuid) TO ai_hr_app;

--> statement-breakpoint

--> statement-breakpoint
-- Creates only the named role, under the normal explicit Access administrator command. It assigns nobody.
CREATE FUNCTION app.contract_shared_setup_access_role() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_access_admin() IS NOT TRUE THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contract_access_role WHERE tenant_id=app.current_tenant_id() AND lower(name)='people business partner') THEN
  PERFORM app.contract_shared_role_save('c017ac70-0000-4000-8000-000000000401'::uuid,'People Business Partner',ARRAY['view','decide']::text[],0);
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_access_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_access_role() TO ai_hr_app;
