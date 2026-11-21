-- A case reader is not a template-file disclosure capability. Only the deterministic runtime admits an asset email.
-- Legacy V9 policies retain their legacy rows. Shared rows cross only the narrow native purpose functions.
ALTER POLICY lc_v9_email_asset_read ON public.lc_v9_email_asset USING(automation_module IS NULL AND tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND (app.is_admin() OR app.is_group_admin()));
ALTER POLICY lc_v9_email_asset_insert ON public.lc_v9_email_asset WITH CHECK(automation_module IS NULL AND tenant_id=app.current_tenant_id() AND app.is_group_admin() AND uploaded_by=app.current_user_id());
ALTER TABLE public.lc_v9_email_asset DROP CONSTRAINT shared_email_asset_subject;
ALTER TABLE public.lc_v9_email_asset ADD CONSTRAINT shared_email_asset_subject CHECK(
 (shared_subject_id IS NULL AND shared_slot_id IS NULL AND shared_source_revision IS NULL)
 OR (automation_module IS NOT DISTINCT FROM 'contract_staff' AND kind='file' AND shared_subject_id IS NOT NULL AND shared_slot_id IS NOT NULL AND shared_source_revision IS NOT NULL));
--> statement-breakpoint
CREATE TABLE app.automation_email_asset_verifier(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),secret bytea NOT NULL CHECK(octet_length(secret)=32));
ALTER TABLE app.automation_email_asset_verifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.automation_email_asset_verifier FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_email_asset_verifier_owner ON app.automation_email_asset_verifier FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.automation_email_asset_verifier FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_runtime_ready() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.automation_email_asset_verifier WHERE singleton)
$$;
REVOKE ALL ON FUNCTION app.automation_email_asset_runtime_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_asset_runtime_ready() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_delivery_proof(p_delivery public.automation_email_delivery) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof jsonb:=p_delivery.payload->'mail'->'richBody'->'sourceProof';p jsonb;secret bytea;expected bytea;received bytea;difference integer:=0;i integer;
 n numeric:=extract(epoch FROM clock_timestamp())*1000;digest text;mail jsonb:=p_delivery.payload->'mail';source_key text:=regexp_replace(p_delivery.mail_key,':[0-9]+$','');
BEGIN
 IF proof IS NULL OR jsonb_typeof(proof) IS DISTINCT FROM 'object' OR length(coalesce(proof->>'payload','')) NOT BETWEEN 1 AND 32768 OR coalesce(proof->>'signature','')!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 SELECT v.secret INTO secret FROM app.automation_email_asset_verifier v WHERE singleton;
 IF secret IS NULL THEN RETURN false;END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to(proof->>'payload','UTF8'),secret);received:=decode(proof->>'signature','hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RETURN false;END IF;
 BEGIN p:=(proof->>'payload')::jsonb;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'purpose' IS DISTINCT FROM 'aihr-shared-email-assets-runtime-v1' OR p->>'module' IS DISTINCT FROM 'probation'
 OR p_delivery.module<>'probation' OR p->>'tenantId' IS DISTINCT FROM p_delivery.tenant_id::text OR p_delivery.tenant_id IS DISTINCT FROM app.current_tenant_id()
 OR p->>'subjectId' IS DISTINCT FROM p_delivery.subject_id::text OR p->>'key' IS DISTINCT FROM source_key OR p->>'transactionId' IS DISTINCT FROM txid_current()::text
 OR p->>'userId' IS DISTINCT FROM app.current_user_id()::text OR p_delivery.created_by IS DISTINCT FROM app.current_user_id()
 OR app.automation_can_run('probation',p_delivery.subject_id) IS NOT TRUE THEN RETURN false;END IF;
 IF app.current_user_id() IS NULL THEN IF app.probation_storage_runner() IS NOT TRUE OR p->>'personId' IS NOT NULL THEN RETURN false;END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=p_delivery.tenant_id AND u.id=app.current_user_id() AND u.person_id::text IS NOT DISTINCT FROM p->>'personId' AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN false;END IF;
 IF jsonb_typeof(p->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'expiresAt') IS DISTINCT FROM 'number' OR coalesce(p->>'issuedAt','')!~'^[0-9]{1,16}$' OR coalesce(p->>'expiresAt','')!~'^[0-9]{1,16}$' THEN RETURN false;END IF;
 IF (p->>'issuedAt')::numeric>n OR (p->>'expiresAt')::numeric<=n OR (p->>'expiresAt')::numeric-(p->>'issuedAt')::numeric NOT BETWEEN 1 AND 60000 THEN RETURN false;END IF;
 IF jsonb_typeof(p->'to') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'cc') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'to')>200 OR jsonb_array_length(p->'cc')>200 THEN RETURN false;END IF;
 -- The native queue may remove unreachable accounts and split a batch; it may never add another destination.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(mail->'to') destination WHERE NOT (((p->'to')||(p->'cc')) ? destination))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(mail->'cc') destination WHERE NOT ((p->'cc') ? destination)) THEN RETURN false;END IF;
 digest:=encode(sha256(convert_to(jsonb_build_object('module',p_delivery.module,'subjectId',p_delivery.subject_id,'key',source_key,'subject',mail->>'subject','body',mail->>'body','richBody',(mail->'richBody')-'sourceProof')::text,'UTF8')),'hex');
 IF p->>'digest' IS DISTINCT FROM digest THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.automation_run run JOIN public.automation_workflow_version workflow ON workflow.tenant_id=run.tenant_id AND workflow.workflow_id=run.workflow_id AND workflow.revision=run.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(workflow.definition->'steps') step WHERE run.tenant_id=p_delivery.tenant_id AND run.subject_id=p_delivery.subject_id AND run.module='probation' AND run.status IN('running','waiting')
 AND source_key=run.id::text||':'||(step->>'id') AND step->>'type'='sendEmail' AND step->'params'->>'emailTemplateId'=mail->'richBody'->'sourceTemplate'->>'id'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(run.remaining_steps) pending WHERE pending->'step'->>'id'=step->>'id'));
END $$;
REVOKE ALL ON FUNCTION app.automation_email_asset_delivery_proof(public.automation_email_delivery) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Existing native context authority remains first; only the actual immutable template revision's file metadata is added.
ALTER FUNCTION app.probation_automation_context(uuid) RENAME TO probation_automation_context_before_asset_source;
CREATE FUNCTION app.probation_automation_context(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=app.probation_automation_context_before_asset_source(p_case);
 IF result IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_set(result,'{emailTemplates}',coalesce((SELECT jsonb_agg(email||coalesce((SELECT jsonb_build_object('revision',v.revision,'assetCount',jsonb_array_length(coalesce(v.assets,'[]'::jsonb))) FROM public.automation_email_template_version v WHERE v.tenant_id=app.current_tenant_id() AND v.module='probation' AND v.template_id::text=email->>'id' ORDER BY v.revision DESC LIMIT 1),'{}'::jsonb) ORDER BY ordinal) FROM jsonb_array_elements(result->'emailTemplates') WITH ORDINALITY item(email,ordinal)),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.probation_automation_context_before_asset_source(uuid),app.probation_automation_context(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_automation_context(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_delivery_assets() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb;v public.automation_email_template_version;context jsonb;receipts jsonb;files jsonb;documents jsonb;is_test boolean;
BEGIN
 is_test:=coalesce(NEW.payload->>'purpose'='templateTest' AND NEW.payload->'context'->>'kind'='templateTest',false);
 ref:=NEW.payload->'mail'->'richBody'->'sourceTemplate';
 IF ref IS NULL AND is_test THEN ref:=jsonb_build_object('id',NEW.payload->'mail'->>'templateId','revision',NEW.payload->'mail'->'templateRevision');END IF;
 IF ref IS NULL OR ref='null'::jsonb THEN RETURN NEW;END IF;
 IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref-ARRAY['id','revision']<>'{}'::jsonb OR coalesce(ref->>'id','')!~'^[0-9a-f-]{36}$' OR coalesce(ref->>'revision','')!~'^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'Invalid email source revision' USING ERRCODE='22023';END IF;
 SELECT * INTO v FROM public.automation_email_template_version WHERE tenant_id=NEW.tenant_id AND template_id::text=ref->>'id' AND revision=(ref->>'revision')::integer AND module=NEW.module;
 IF v.template_id IS NULL OR v.retired OR (NOT v.active AND NOT is_test) OR v.body_doc IS NOT NULL AND v.body_doc IS DISTINCT FROM NEW.payload->'mail'->'richBody'->'doc' THEN RAISE EXCEPTION 'The queued email source does not match its published revision' USING ERRCODE='22023';END IF;
 IF is_test THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.payload->'mail'->'to' IS DISTINCT FROM jsonb_build_array(app.current_user_id()) OR NEW.payload->'mail'->'cc'<>'[]'::jsonb
   OR app.automation_can_manage(NEW.module,'templates') IS NOT TRUE OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RAISE EXCEPTION 'Template tests can only email their actual author' USING ERRCODE='42501';END IF;
 ELSIF NEW.module='contract_staff' THEN
  context:=app.contract_shared_mail_context(NEW.subject_id,regexp_replace(NEW.mail_key,':[0-9]+$',''));
  IF NOT EXISTS(SELECT 1 FROM public.automation_run run JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
   CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') step WHERE run.tenant_id=NEW.tenant_id AND run.subject_id=NEW.subject_id AND run.module=NEW.module
   AND regexp_replace(NEW.mail_key,':[0-9]+$','')=run.id::text||':'||(step->>'id') AND step->>'type'='sendEmail' AND step->'params'->>'emailTemplateId'=v.template_id::text)
   THEN RAISE EXCEPTION 'The accepted workflow step names another email template' USING ERRCODE='42501';END IF;
 ELSIF jsonb_array_length(coalesce(v.file_slots,'[]'::jsonb))>0 OR jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb))>0 THEN RAISE EXCEPTION 'This module has no attached case documents' USING ERRCODE='22023';END IF;
 IF NOT is_test AND NEW.module='probation' AND (jsonb_array_length(coalesce(v.assets,'[]'::jsonb))>0 OR NEW.payload->'mail'->'richBody' ? 'sourceProof') THEN
  IF app.automation_email_asset_delivery_proof(NEW) IS NOT TRUE THEN RAISE EXCEPTION 'Shared email attachments require the configured runtime verifier and an exact admitted workflow intent' USING ERRCODE='42501';END IF;
  SELECT jsonb_build_object('assetProtected',true,'assetSubjectPersonId',employment.person_id,'assetRecipientPeople',
   (SELECT jsonb_object_agg(account.id::text,account.person_id) FROM public.app_user account WHERE account.tenant_id=NEW.tenant_id AND ((NEW.payload->'mail'->'to')||(NEW.payload->'mail'->'cc')) ? account.id::text)) INTO context
  FROM public.probation_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.subject_id;
  IF context IS NULL OR context->>'assetSubjectPersonId' IS NULL THEN RAISE EXCEPTION 'The actual email subject is unavailable' USING ERRCODE='42501';END IF;
  NEW.payload:=jsonb_set(NEW.payload,'{context}',coalesce(NEW.payload->'context','{}'::jsonb)||context);
 END IF;
 receipts:=coalesce(v.assets,'[]'::jsonb);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(receipts) receipt WHERE NOT EXISTS(SELECT 1 FROM public.lc_v9_email_asset a
 WHERE a.tenant_id=NEW.tenant_id AND a.email_template_id=v.template_id::text AND a.automation_module=v.module AND a.shared_subject_id IS NULL
 AND a.id::text=receipt->>'id' AND app.automation_email_asset_metadata(a)=(receipt-'alt'))) THEN RAISE EXCEPTION 'An email file no longer matches its immutable receipt' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(app.automation_email_asset_metadata(a) ORDER BY slot->>'id'),'[]'::jsonb) INTO files
 FROM jsonb_array_elements(CASE WHEN is_test THEN '[]'::jsonb ELSE coalesce(v.file_slots,'[]'::jsonb) END) slot JOIN LATERAL(
  SELECT a.* FROM public.lc_v9_email_asset a WHERE a.tenant_id=NEW.tenant_id AND a.automation_module=v.module AND a.email_template_id=v.template_id::text
  AND a.shared_subject_id=NEW.subject_id AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=context->>'periodRevision' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) a ON true;
 IF NOT is_test AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.file_slots,'[]'::jsonb)) slot WHERE slot->'required'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM public.lc_v9_email_asset a
 WHERE a.tenant_id=NEW.tenant_id AND a.automation_module=v.module AND a.email_template_id=v.template_id::text AND a.shared_subject_id=NEW.subject_id AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=context->>'periodRevision'))
 THEN RAISE EXCEPTION 'Upload the required file for this person before continuing the email' USING ERRCODE='22023';END IF;
 receipts:=receipts||files;
 IF jsonb_array_length(receipts)>20 OR (SELECT coalesce(sum((receipt->>'size')::bigint),0) FROM jsonb_array_elements(receipts) receipt)>20000000 THEN RAISE EXCEPTION 'Keep attached files and inline images within 20 files and 20 MB' USING ERRCODE='22023';END IF;
 -- Each selected document belongs to this actual case, decision and accepted email step. The canonical document owner creates it.
 SELECT coalesce(jsonb_agg(jsonb_build_object('templateId',selected.value,'id',letter.id,'name',letter.data->'definition'->>'name','contentRevision',letter.data->'contentRevision',
 'snapshot',app.contract_shared_letter_snapshot(letter.id)) ORDER BY selected.value),'[]'::jsonb) INTO documents
 FROM jsonb_array_elements_text(CASE WHEN is_test THEN '[]'::jsonb ELSE coalesce(v.document_ids,'[]'::jsonb) END) selected(value) JOIN LATERAL(
  SELECT letter.* FROM public.contract_shared_letter letter WHERE letter.tenant_id=NEW.tenant_id AND letter.case_id=NEW.subject_id AND letter.decision_revision=(context->>'decisionRevision')::integer
  AND letter.data->>'templateId'=selected.value AND letter.purpose='email' AND letter.data->'emailTemplateRef'=jsonb_build_object('id',v.template_id,'revision',v.revision)
  AND regexp_replace(NEW.mail_key,':[0-9]+$','')=letter.workflow_run_id::text||':'||letter.workflow_step_id
  AND letter.data->>'state' NOT IN('withdrawn','superseded') ORDER BY letter.updated_at DESC,letter.id LIMIT 1) letter ON true;
 IF NOT is_test AND jsonb_array_length(documents)<>jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb)) THEN RAISE EXCEPTION 'Generate the selected case documents before continuing this email' USING ERRCODE='22023';END IF;
 NEW.payload:=jsonb_set(NEW.payload,'{mail}',(NEW.payload->'mail')||jsonb_build_object('templateId',v.template_id,'templateRevision',v.revision));
 NEW.payload:=jsonb_set(NEW.payload,'{mail,delivery}',(NEW.payload->'mail'->'delivery')||jsonb_build_object('assets',receipts,'documents',documents));
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_assets(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,kind text,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);
 IF target IS NULL THEN RETURN;END IF;
 IF target->>'module'='probation' AND target->'payload'->'context'->>'kind' IS DISTINCT FROM 'templateTest' THEN
  IF target->'payload'->'context'->'assetProtected' IS DISTINCT FROM 'true'::jsonb
  OR NOT EXISTS(SELECT 1 FROM public.probation_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
   WHERE c.tenant_id=(target->>'tenantId')::uuid AND c.id=(target->>'subjectId')::uuid AND employment.person_id::text=target->'payload'->'context'->>'assetSubjectPersonId')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text((target->'payload'->'mail'->'to')||(target->'payload'->'mail'->'cc')) recipient WHERE NOT EXISTS(
   SELECT 1 FROM public.app_user account WHERE account.tenant_id=(target->>'tenantId')::uuid AND account.id::text=recipient AND account.person_id::text=target->'payload'->'context'->'assetRecipientPeople'->>recipient))
  THEN RETURN;END IF;
 END IF;

 RETURN QUERY SELECT a.id,a.kind,a.filename,a.mime_type,encode(a.content,'base64'),a.content_hash
 FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb)) receipt JOIN public.lc_v9_email_asset a
 ON a.id::text=receipt->>'id' AND a.tenant_id=(target->>'tenantId')::uuid AND a.automation_module=target->>'module'
 AND a.email_template_id=target->'payload'->'mail'->>'templateId' AND app.automation_email_asset_metadata(a)=(receipt-'alt')
 AND (a.shared_subject_id IS NULL OR a.shared_subject_id::text=target->>'subjectId' AND a.shared_source_revision=target->'payload'->'context'->>'periodRevision');
END $$;

--> statement-breakpoint
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
 candidates AS MATERIALIZED(SELECT * FROM latest WHERE NOT retired AND jsonb_array_length(coalesce(file_slots,'[]'::jsonb))>0 ORDER BY name,template_id OFFSET p_offset LIMIT p_limit+1),
 templates AS MATERIALIZED(SELECT * FROM candidates ORDER BY name,template_id LIMIT p_limit)
 SELECT jsonb_build_object('hasMore',(SELECT count(*)>p_limit FROM candidates),'offset',p_offset,'limit',p_limit,'items',coalesce(jsonb_agg(jsonb_build_object('templateId',template_id,'templateName',name,'revision',revision,'slots',coalesce((SELECT jsonb_agg(slot||jsonb_build_object('file',(SELECT app.automation_email_asset_metadata(a) FROM public.lc_v9_email_asset a JOIN public.contract_shared_case f ON f.tenant_id=a.tenant_id AND f.case_id=a.shared_subject_id WHERE a.tenant_id=templates.tenant_id AND a.automation_module='contract_staff' AND a.email_template_id=templates.template_id::text AND a.shared_subject_id=p_case AND a.shared_slot_id=slot->>'id' AND a.shared_source_revision=f.data->'period'->>'sourceRevision' ORDER BY a.created_at DESC,a.id DESC LIMIT 1)) ORDER BY slot->>'id') FROM jsonb_array_elements(coalesce(templates.file_slots,'[]'::jsonb)) slot),'[]'::jsonb)) ORDER BY name,template_id),'[]'::jsonb))
 FROM templates);
END $$;
