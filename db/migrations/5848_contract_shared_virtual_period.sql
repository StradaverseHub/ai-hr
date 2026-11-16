-- Viewing a Personnel period is a read. It never fabricates a case, actor, task or workflow event.
CREATE FUNCTION app.contract_shared_period_context(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;source jsonb;rights text[];period text;existing uuid;old_period text;old_start text;old_end text;issue text;
BEGIN
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment;
 IF e.id IS NULL OR app.contract_shared_permitted('view',e.company_id,NULL,e.id) IS NOT TRUE
 OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 THEN RETURN NULL;END IF;
 source:=app.contract_source(e.id);
 IF source->>'employmentType' IS DISTINCT FROM 'contract' THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(permission),'{}'::text[]) INTO rights FROM unnest(ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[]) permission WHERE app.contract_shared_permitted(permission,e.company_id,NULL,e.id);
 period:=app.contract_shared_period_revision(e.id);
 source:=source||jsonb_build_object('contractNumber',e.contract_number,'periodRevision',period,'businessUnitId',source->>'businessGroupId','jobTitle',source->>'designation');
 source:=source||coalesce((SELECT jsonb_build_object('businessGroupId',bg.id,'businessGroup',bg.legal_name) FROM public.company c JOIN public.company bg ON bg.tenant_id=c.tenant_id AND bg.id=coalesce(c.parent_company_id,c.id) WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id),'{}'::jsonb);
 source:=source||coalesce((SELECT jsonb_build_object('departmentId',a.department_id) FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),'{}'::jsonb);
 IF NOT 'seePay'=ANY(rights) THEN source:=source-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];END IF;
 SELECT c.id,f.data->'period'->>'sourceRevision',c.data->'term'->>'startOn',c.data->'term'->>'endOn' INTO existing,old_period,old_start,old_end FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text
 OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')
 OR f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled'))
 ORDER BY (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text) DESC NULLS LAST,c.created_at DESC,c.id LIMIT 1;
 issue:=CASE WHEN e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date THEN 'verify_period'
  WHEN existing IS NOT NULL AND (old_start IS DISTINCT FROM e.contract_start_date::text OR old_end IS DISTINCT FROM e.contract_end_date::text OR old_period IS NOT NULL AND old_period IS DISTINCT FROM period) THEN 'period_changed' END;
 RETURN jsonb_build_object('employmentId',e.id,'companyId',e.company_id,'source',source,'permissions',to_jsonb(rights),'sourceRevision',period,'sourceIssue',issue,'existingCaseId',existing,'canOpen',existing IS NULL AND issue IS NULL AND 'decide'=ANY(rights));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_context(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Canonical groups alone do not initialize the native Contract/V9 projection.
CREATE OR REPLACE FUNCTION app.contract_shared_setup_read(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract setup is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('v9Ready',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),'installed',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=app.current_tenant_id() AND company_id=p_company) AND 21=(SELECT count(*) FROM(
  SELECT id FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
  UNION SELECT template_id AS id FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND template_id BETWEEN 'c017ac70-0000-4000-8000-000000000101'::uuid AND 'c017ac70-0000-4000-8000-000000000104'::uuid
  UNION SELECT workflow_id AS id FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND workflow_id BETWEEN 'c017ac70-0000-4000-8000-000000000201'::uuid AND 'c017ac70-0000-4000-8000-000000000212'::uuid) definitions),
 'jobId',(SELECT id FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND kind='contract_setup' AND company_ids @> ARRAY[p_company] ORDER BY created_at DESC,id LIMIT 1),
 'canInstall',app.automation_can_manage('contract_staff','workflows') AND app.automation_can_manage('contract_staff','templates') AND app.contract_company_writable(p_company),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name') ORDER BY g->>'name',g->>'id') FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',routing_id,'name',name) ORDER BY name,routing_id) FROM(SELECT DISTINCT ON(routing_id) routing_id,name,retired FROM public.automation_routing_version WHERE tenant_id=app.current_tenant_id() ORDER BY routing_id,revision DESC) latest WHERE NOT retired),'[]'::jsonb),
 'missing',CASE WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Contract group projection is not initialized. Ask an authorized On/Off Boarding administrator to complete native setup; shared groups are retained.') WHEN NOT EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(v.data->'groups') g WHERE v.tenant_id=app.current_tenant_id()) THEN jsonb_build_array('Create the real assignment groups in HR Automation first.') ELSE jsonb_build_array('Map populated People Ops and posting approver groups, and BP and CEO routings before installing the starting configuration.') END) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_setup_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_setup_read(uuid) TO ai_hr_app;
