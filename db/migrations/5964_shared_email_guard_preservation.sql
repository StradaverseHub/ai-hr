-- Forward repair: retain the full canonical5842 owner (self-tests, plain source refs, Probation HMAC and UID/PID proof), then add only immutable Contract pin document receipts.
CREATE OR REPLACE FUNCTION app.automation_email_delivery_assets() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb;v public.automation_email_template_version;context jsonb;receipts jsonb;files jsonb;documents jsonb;is_test boolean;pin public.contract_shared_email_document_step;recipient_people jsonb;
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
  SELECT p.* INTO pin FROM public.contract_shared_email_document_step p JOIN public.contract_case c ON c.tenant_id=p.tenant_id AND c.id=p.case_id AND c.company_id=p.company_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=p.company_id AND e.person_id=p.subject_person_id WHERE p.tenant_id=NEW.tenant_id AND p.case_id=NEW.subject_id AND p.workflow_run_id::text||':'||p.workflow_step_id=regexp_replace(NEW.mail_key,':[0-9]+$','') AND p.email_template_id=v.template_id AND p.email_revision=v.revision;
  IF pin.id IS NOT NULL THEN context:=context||jsonb_build_object('periodRevision',pin.source_period_revision,'decisionRevision',pin.decision_revision);ELSIF jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb))>0 THEN RAISE EXCEPTION 'Prepare the immutable email documents first' USING ERRCODE='42501';END IF;
  IF pin.id IS NOT NULL THEN NEW.payload:=jsonb_set(NEW.payload,'{context}',coalesce(NEW.payload->'context','{}'::jsonb)||context);END IF;
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
 'contentHash',(SELECT signing.data->>'contentHash' FROM public.document_signing_document signing WHERE signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id)) ORDER BY selected.value),'[]'::jsonb) INTO documents
 FROM jsonb_array_elements_text(CASE WHEN is_test THEN '[]'::jsonb ELSE coalesce(v.document_ids,'[]'::jsonb) END) selected(value) JOIN LATERAL(
  SELECT canonical.* FROM public.contract_shared_letter canonical WHERE canonical.tenant_id=NEW.tenant_id AND canonical.case_id=NEW.subject_id AND canonical.decision_revision=pin.decision_revision
  AND canonical.data->>'templateId'=selected.value AND pin.documents->>selected.value=canonical.id::text AND canonical.purpose IN('email',pin.phase)
  AND canonical.data->>'state' NOT IN('withdrawn','declined','superseded') AND (app.contract_shared_email_document_readiness(canonical.id)->>'ready')::boolean ORDER BY canonical.updated_at DESC,canonical.id LIMIT 1) letter ON true;
 IF NOT is_test AND jsonb_array_length(documents)<>jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb)) THEN RAISE EXCEPTION 'Generate the selected case documents before continuing this email' USING ERRCODE='22023';END IF;
 NEW.payload:=jsonb_set(NEW.payload,'{mail}',(NEW.payload->'mail')||jsonb_build_object('templateId',v.template_id,'templateRevision',v.revision));
 IF NEW.module='contract_staff' AND NOT is_test THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('userId',account.id,'personId',account.person_id) ORDER BY account.id),'[]'::jsonb) INTO recipient_people FROM public.app_user account JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id WHERE account.tenant_id=NEW.tenant_id AND ((NEW.payload->'mail'->'to')||(NEW.payload->'mail'->'cc')) ? account.id::text AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0;
 END IF;
 NEW.payload:=jsonb_set(NEW.payload,'{mail,delivery}',(NEW.payload->'mail'->'delivery')||jsonb_build_object('assets',receipts,'documents',documents)||CASE WHEN NEW.module='contract_staff' AND NOT is_test THEN jsonb_build_object('documentRecipients',recipient_people) ELSE '{}'::jsonb END);
 RETURN NEW;
END $$;
