-- Starting configuration uses the existing human-admitted kernel, not a synthetic system principal.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
VALUES('contract_setup',NULL,'tenant_queue','{"companyId":"string","mapping":"object"}'::jsonb,false);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_setup_check(p_company uuid,p_mapping jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_shared_permitted('access',p_company) AND app.automation_can_manage('contract_staff','workflows') AND app.automation_can_manage('contract_staff','templates')
 AND app.contract_company_writable(p_company) AND p_mapping->>'companyId'=p_company::text
 AND EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') member(user_id)
  JOIN public.app_user account ON account.tenant_id=v.tenant_id AND account.id::text=member.user_id WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=p_mapping->>'fallbackGroupId' AND app.contract_verified_human(account.id))
 AND EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') member(user_id)
  JOIN public.app_user account ON account.tenant_id=v.tenant_id AND account.id::text=member.user_id WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=p_mapping->>'postingApproverGroupId' AND app.contract_verified_human(account.id))
 AND (SELECT count(DISTINCT id) FROM unnest(ARRAY[p_mapping->>'bpRoutingId',p_mapping->>'ceoRoutingId']) requested(id))=(SELECT count(*) FROM (SELECT DISTINCT ON(routing_id) routing_id,retired,routing_rows FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() AND routing_id::text IN(p_mapping->>'bpRoutingId',p_mapping->>'ceoRoutingId') ORDER BY routing_id,revision DESC) latest WHERE NOT retired AND jsonb_array_length(routing_rows)>0),false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_check(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_check(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_setup_start(p_company uuid,p_mapping jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_shared_setup_check(p_company,p_mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Map existing populated groups and BP and CEO routings with Contract setup authority' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_mapping)<>'object' OR NOT p_mapping ?& ARRAY['companyId','fallbackGroupId','postingApproverGroupId','bpRoutingId','ceoRoutingId'] OR (p_mapping-ARRAY['companyId','fallbackGroupId','postingApproverGroupId','bpRoutingId','ceoRoutingId'])<>'{}'::jsonb
 OR EXISTS(SELECT 1 FROM jsonb_each(p_mapping) item WHERE jsonb_typeof(item.value)<>'string' OR length(item.value#>>'{}') NOT BETWEEN 1 AND 200)
 THEN RAISE EXCEPTION 'Invalid setup mappings' USING ERRCODE='22023';END IF;
 result:=app.bulk_job_enqueue('contract_setup',gen_random_uuid(),ARRAY[p_company]::uuid[],'',NULL,jsonb_build_object('companyId',p_company,'mapping',p_mapping));
 IF result->>'id' IS NULL THEN RAISE EXCEPTION 'Contract setup could not be queued' USING ERRCODE='40001';END IF;
 RETURN jsonb_build_object('jobId',result->>'id');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_start(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_start(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_setup_read(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract setup is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('installed',EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=app.current_tenant_id() AND company_id=p_company) AND 21=(SELECT count(*) FROM(
  SELECT id FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
  UNION SELECT template_id AS id FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND template_id BETWEEN 'c017ac70-0000-4000-8000-000000000101'::uuid AND 'c017ac70-0000-4000-8000-000000000104'::uuid
  UNION SELECT workflow_id AS id FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND workflow_id BETWEEN 'c017ac70-0000-4000-8000-000000000201'::uuid AND 'c017ac70-0000-4000-8000-000000000212'::uuid) definitions),
 'jobId',(SELECT id FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND kind='contract_setup' AND company_ids @> ARRAY[p_company] ORDER BY created_at DESC,id LIMIT 1),
 'canInstall',app.automation_can_manage('contract_staff','workflows') AND app.automation_can_manage('contract_staff','templates') AND app.contract_company_writable(p_company),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name') ORDER BY g->>'name',g->>'id') FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',routing_id,'name',name) ORDER BY name,routing_id) FROM(SELECT DISTINCT ON(routing_id) routing_id,name,retired FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC) latest WHERE NOT retired),'[]'::jsonb),
 'missing',CASE WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Create the real assignment groups in HR Automation first.') ELSE jsonb_build_array('Map populated People Ops and posting approver groups, and BP and CEO routings before installing the starting configuration.') END) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_read(uuid) TO ai_hr_app;
