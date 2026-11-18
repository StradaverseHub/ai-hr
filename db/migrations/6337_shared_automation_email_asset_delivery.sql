-- Freeze native attachment receipts before the durable row becomes immutable. There is no payload rewrite.
CREATE FUNCTION app.automation_email_delivery_assets() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb;v public.automation_email_template_version;context jsonb;receipts jsonb;files jsonb;documents jsonb;
BEGIN
 ref:=NEW.payload->'mail'->'richBody'->'sourceTemplate';
 IF ref IS NULL OR ref='null'::jsonb THEN RETURN NEW;END IF;
 IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref-ARRAY['id','revision']<>'{}'::jsonb OR coalesce(ref->>'id','')!~'^[0-9a-f-]{36}$' OR coalesce(ref->>'revision','')!~'^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'Invalid email source revision' USING ERRCODE='22023';END IF;
 SELECT * INTO v FROM public.automation_email_template_version WHERE tenant_id=NEW.tenant_id AND template_id::text=ref->>'id' AND revision=(ref->>'revision')::integer AND module=NEW.module;
 IF v.template_id IS NULL OR v.retired OR NOT v.active OR v.body_doc IS NOT NULL AND v.body_doc IS DISTINCT FROM NEW.payload->'mail'->'richBody'->'doc' THEN RAISE EXCEPTION 'The queued email source does not match its published revision' USING ERRCODE='22023';END IF;
 IF NEW.payload->'context'->>'kind'='templateTest' THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.payload->'mail'->'to' IS DISTINCT FROM jsonb_build_array(app.current_user_id()) OR NEW.payload->'mail'->'cc'<>'[]'::jsonb
   OR app.automation_can_manage(NEW.module,'templates') IS NOT TRUE OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RAISE EXCEPTION 'Template tests can only email their actual author' USING ERRCODE='42501';END IF;
 ELSIF NEW.module='contract_staff' THEN
  context:=app.contract_shared_mail_context(NEW.subject_id,regexp_replace(NEW.mail_key,':[0-9]+$',''));
  IF NOT EXISTS(SELECT 1 FROM public.automation_run run JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
   CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') step WHERE run.tenant_id=NEW.tenant_id AND run.subject_id=NEW.subject_id AND run.module=NEW.module
   AND regexp_replace(NEW.mail_key,':[0-9]+$','')=run.id::text||':'||(step->>'id') AND step->>'type'='sendEmail' AND step->'params'->>'emailTemplateId'=v.template_id::text)
   THEN RAISE EXCEPTION 'The accepted workflow step names another email template' USING ERRCODE='42501';END IF;
 ELSIF jsonb_array_length(coalesce(v.file_slots,'[]'::jsonb))>0 OR jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb))>0 THEN RAISE EXCEPTION 'This module has no attached case documents' USING ERRCODE='22023';END IF;
 receipts:=coalesce(v.assets,'[]'::jsonb);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(receipts) receipt WHERE NOT EXISTS(SELECT 1 FROM public.lc_v9_email_asset a
 WHERE a.tenant_id=NEW.tenant_id AND a.email_template_id=v.template_id::text AND a.automation_module=v.module AND a.shared_subject_id IS NULL
 AND a.id::text=receipt->>'id' AND app.automation_email_asset_metadata(a)=(receipt-'alt'))) THEN RAISE EXCEPTION 'An email file no longer matches its immutable receipt' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(app.automation_email_asset_metadata(a) ORDER BY slot->>'id'),'[]'::jsonb) INTO files
 FROM jsonb_array_elements(CASE WHEN NEW.payload->'context'->>'kind'='templateTest' THEN '[]'::jsonb ELSE coalesce(v.file_slots,'[]'::jsonb) END) slot JOIN LATERAL(
  SELECT a.* FROM public.lc_v9_email_asset a WHERE a.tenant_id=NEW.tenant_id AND a.automation_module=v.module AND a.email_template_id=v.template_id::text
  AND a.shared_subject_id=NEW.subject_id AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=context->>'periodRevision' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) a ON true;
 IF NEW.payload->'context'->>'kind' IS DISTINCT FROM 'templateTest' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.file_slots,'[]'::jsonb)) slot WHERE slot->'required'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM public.lc_v9_email_asset a
 WHERE a.tenant_id=NEW.tenant_id AND a.automation_module=v.module AND a.email_template_id=v.template_id::text AND a.shared_subject_id=NEW.subject_id AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=context->>'periodRevision'))
 THEN RAISE EXCEPTION 'Upload the required file for this person before continuing the email' USING ERRCODE='22023';END IF;
 receipts:=receipts||files;
 IF jsonb_array_length(receipts)>20 OR (SELECT coalesce(sum((receipt->>'size')::bigint),0) FROM jsonb_array_elements(receipts) receipt)>20000000 THEN RAISE EXCEPTION 'Keep attached files and inline images within 20 files and 20 MB' USING ERRCODE='22023';END IF;
 -- Each selected document belongs to this actual case, decision and accepted email step. The canonical document owner creates it.
 SELECT coalesce(jsonb_agg(jsonb_build_object('templateId',id,'id',letter.id,'name',letter.data->'definition'->>'name','contentRevision',letter.data->'contentRevision',
 'snapshot',app.contract_shared_letter_snapshot(letter.id)) ORDER BY id),'[]'::jsonb) INTO documents
 FROM jsonb_array_elements_text(CASE WHEN NEW.payload->'context'->>'kind'='templateTest' THEN '[]'::jsonb ELSE coalesce(v.document_ids,'[]'::jsonb) END) id JOIN LATERAL(
  SELECT letter.* FROM public.contract_shared_letter letter WHERE letter.tenant_id=NEW.tenant_id AND letter.case_id=NEW.subject_id AND letter.decision_revision=(context->>'decisionRevision')::integer
  AND letter.data->>'templateId'=id AND letter.purpose='email' AND regexp_replace(NEW.mail_key,':[0-9]+$','')=letter.workflow_run_id::text||':'||letter.workflow_step_id
  AND letter.data->>'state' NOT IN('withdrawn','superseded') ORDER BY letter.updated_at DESC,letter.id LIMIT 1) letter ON true;
 IF NEW.payload->'context'->>'kind' IS DISTINCT FROM 'templateTest' AND jsonb_array_length(documents)<>jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb)) THEN RAISE EXCEPTION 'Generate the selected case documents before continuing this email' USING ERRCODE='22023';END IF;
 NEW.payload:=jsonb_set(NEW.payload,'{mail}',(NEW.payload->'mail')||jsonb_build_object('templateId',v.template_id,'templateRevision',v.revision));
 NEW.payload:=jsonb_set(NEW.payload,'{mail,delivery}',(NEW.payload->'mail'->'delivery')||jsonb_build_object('assets',receipts,'documents',documents));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.automation_email_delivery_assets() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER automation_email_delivery_assets BEFORE INSERT ON public.automation_email_delivery FOR EACH ROW EXECUTE FUNCTION app.automation_email_delivery_assets();
--> statement-breakpoint
CREATE FUNCTION app.automation_email_queue_rich(p_module text,p_subject uuid,p_key text,p_to uuid[],p_cc uuid[],p_subject_line text,p_body text,p_rich_body jsonb,p_template_ref jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_template_ref IS NULL THEN RETURN app.automation_email_queue_rich(p_module,p_subject,p_key,p_to,p_cc,p_subject_line,p_body,p_rich_body);END IF;
 IF p_rich_body IS NULL OR jsonb_typeof(p_rich_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'A template email needs its frozen rich source' USING ERRCODE='22023';END IF;
 RETURN app.automation_email_queue_rich(p_module,p_subject,p_key,p_to,p_cc,p_subject_line,p_body,p_rich_body||jsonb_build_object('sourceTemplate',p_template_ref));
END $$;
REVOKE ALL ON FUNCTION app.automation_email_queue_rich(text,uuid,text,uuid[],uuid[],text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_queue_rich(text,uuid,text,uuid[],uuid[],text,text,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_assets(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,kind text,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);
 IF target IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT a.id,a.kind,a.filename,a.mime_type,encode(a.content,'base64'),a.content_hash
 FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb)) receipt JOIN public.lc_v9_email_asset a
 ON a.id::text=receipt->>'id' AND a.tenant_id=(target->>'tenantId')::uuid AND a.automation_module=target->>'module'
 AND a.email_template_id=target->'payload'->'mail'->>'templateId' AND app.automation_email_asset_metadata(a)=(receipt-'alt')
 AND (a.shared_subject_id IS NULL OR a.shared_subject_id::text=target->>'subjectId' AND a.shared_source_revision=target->'payload'->'context'->>'periodRevision');
END $$;
REVOKE ALL ON FUNCTION app.automation_email_assets(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_assets(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_case_files(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'manual') IS NOT TRUE THEN RAISE EXCEPTION 'Case email files are unavailable' USING ERRCODE='42501';END IF;
 RETURN coalesce((WITH relevant AS MATERIALIZED(
 SELECT DISTINCT step->'params'->>'emailTemplateId' AS id FROM public.automation_run run JOIN public.automation_workflow_version workflow ON workflow.tenant_id=run.tenant_id AND workflow.workflow_id=run.workflow_id AND workflow.revision=run.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(workflow.definition->'steps') step WHERE run.tenant_id=app.current_tenant_id() AND run.subject_id=p_case AND run.module='contract_staff' AND step->>'type'='sendEmail'),
 templates AS MATERIALIZED(SELECT DISTINCT ON(v.template_id) v.* FROM public.automation_email_template_version v JOIN relevant ON relevant.id=v.template_id::text WHERE v.tenant_id=app.current_tenant_id() AND v.module='contract_staff' ORDER BY v.template_id,v.revision DESC)
 SELECT jsonb_agg(jsonb_build_object('templateId',template_id,'templateName',name,'revision',revision,'slots',coalesce((SELECT jsonb_agg(slot||jsonb_build_object('file',(SELECT app.automation_email_asset_metadata(a) FROM public.lc_v9_email_asset a JOIN public.contract_shared_case f ON f.tenant_id=a.tenant_id AND f.case_id=a.shared_subject_id WHERE a.tenant_id=templates.tenant_id AND a.email_template_id=templates.template_id::text AND a.shared_subject_id=p_case AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=f.data->'period'->>'sourceRevision' ORDER BY a.created_at DESC,a.id DESC LIMIT 1)) ORDER BY slot->>'id') FROM jsonb_array_elements(coalesce(templates.file_slots,'[]'::jsonb)) slot),'[]'::jsonb)) ORDER BY name,template_id)
 FROM templates WHERE NOT retired AND jsonb_array_length(coalesce(file_slots,'[]'::jsonb))>0),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.automation_email_case_files(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_case_files(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_document_recipient(p_tenant uuid,p_letter uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter letter
 JOIN public.contract_case c ON c.tenant_id=letter.tenant_id AND c.id=letter.case_id
 JOIN public.contract_shared_case flow ON flow.tenant_id=c.tenant_id AND flow.case_id=c.id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
 JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id=p_user
 JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
 WHERE letter.tenant_id=p_tenant AND letter.id=p_letter AND letter.purpose='email' AND account.archived_at IS NULL
 AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0 AND employment.person_id::text=letter.data->>'subjectPersonId'
 AND (flow.data->'decision'->>'revision'=letter.decision_revision::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(flow.data->'decisionHistory') decision WHERE decision->>'revision'=letter.decision_revision::text))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step WHERE step->>'holderId'=account.id::text AND step->>'holderPersonId'=account.person_id::text))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_recipient(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_documents(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;docs jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);
 IF target IS NULL THEN RETURN NULL;END IF;
 docs:=coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(docs) doc CROSS JOIN LATERAL jsonb_array_elements_text((target->'payload'->'mail'->'to')||(target->'payload'->'mail'->'cc')) recipient
 WHERE app.contract_shared_email_document_recipient((target->>'tenantId')::uuid,(doc->>'id')::uuid,recipient::uuid) IS NOT TRUE) THEN RETURN NULL;END IF;
 RETURN docs;
END $$;
REVOKE ALL ON FUNCTION app.automation_email_documents(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_documents(uuid,uuid,text) TO ai_hr_app;
