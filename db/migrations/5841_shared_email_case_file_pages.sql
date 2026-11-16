-- Accepted event definitions expose required file slots even if the first email attempt rolled back its run.
CREATE INDEX shared_email_case_asset_lookup ON public.lc_v9_email_asset(tenant_id,automation_module,shared_subject_id,email_template_id,shared_slot_id,shared_source_revision,created_at DESC,id DESC) WHERE shared_subject_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_case_files_page(p_case uuid,p_limit integer,p_offset integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE THEN RAISE EXCEPTION 'Case email files are unavailable' USING ERRCODE='42501';END IF;
 IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid email file page' USING ERRCODE='22023';END IF;
 RETURN (WITH relevant AS MATERIALIZED(
 SELECT DISTINCT step->'params'->>'emailTemplateId' AS id FROM public.automation_run run JOIN public.automation_workflow_version workflow ON workflow.tenant_id=run.tenant_id AND workflow.workflow_id=run.workflow_id AND workflow.revision=run.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(workflow.definition->'steps') step WHERE run.tenant_id=app.current_tenant_id() AND run.subject_id=p_case AND run.module='contract_staff' AND step->>'type'='sendEmail'
 UNION SELECT DISTINCT step->'params'->>'emailTemplateId' FROM public.contract_shared_event event
 CROSS JOIN LATERAL jsonb_array_elements(event.workflow_versions) reference
 JOIN public.automation_workflow_version workflow ON workflow.tenant_id=event.tenant_id AND workflow.module='contract_staff' AND workflow.workflow_id::text=reference->>'workflowId' AND workflow.revision::text=reference->>'revision'
 CROSS JOIN LATERAL jsonb_array_elements(workflow.definition->'steps') step
 WHERE event.tenant_id=app.current_tenant_id() AND event.case_id=p_case AND step->>'type'='sendEmail'),
 latest AS MATERIALIZED(SELECT DISTINCT ON(v.template_id) v.* FROM public.automation_email_template_version v JOIN relevant ON relevant.id=v.template_id::text WHERE v.tenant_id=app.current_tenant_id() AND v.module='contract_staff' ORDER BY v.template_id,v.revision DESC),
 candidates AS MATERIALIZED(SELECT * FROM latest WHERE NOT retired AND jsonb_array_length(coalesce(file_slots,'[]'::jsonb))>0 ORDER BY name,template_id OFFSET p_offset LIMIT p_limit+1),
 templates AS MATERIALIZED(SELECT * FROM candidates ORDER BY name,template_id LIMIT p_limit)
 SELECT jsonb_build_object('hasMore',(SELECT count(*)>p_limit FROM candidates),'offset',p_offset,'limit',p_limit,'items',coalesce(jsonb_agg(jsonb_build_object('templateId',template_id,'templateName',name,'revision',revision,'slots',coalesce((SELECT jsonb_agg(slot||jsonb_build_object('file',(SELECT app.automation_email_asset_metadata(a) FROM public.lc_v9_email_asset a JOIN public.contract_shared_case f ON f.tenant_id=a.tenant_id AND f.case_id=a.shared_subject_id WHERE a.tenant_id=templates.tenant_id AND a.email_template_id=templates.template_id::text AND a.shared_subject_id=p_case AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=f.data->'period'->>'sourceRevision' ORDER BY a.created_at DESC,a.id DESC LIMIT 1)) ORDER BY slot->>'id') FROM jsonb_array_elements(coalesce(templates.file_slots,'[]'::jsonb)) slot),'[]'::jsonb)) ORDER BY name,template_id),'[]'::jsonb))
 FROM templates);
END $$;
REVOKE ALL ON FUNCTION app.automation_email_case_files_page(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_case_files_page(uuid,integer,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_case_files(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.automation_email_case_files_page(p_case,50,0)->'items'
$$;

--> statement-breakpoint
-- The outer selected-document value must not resolve to an inner UUID column.
CREATE OR REPLACE FUNCTION app.automation_email_template_save_full(p_template uuid, p_module text, p_name text, p_active boolean, p_subject text, p_body text, p_cc jsonb, p_retired boolean, p_expected integer, p_reason text,p_body_doc jsonb,p_assets jsonb,p_slots jsonb,p_documents jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_email_template_version; v_revision integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_template IS NULL OR NOT app.automation_can_manage(p_module,'templates') THEN RAISE EXCEPTION 'You cannot configure email templates for this module' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||t::text||':'||p_template::text, 0));
  SELECT * INTO prior FROM public.automation_email_template_version WHERE tenant_id = t AND template_id = p_template ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This email template changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.revision IS NOT NULL AND prior.module <> p_module THEN RAISE EXCEPTION 'An email template cannot move to another module' USING ERRCODE='22023'; END IF;
  IF prior.retired THEN RAISE EXCEPTION 'A retired email template cannot change' USING ERRCODE='22023'; END IF;
  IF p_active IS NULL OR p_retired IS NULL OR length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 200
     OR length(btrim(coalesce(p_subject, ''))) NOT BETWEEN 1 AND 500 OR p_body IS NULL OR length(p_body) > 20000
     OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Each type is checked in its own statement before a function that would fail on another type: SQL does not
  -- promise the order in which OR operands are evaluated.
  IF jsonb_typeof(p_cc) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_cc) > 20 OR pg_column_size(p_cc) > 16384 THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE jsonb_typeof(r) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Every element is now an object, so reading its kind cannot fail.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE coalesce(r->>'kind', '') NOT IN ('role','routing','group','person','pending'))
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF p_body_doc IS NOT NULL AND (jsonb_typeof(p_body_doc) IS DISTINCT FROM 'object' OR p_body_doc->>'type' IS DISTINCT FROM 'doc' OR octet_length(p_body_doc::text)>262144) THEN RAISE EXCEPTION 'Invalid email body' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(p_assets) IS DISTINCT FROM 'array' OR jsonb_typeof(p_slots) IS DISTINCT FROM 'array' OR jsonb_typeof(p_documents) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid email attachment settings' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(p_assets)>20 OR jsonb_array_length(p_slots)>50 OR jsonb_array_length(p_documents)>20 OR octet_length((p_assets||p_slots||p_documents)::text)>65536 THEN RAISE EXCEPTION 'Too many email attachments' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_assets) asset WHERE jsonb_typeof(asset) IS DISTINCT FROM 'object' OR NOT EXISTS(
   SELECT 1 FROM public.lc_v9_email_asset a WHERE a.tenant_id=t AND a.email_template_id=p_template::text AND a.automation_module=p_module AND a.shared_subject_id IS NULL
   AND a.id::text=asset->>'id' AND app.automation_email_asset_metadata(a)=(asset-'alt')) OR (asset ? 'alt' AND (jsonb_typeof(asset->'alt')<>'string' OR length(asset->>'alt')>300)))
   THEN RAISE EXCEPTION 'Choose the actual uploaded file receipt for this template' USING ERRCODE='22023';END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_assets) a WHERE a->>'kind'='image')>3 OR (SELECT coalesce(sum((a->>'size')::bigint),0) FROM jsonb_array_elements(p_assets) a)>20000000
   OR (SELECT count(DISTINCT a->>'id') FROM jsonb_array_elements(p_assets) a)<>jsonb_array_length(p_assets) THEN RAISE EXCEPTION 'Email files exceed the attachment limits' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_slots) slot WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object' OR (slot-ARRAY['id','label','required'])<>'{}'::jsonb OR coalesce(slot->>'id','')!~'^[0-9a-f-]{36}$'
   OR length(btrim(coalesce(slot->>'label',''))) NOT BETWEEN 1 AND 500 OR jsonb_typeof(slot->'required') IS DISTINCT FROM 'boolean')
   OR (SELECT count(DISTINCT slot->>'id') FROM jsonb_array_elements(p_slots) slot)<>jsonb_array_length(p_slots) THEN RAISE EXCEPTION 'Check the per-person file slots' USING ERRCODE='22023';END IF;
  IF p_module<>'contract_staff' AND (jsonb_array_length(p_slots)>0 OR jsonb_array_length(p_documents)>0) THEN RAISE EXCEPTION 'This module does not yet support case files or attached documents' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_documents) selected(value) WHERE NOT EXISTS(SELECT 1 FROM public.automation_document_template d WHERE d.tenant_id=t AND d.id::text=selected.value AND d.module=p_module AND NOT d.retired AND d.live_version IS NOT NULL))
   OR (SELECT count(DISTINCT selected.value) FROM jsonb_array_elements_text(p_documents) selected(value))<>jsonb_array_length(p_documents) THEN RAISE EXCEPTION 'Choose published documents from this module' USING ERRCODE='22023';END IF;
  v_revision := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_email_template_version (tenant_id, template_id, revision, module, name, active, subject, body, cc, retired, reason, saved_by,body_doc,assets,file_slots,document_ids)
  VALUES (t, p_template, v_revision, p_module, btrim(p_name), p_active, p_subject, p_body, p_cc, p_retired, btrim(p_reason), app.current_user_id(),p_body_doc,p_assets,p_slots,p_documents);
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_email_template', p_template,
    CASE WHEN v_revision = 1 THEN 'automation.email_template.created' WHEN p_retired THEN 'automation.email_template.retired' ELSE 'automation.email_template.saved' END,
    'user'::actor_type, app.current_user_id(),
    jsonb_build_object('module', p_module, 'revision', v_revision, 'active', p_active, 'previousActive', prior.active, 'retired', p_retired));
  RETURN v_revision;
END $$;

