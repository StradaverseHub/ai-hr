-- Shared builders use the existing immutable native email file store. Legacy V9 rows retain NULL discriminators.
ALTER TABLE public.lc_v9_email_asset ADD COLUMN automation_module text CHECK(automation_module IS NULL OR automation_module IN('contract_staff','probation'));
ALTER TABLE public.lc_v9_email_asset ADD COLUMN shared_subject_id uuid;
ALTER TABLE public.lc_v9_email_asset ADD COLUMN shared_slot_id text;
ALTER TABLE public.lc_v9_email_asset ADD COLUMN shared_source_revision text;
ALTER TABLE public.lc_v9_email_asset ADD CONSTRAINT shared_email_asset_subject CHECK(
 (shared_subject_id IS NULL AND shared_slot_id IS NULL AND shared_source_revision IS NULL)
 OR (automation_module='contract_staff' AND kind='file' AND shared_subject_id IS NOT NULL AND shared_slot_id IS NOT NULL AND shared_source_revision IS NOT NULL));
ALTER TABLE public.automation_email_template_version ADD COLUMN assets jsonb CHECK(assets IS NULL OR jsonb_typeof(assets)='array');
ALTER TABLE public.automation_email_template_version ADD COLUMN file_slots jsonb CHECK(file_slots IS NULL OR jsonb_typeof(file_slots)='array');
ALTER TABLE public.automation_email_template_version ADD COLUMN document_ids jsonb CHECK(document_ids IS NULL OR jsonb_typeof(document_ids)='array');
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_metadata(p_asset public.lc_v9_email_asset) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p_asset.id,'kind',p_asset.kind,'name',p_asset.filename,'mimeType',p_asset.mime_type,
 'size',octet_length(p_asset.content),'contentHash',p_asset.content_hash,'at',to_char(p_asset.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'by',p_asset.uploaded_by_name)
$$;
REVOKE ALL ON FUNCTION app.automation_email_asset_metadata(public.lc_v9_email_asset) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_v9_email_asset_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
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
  IF NEW.shared_subject_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contract_shared_case f
   WHERE f.tenant_id=NEW.tenant_id AND f.case_id=NEW.shared_subject_id AND f.data->'period'->>'sourceRevision'=NEW.shared_source_revision)
   THEN RAISE EXCEPTION 'The Contract period no longer matches this file';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_upload(p_template uuid,p_module text,p_revision integer,p_kind text,p_name text,p_mime text,p_bytes bytea,p_case uuid DEFAULT NULL,p_slot text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();v public.automation_email_template_version;a public.lc_v9_email_asset;who text;period text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.current_user_id() IS NULL OR NOT app.contract_verified_human(app.current_user_id()) THEN RAISE EXCEPTION 'A verified signed-in person is required' USING ERRCODE='42501';END IF;
 IF p_case IS NULL AND app.automation_can_manage(p_module,'templates') IS NOT TRUE OR p_case IS NOT NULL AND (p_module<>'contract_staff' OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE) THEN RAISE EXCEPTION 'This email upload is unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||t::text||':'||p_template::text,0));
 SELECT * INTO v FROM public.automation_email_template_version WHERE tenant_id=t AND template_id=p_template ORDER BY revision DESC LIMIT 1;
 IF v.revision IS DISTINCT FROM p_revision OR v.module IS DISTINCT FROM p_module OR v.retired THEN RAISE EXCEPTION 'The email template changed. Save and reload before uploading' USING ERRCODE='40001';END IF;
 IF p_kind NOT IN('file','image') OR length(p_name) NOT BETWEEN 1 AND 180 OR p_name~'[[:cntrl:]/\\:]' OR octet_length(p_bytes) NOT BETWEEN 1 AND CASE WHEN p_kind='image' THEN 1048576 ELSE 10485760 END THEN RAISE EXCEPTION 'Choose a supported file within the upload limit' USING ERRCODE='22023';END IF;
 IF p_case IS NOT NULL THEN
  IF p_kind<>'file' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.file_slots,'[]'::jsonb)) slot WHERE slot->>'id'=p_slot) THEN RAISE EXCEPTION 'Choose a file slot from this email template' USING ERRCODE='22023';END IF;
  SELECT data->'period'->>'sourceRevision' INTO period FROM public.contract_shared_case WHERE tenant_id=t AND case_id=p_case;
  IF period IS NULL OR period IS DISTINCT FROM (SELECT app.contract_shared_period_revision(c.employment_id) FROM public.contract_case c WHERE c.tenant_id=t AND c.id=p_case) THEN RAISE EXCEPTION 'Reconcile the changed Personnel period before uploading' USING ERRCODE='40001';END IF;
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
 RETURN app.automation_email_asset_metadata(a);
END $$;
REVOKE ALL ON FUNCTION app.automation_email_asset_upload(uuid,text,integer,text,text,text,bytea,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_asset_upload(uuid,text,integer,text,text,text,bytea,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_read(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.lc_v9_email_asset;
BEGIN
 SELECT * INTO a FROM public.lc_v9_email_asset WHERE id=p_id AND tenant_id=app.current_tenant_id() AND automation_module IS NOT NULL;
 IF a.id IS NULL OR app.current_user_id() IS NULL OR (a.shared_subject_id IS NULL AND app.automation_can_manage(a.automation_module,'templates') IS NOT TRUE)
 OR (a.shared_subject_id IS NOT NULL AND app.contract_shared_case_permitted(a.shared_subject_id,'view') IS NOT TRUE) THEN RETURN NULL;END IF;
 RETURN app.automation_email_asset_metadata(a)||jsonb_build_object('bytes',encode(a.content,'base64'));
END $$;
REVOKE ALL ON FUNCTION app.automation_email_asset_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_asset_read(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.automation_email_template_save_full(p_template uuid, p_module text, p_name text, p_active boolean, p_subject text, p_body text, p_cc jsonb, p_retired boolean, p_expected integer, p_reason text,p_body_doc jsonb,p_assets jsonb,p_slots jsonb,p_documents jsonb)
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
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_documents) id WHERE NOT EXISTS(SELECT 1 FROM public.automation_document_template d WHERE d.tenant_id=t AND d.id::text=id AND d.module=p_module AND NOT d.retired AND d.live_version IS NOT NULL))
   OR (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(p_documents) id)<>jsonb_array_length(p_documents) THEN RAISE EXCEPTION 'Choose published documents from this module' USING ERRCODE='22023';END IF;
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

REVOKE ALL ON FUNCTION app.automation_email_template_save_full(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_template_save_full(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb,jsonb,jsonb,jsonb) TO ai_hr_app;
