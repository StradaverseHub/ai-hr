-- Existing seed identities are retained, including consultant edits. Only actual workflow/template administrators receive bounded manual-review metadata. No automatic repair or new provenance authority.
CREATE OR REPLACE FUNCTION app.contract_shared_setup_read(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_permitted('access',p_company) IS NOT TRUE THEN RAISE EXCEPTION 'Contract setup is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('v9Ready',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),'installed',EXISTS(SELECT 1 FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_settings WHERE tenant_id=app.current_tenant_id() AND company_id=p_company) AND 24=(SELECT count(*) FROM(
  SELECT id FROM public.automation_document_template WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
  UNION SELECT template_id AS id FROM public.automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND template_id BETWEEN 'c017ac70-0000-4000-8000-000000000101'::uuid AND 'c017ac70-0000-4000-8000-000000000107'::uuid
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
 IF result->'canInstall'='true'::jsonb THEN
  result:=result||jsonb_build_object('reviewNeeded',(
   WITH documents AS MATERIALIZED(
    SELECT 'document'::text kind,h.id,h.name FROM public.automation_document_template h LEFT JOIN public.automation_document_template_version v ON v.tenant_id=h.tenant_id AND v.template_id=h.id AND v.version=h.live_version
    WHERE h.tenant_id=app.current_tenant_id() AND h.module='contract_staff' AND h.id BETWEEN 'c017ac70-0000-4000-8000-000000000001'::uuid AND 'c017ac70-0000-4000-8000-000000000005'::uuid
    AND (h.deleted_at IS NOT NULL OR h.retired OR v.definition IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.definition->'blocks','[]'::jsonb)) block WHERE block->>'type'='letterhead'))),
   expected_email AS MATERIALIZED(SELECT * FROM(VALUES('c017ac70-0000-4000-8000-000000000103'::uuid,'c017ac70-0000-4000-8000-000000000003'::text),('c017ac70-0000-4000-8000-000000000104'::uuid,'c017ac70-0000-4000-8000-000000000005'::text),('c017ac70-0000-4000-8000-000000000107'::uuid,'c017ac70-0000-4000-8000-000000000004'::text)) ids(id,document)),
   email_latest AS MATERIALIZED(SELECT DISTINCT ON(v.template_id) v.template_id,v.name,v.document_ids,expected.document FROM public.automation_email_template_version v JOIN expected_email expected ON expected.id=v.template_id WHERE v.tenant_id=app.current_tenant_id() AND v.module='contract_staff' ORDER BY v.template_id,v.revision DESC),
   workflow_latest AS MATERIALIZED(SELECT definition,workflow_id FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' AND workflow_id='c017ac70-0000-4000-8000-000000000208'::uuid ORDER BY revision DESC LIMIT 1),
   review AS(SELECT * FROM documents UNION ALL SELECT 'email',template_id,name FROM email_latest WHERE document_ids IS DISTINCT FROM jsonb_build_array(document)
    UNION ALL SELECT 'workflow',workflow_id,definition->>'name' FROM workflow_latest WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'steps') step WHERE step->>'id'='released-letter-email' AND step->'params'->>'emailTemplateId'='c017ac70-0000-4000-8000-000000000107'))
   SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'name',name) ORDER BY kind,id),'[]'::jsonb) FROM review));
 ELSE result:=result||jsonb_build_object('reviewNeeded','[]'::jsonb);END IF;
 RETURN result;
END $$;
