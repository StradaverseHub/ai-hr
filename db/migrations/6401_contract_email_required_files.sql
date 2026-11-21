-- Required per-person files are proven from the immutable email pin and native asset receipts.
-- New helpers are private. The existing upload/read function OIDs and app grants remain unchanged.
CREATE INDEX contract_email_file_pin_case ON public.contract_shared_email_document_step(tenant_id,case_id,email_template_id,email_revision,source_period_revision,id);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_file_pin_valid(p_pin uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;run public.automation_run;flow jsonb;frozen_step jsonb;step_index integer;actual_company uuid;actual_person uuid;
BEGIN
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 IF pin.id IS NULL THEN RETURN false;END IF;
 SELECT f.data,c.company_id,e.person_id INTO flow,actual_company,actual_person
 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
 JOIN public.company company ON company.tenant_id=c.tenant_id AND company.id=c.company_id AND company.archived_at IS NULL
 JOIN public.person person ON person.tenant_id=e.tenant_id AND person.id=e.person_id
 WHERE f.tenant_id=pin.tenant_id AND f.case_id=pin.case_id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL;
 IF flow IS NULL OR actual_company IS DISTINCT FROM pin.company_id OR actual_person IS DISTINCT FROM pin.subject_person_id
 OR app.contract_company_entitled(pin.company_id) IS NOT TRUE THEN RETURN false;END IF;
 IF (CASE WHEN flow->'declined' IS NULL OR flow->'declined'='null'::jsonb THEN 'outcome' ELSE 'declined' END) IS DISTINCT FROM pin.phase THEN RETURN false;END IF;
 IF coalesce(flow->'decision'->>'revision','0')<>pin.decision_revision::text AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(flow->'decisionHistory')='array' THEN flow->'decisionHistory' ELSE '[]'::jsonb END) history WHERE history->>'revision'=pin.decision_revision::text
 ) THEN RETURN false;END IF;
 IF flow->'period'->>'sourceRevision' IS DISTINCT FROM pin.source_period_revision AND NOT EXISTS(
  SELECT 1 FROM public.contract_shared_case_revision history WHERE history.tenant_id=pin.tenant_id AND history.case_id=pin.case_id AND history.created_at<=pin.prepared_at
  AND history.data->'period'->>'sourceRevision'=pin.source_period_revision AND (coalesce(history.data->'decision'->>'revision','0')=pin.decision_revision::text OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(history.data->'decisionHistory')='array' THEN history.data->'decisionHistory' ELSE '[]'::jsonb END) decision WHERE decision->>'revision'=pin.decision_revision::text))
 ) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_email_template_version email WHERE email.tenant_id=pin.tenant_id AND email.template_id=pin.email_template_id AND email.revision=pin.email_revision AND email.module='contract_staff' AND email.active AND NOT email.retired) THEN RETURN false;END IF;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id AND subject_id=pin.case_id AND module='contract_staff' AND status IN('running','waiting');
 IF run.id IS NULL THEN RETURN false;END IF;
 SELECT (ordinality-1)::integer,step INTO step_index,frozen_step FROM public.automation_workflow_version version
 CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') WITH ORDINALITY steps(step,ordinality)
 WHERE version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision AND version.module='contract_staff'
 AND step->>'id'=pin.workflow_step_id AND step->>'type'='sendEmail' AND step->'params'->>'emailTemplateId'=pin.email_template_id::text LIMIT 1;
 IF frozen_step IS NULL THEN RETURN false;END IF;
 -- Return before effect_held: internal recovery's held proof itself reads this file proof.
 IF run.status='waiting' AND run.waiting_for::text=pin.id::text AND run.step_cursor=step_index
 AND run.remaining_steps->0->>'index'=step_index::text AND run.remaining_steps->0->'step'=frozen_step THEN RETURN true;END IF;
 -- Only a genuine original worker may prepare the first hold before its cursor is persisted.
 IF EXISTS(SELECT 1 FROM public.contract_shared_event event WHERE event.tenant_id=pin.tenant_id AND event.id::text=current_setting('app.contract_event',true) AND event.trigger_event='emailDocumentReady') THEN RETURN false;END IF;
 RETURN app.contract_shared_effect_held(pin.case_id,pin.workflow_run_id,pin.workflow_step_id,'sendEmail') IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_file_pin_valid(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_required_files_proof(p_pin uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;slots jsonb;assets jsonb;ready boolean;
BEGIN
 IF app.contract_shared_email_file_pin_valid(p_pin) IS NOT TRUE THEN RETURN jsonb_build_object('ready',false,'assets','[]'::jsonb);END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 SELECT coalesce(file_slots,'[]'::jsonb) INTO slots FROM public.automation_email_template_version WHERE tenant_id=pin.tenant_id AND template_id=pin.email_template_id AND revision=pin.email_revision;
 IF jsonb_typeof(slots) IS DISTINCT FROM 'array' OR jsonb_array_length(slots)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(slots) slot WHERE jsonb_typeof(slot) IS DISTINCT FROM 'object' OR coalesce(slot->>'id','')!~'^[0-9a-f-]{36}$' OR jsonb_typeof(slot->'required') IS DISTINCT FROM 'boolean')
 OR (SELECT count(DISTINCT slot->>'id') FROM jsonb_array_elements(slots) slot)<>jsonb_array_length(slots) THEN RETURN jsonb_build_object('ready',false,'assets','[]'::jsonb);END IF;
 SELECT coalesce(bool_and(CASE WHEN asset.id IS NULL THEN slot->'required'<>'true'::jsonb ELSE valid END),true),
 coalesce(jsonb_agg(app.automation_email_asset_metadata(asset) ORDER BY slot->>'id') FILTER(WHERE valid),'[]'::jsonb) INTO ready,assets
 FROM jsonb_array_elements(slots) slot LEFT JOIN LATERAL(
  SELECT a.* FROM public.lc_v9_email_asset a WHERE a.tenant_id=pin.tenant_id AND a.automation_module='contract_staff' AND a.email_template_id=pin.email_template_id::text
  AND a.kind='file' AND a.shared_subject_id=pin.case_id AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=pin.source_period_revision ORDER BY a.created_at DESC,a.id DESC LIMIT 1
 ) asset ON true LEFT JOIN public.app_user uploader ON uploader.tenant_id=asset.tenant_id AND uploader.id=asset.uploaded_by
 CROSS JOIN LATERAL(SELECT asset.id IS NOT NULL AND uploader.id IS NOT NULL AND asset.content_hash=encode(sha256(asset.content),'hex') AND octet_length(asset.content) BETWEEN 1 AND 10485760 AS valid) integrity;
 RETURN jsonb_build_object('ready',ready,'assets',assets);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_required_files_proof(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_required_files_ready(p_pin uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((app.contract_shared_email_required_files_proof(p_pin)->>'ready')::boolean,false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_required_files_ready(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_asset_upload(p_template uuid,p_module text,p_revision integer,p_kind text,p_name text,p_mime text,p_bytes bytea,p_case uuid DEFAULT NULL,p_slot text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();v public.automation_email_template_version;a public.lc_v9_email_asset;who text;period text;requested uuid;hint text:=nullif(current_setting('app.requested_contract_email_pin',true),'');pin public.contract_shared_email_document_step;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.current_user_id() IS NULL OR NOT app.contract_verified_human(app.current_user_id()) THEN RAISE EXCEPTION 'A verified signed-in person is required' USING ERRCODE='42501';END IF;
 IF p_case IS NULL AND app.automation_can_manage(p_module,'templates') IS NOT TRUE OR p_case IS NOT NULL AND (p_module<>'contract_staff' OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE) THEN RAISE EXCEPTION 'This email upload is unavailable' USING ERRCODE='42501';END IF;
 IF hint IS NOT NULL THEN
  IF p_case IS NULL OR p_module<>'contract_staff' OR p_kind<>'file' OR coalesce(hint,'')!~'^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'This pending email selection is unavailable' USING ERRCODE='42501';END IF;
  requested:=hint::uuid;
  PERFORM app.contract_shared_lock_source(p_case);
  SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=t AND id=requested AND case_id=p_case AND email_template_id=p_template AND email_revision=p_revision;
  IF pin.id IS NULL OR app.contract_shared_email_file_pin_valid(requested) IS NOT TRUE THEN RAISE EXCEPTION 'This pending email selection is unavailable' USING ERRCODE='42501';END IF;
  PERFORM app.contract_shared_email_prerequisite_lock(requested);
  IF app.contract_shared_email_file_pin_valid(requested) IS NOT TRUE THEN RAISE EXCEPTION 'This email is no longer waiting here. Reload the case' USING ERRCODE='40001';END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||t::text||':'||p_template::text,0));
 IF requested IS NULL THEN
 SELECT * INTO v FROM public.automation_email_template_version WHERE tenant_id=t AND template_id=p_template ORDER BY revision DESC LIMIT 1;
 ELSE SELECT * INTO v FROM public.automation_email_template_version WHERE tenant_id=t AND template_id=p_template AND revision=pin.email_revision;END IF;
 IF v.revision IS DISTINCT FROM p_revision OR v.module IS DISTINCT FROM p_module OR v.retired THEN RAISE EXCEPTION 'The email template changed. Save and reload before uploading' USING ERRCODE='40001';END IF;
 IF p_kind NOT IN('file','image') OR length(p_name) NOT BETWEEN 1 AND 180 OR p_name~'[[:cntrl:]/\\:]' OR octet_length(p_bytes) NOT BETWEEN 1 AND (CASE WHEN p_kind='image' THEN 1048576 ELSE 10485760 END) THEN RAISE EXCEPTION 'Choose a supported file within the upload limit' USING ERRCODE='22023';END IF;
 IF p_case IS NOT NULL THEN
  IF p_kind<>'file' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.file_slots,'[]'::jsonb)) slot WHERE slot->>'id'=p_slot) THEN RAISE EXCEPTION 'Choose a file slot from this email template' USING ERRCODE='22023';END IF;
  IF requested IS NULL THEN
  SELECT data->'period'->>'sourceRevision' INTO period FROM public.contract_shared_case WHERE tenant_id=t AND case_id=p_case;
  IF period IS NULL OR period IS DISTINCT FROM (SELECT app.contract_shared_period_revision(c.employment_id) FROM public.contract_case c WHERE c.tenant_id=t AND c.id=p_case) THEN RAISE EXCEPTION 'Reconcile the changed Personnel period before uploading' USING ERRCODE='40001';END IF;
  ELSE period:=pin.source_period_revision;END IF;
 ELSIF p_slot IS NOT NULL THEN RAISE EXCEPTION 'A file slot requires its actual case' USING ERRCODE='22023';END IF;
 SELECT p.full_name INTO who FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id WHERE u.tenant_id=t AND u.id=app.current_user_id();
 SELECT * INTO a FROM public.lc_v9_email_asset WHERE tenant_id=t AND email_template_id=p_template::text AND automation_module=p_module AND kind=p_kind
 AND filename=p_name AND content_hash=encode(sha256(p_bytes),'hex') AND shared_subject_id IS NOT DISTINCT FROM p_case AND shared_slot_id IS NOT DISTINCT FROM p_slot AND shared_source_revision IS NOT DISTINCT FROM period ORDER BY created_at,id LIMIT 1;
 IF a.id IS NULL THEN
  INSERT INTO public.lc_v9_email_asset(tenant_id,email_template_id,kind,filename,mime_type,content,uploaded_by,uploaded_by_name,automation_module,shared_subject_id,shared_slot_id,shared_source_revision)
  VALUES(t,p_template::text,p_kind,p_name,p_mime,p_bytes,app.current_user_id(),who,p_module,p_case,p_slot,period) RETURNING * INTO a;
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(t,'automation-email-asset',a.id,'automation.emailAssetUploaded','user',app.current_user_id(),jsonb_build_object('module',p_module,'templateId',p_template,'caseId',p_case,'slotId',p_slot,'bytes',octet_length(p_bytes),'contentHash',a.content_hash));
 END IF;
 IF p_case IS NOT NULL THEN
  PERFORM app.contract_shared_email_prerequisite_observe_upload(a.id);
  IF requested IS NOT NULL THEN PERFORM app.contract_shared_email_prerequisite_signal(requested);END IF;
 END IF;
 RETURN app.automation_email_asset_metadata(a);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_v9_email_asset_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE hint text:=nullif(current_setting('app.requested_contract_email_pin',true),'');requested uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.app_user u LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=NEW.uploaded_by AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND coalesce(p.full_name,'User')=NEW.uploaded_by_name) THEN RAISE EXCEPTION 'Email file needs its actual uploader';END IF;
 IF NEW.automation_module IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(c.data->'emails') e
   WHERE c.tenant_id=NEW.tenant_id AND e->>'id'=NEW.email_template_id) THEN RAISE EXCEPTION 'Email asset must belong to its actual template';END IF;
 ELSE
  IF NEW.shared_subject_id IS NULL AND app.automation_can_manage(NEW.automation_module,'templates') IS NOT TRUE
   OR NEW.shared_subject_id IS NOT NULL AND (NEW.automation_module<>'contract_staff' OR app.contract_shared_case_permitted(NEW.shared_subject_id,'view') IS NOT TRUE OR app.contract_shared_case_permitted(NEW.shared_subject_id,'manual') IS NOT TRUE)
   THEN RAISE EXCEPTION 'The actual actor cannot attach a file here' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.automation_email_template_version v WHERE v.tenant_id=NEW.tenant_id AND v.template_id::text=NEW.email_template_id
   AND v.module=NEW.automation_module) THEN RAISE EXCEPTION 'Shared email file needs its actual template';END IF;
  IF NEW.shared_subject_id IS NOT NULL AND hint IS NOT NULL THEN
   IF hint!~'^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'This pending email selection is unavailable' USING ERRCODE='42501';END IF;
   requested:=hint::uuid;
   IF app.contract_shared_email_file_pin_valid(requested) IS NOT TRUE OR NOT EXISTS(
    SELECT 1 FROM public.contract_shared_email_document_step pin JOIN public.automation_email_template_version version ON version.tenant_id=pin.tenant_id AND version.template_id=pin.email_template_id AND version.revision=pin.email_revision
    WHERE pin.tenant_id=NEW.tenant_id AND pin.tenant_id=app.current_tenant_id() AND pin.id=requested AND pin.case_id=NEW.shared_subject_id AND pin.email_template_id::text=NEW.email_template_id
    AND pin.source_period_revision=NEW.shared_source_revision AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(version.file_slots,'[]'::jsonb)) slot WHERE slot->>'id'=NEW.shared_slot_id)
   ) THEN RAISE EXCEPTION 'This file does not belong to the actual pending email' USING ERRCODE='42501';END IF;
  END IF;
  IF NEW.shared_subject_id IS NOT NULL AND requested IS NULL AND NOT EXISTS(SELECT 1 FROM public.contract_shared_case f
   WHERE f.tenant_id=NEW.tenant_id AND f.case_id=NEW.shared_subject_id AND f.data->'period'->>'sourceRevision'=NEW.shared_source_revision)
   THEN RAISE EXCEPTION 'The Contract period no longer matches this file';END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Preserve the existing bounded page API while exposing each actual waiting version/source separately.
CREATE OR REPLACE FUNCTION app.automation_email_case_files_page(p_case uuid,p_limit integer,p_offset integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
 pending AS MATERIALIZED(
 SELECT v.tenant_id,v.template_id,v.revision,v.name,v.file_slots,pin.id AS prerequisite_id,pin.source_period_revision,pin.prepared_at
 FROM public.contract_shared_email_document_step pin JOIN public.automation_email_template_version v ON v.tenant_id=pin.tenant_id AND v.template_id=pin.email_template_id AND v.revision=pin.email_revision AND v.module='contract_staff'
 WHERE pin.tenant_id=app.current_tenant_id() AND pin.case_id=p_case AND jsonb_array_length(coalesce(v.file_slots,'[]'::jsonb))>0 AND app.contract_shared_email_file_pin_valid(pin.id)),
 choices AS MATERIALIZED(
 SELECT * FROM pending
 UNION ALL
 SELECT latest.tenant_id,latest.template_id,latest.revision,latest.name,latest.file_slots,NULL::uuid,f.data->'period'->>'sourceRevision',NULL::timestamptz
 FROM latest JOIN public.contract_shared_case f ON f.tenant_id=latest.tenant_id AND f.case_id=p_case
 WHERE NOT latest.retired AND jsonb_array_length(coalesce(latest.file_slots,'[]'::jsonb))>0
 AND NOT EXISTS(SELECT 1 FROM pending WHERE pending.template_id=latest.template_id AND pending.revision=latest.revision AND pending.source_period_revision=f.data->'period'->>'sourceRevision')),
 candidates AS MATERIALIZED(SELECT * FROM choices ORDER BY name,template_id,revision,prepared_at NULLS LAST,prerequisite_id NULLS LAST OFFSET p_offset LIMIT p_limit+1),
 templates AS MATERIALIZED(SELECT * FROM candidates ORDER BY name,template_id,revision,prepared_at NULLS LAST,prerequisite_id NULLS LAST LIMIT p_limit)
 SELECT jsonb_build_object('hasMore',(SELECT count(*)>p_limit FROM candidates),'offset',p_offset,'limit',p_limit,'items',coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
 'templateId',template_id,'templateName',name,'revision',revision,'prerequisiteId',prerequisite_id,'sourcePeriodRevision',source_period_revision,'preparedAt',prepared_at))||jsonb_build_object(
 'slots',coalesce((SELECT jsonb_agg(slot||jsonb_build_object('file',(
 SELECT app.automation_email_asset_metadata(a) FROM public.lc_v9_email_asset a WHERE a.tenant_id=templates.tenant_id AND a.automation_module='contract_staff' AND a.kind='file'
 AND a.email_template_id=templates.template_id::text AND a.shared_subject_id=p_case AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=templates.source_period_revision
 ORDER BY a.created_at DESC,a.id DESC LIMIT 1)) ORDER BY slot->>'id') FROM jsonb_array_elements(coalesce(templates.file_slots,'[]'::jsonb)) slot),'[]'::jsonb))
 ORDER BY name,template_id,revision,prepared_at NULLS LAST,prerequisite_id NULLS LAST),'[]'::jsonb)) FROM templates);
END $$;
