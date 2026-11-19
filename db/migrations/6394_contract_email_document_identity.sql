-- SMTP helper derives tenant ONLY by verifying the actual delivery capability and document receipt. No GUC impersonation.
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_readiness(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;document jsonb;subject_person uuid;values jsonb;field jsonb;
BEGIN
 -- Private helper; only the held-step owner and the authenticated canonical progression trigger call it.
 -- No application EXECUTE grant. A human-origin trigger retains its real actor, without impersonating owner.
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT employment.person_id INTO subject_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id WHERE c.tenant_id=letter.tenant_id AND c.id=letter.case_id;
 IF letter.id IS NULL OR document IS NULL OR subject_person::text IS DISTINCT FROM letter.data->>'subjectPersonId' THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 IF letter.data->>'state' IN('declined','withdrawn') THEN RETURN jsonb_build_object('ready',false,'reason','stopped');END IF;
 IF app.document_signing_returned(document) THEN RETURN jsonb_build_object('ready',false,'reason','returned');END IF;
 IF letter.data->>'state'='released' THEN RETURN jsonb_build_object('ready',true,'reason','released');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'<>'employee') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'='employee') THEN
  IF app.contract_shared_document_kind(letter.id)='Form' THEN
   SELECT coalesce(response.locked_values,(SELECT coalesce(jsonb_object_agg(source_field->>'id',coalesce(letter.data->'values'->>coalesce(nullif(source_field->>'pmKey',''),source_field->>'id'),'')),'{}'::jsonb) FROM jsonb_array_elements(letter.data->'definition'->'fields') source_field))||response.answers INTO values FROM public.document_form_response response WHERE response.tenant_id=letter.tenant_id AND response.document_id=letter.signing_document_id;
   IF values IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   FOR field IN SELECT * FROM jsonb_array_elements(letter.data->'definition'->'fields') WHERE value->>'owner'<>'employee' LOOP
    IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
    IF field->'required'='true'::jsonb AND (btrim(coalesce(values->>(field->>'id'),''))='' OR field->>'type'='checkbox' AND values->>(field->>'id')<>'true') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
    WHERE step->>'role'='employee' AND account.person_id=subject_person AND app.contract_verified_human(account.id)) THEN RETURN jsonb_build_object('ready',true,'reason','employee');END IF;
  RETURN jsonb_build_object('ready',false,'reason','employee_account');
 END IF;
 RETURN jsonb_build_object('ready',false,'reason','hr_steps');
END $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_document_readiness(p_delivery uuid,p_token uuid,p_origin text,p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;p_tenant uuid;letter public.contract_shared_letter;document jsonb;subject_person uuid;values jsonb;field jsonb;
BEGIN
 target:=app.automation_email_target(p_delivery,p_token,p_origin);
 IF target IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb)) doc WHERE doc->>'id'=p_letter::text) THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 p_tenant:=(target->>'tenantId')::uuid;
 -- Private helper; only the held-step owner and the authenticated canonical progression trigger call it.
 -- No application EXECUTE grant. A human-origin trigger retains its real actor, without impersonating owner.
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 SELECT employment.person_id INTO subject_person FROM public.contract_case c JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id WHERE c.tenant_id=letter.tenant_id AND c.id=letter.case_id;
 IF letter.id IS NULL OR document IS NULL OR subject_person::text IS DISTINCT FROM letter.data->>'subjectPersonId' THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 IF letter.data->>'state' IN('declined','withdrawn') THEN RETURN jsonb_build_object('ready',false,'reason','stopped');END IF;
 IF app.document_signing_returned(document) THEN RETURN jsonb_build_object('ready',false,'reason','returned');END IF;
 IF letter.data->>'state'='released' THEN RETURN jsonb_build_object('ready',true,'reason','released');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'<>'employee') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
 IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step WHERE step->>'role'='employee') THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(letter.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields')) THEN
   SELECT coalesce(response.locked_values,(SELECT coalesce(jsonb_object_agg(source_field->>'id',coalesce(letter.data->'values'->>coalesce(nullif(source_field->>'pmKey',''),source_field->>'id'),'')),'{}'::jsonb) FROM jsonb_array_elements(letter.data->'definition'->'fields') source_field))||response.answers INTO values FROM public.document_form_response response WHERE response.tenant_id=letter.tenant_id AND response.document_id=letter.signing_document_id;
   IF values IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   FOR field IN SELECT * FROM jsonb_array_elements(letter.data->'definition'->'fields') WHERE value->>'owner'<>'employee' LOOP
    IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
    IF field->'required'='true'::jsonb AND (btrim(coalesce(values->>(field->>'id'),''))='' OR field->>'type'='checkbox' AND values->>(field->>'id')<>'true') THEN RETURN jsonb_build_object('ready',false,'reason','hr_steps');END IF;
   END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document) step JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id::text=step->>'holderId' AND account.person_id::text=step->>'holderPersonId'
    WHERE step->>'role'='employee' AND account.person_id=subject_person AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND EXISTS(SELECT 1 FROM public.person person WHERE person.tenant_id=account.tenant_id AND person.id=account.person_id AND length(btrim(person.full_name))>0)) THEN RETURN jsonb_build_object('ready',true,'reason','employee');END IF;
  RETURN jsonb_build_object('ready',false,'reason','employee_account');
 END IF;
 RETURN jsonb_build_object('ready',false,'reason','hr_steps');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_readiness(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_document_lock(p_delivery uuid,p_token uuid,p_origin text,p_letter uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;p_tenant uuid;l public.contract_shared_letter;
BEGIN
 target:=app.automation_email_target(p_delivery,p_token,p_origin);
 IF target IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb)) doc WHERE doc->>'id'=p_letter::text) THEN RAISE EXCEPTION 'Verified SMTP document capability required' USING ERRCODE='42501';END IF;
 p_tenant:=(target->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||p_tenant::text,0));
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=p_tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workforce policy generation unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.access_configuration WHERE tenant_id=p_tenant AND initialized FOR SHARE;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=p_letter;
 PERFORM 1 FROM public.employment e JOIN public.contract_case c ON c.tenant_id=e.tenant_id AND c.employment_id=e.id WHERE c.tenant_id=p_tenant AND c.id=l.case_id FOR SHARE OF e;
 PERFORM 1 FROM public.contract_shared_letter WHERE tenant_id=p_tenant AND id=l.id FOR UPDATE;
 PERFORM 1 FROM public.document_signing_document WHERE tenant_id=p_tenant AND id=l.signing_document_id FOR UPDATE;
 PERFORM 1 FROM public.document_form_response WHERE tenant_id=p_tenant AND document_id=l.signing_document_id FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_lock(uuid,uuid,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_delivery_assets() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb;v public.automation_email_template_version;context jsonb;receipts jsonb;files jsonb;documents jsonb;pin public.contract_shared_email_document_step;recipient_people jsonb;
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
  SELECT p.* INTO pin FROM public.contract_shared_email_document_step p JOIN public.contract_case c ON c.tenant_id=p.tenant_id AND c.id=p.case_id AND c.company_id=p.company_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=p.company_id AND e.person_id=p.subject_person_id WHERE p.tenant_id=NEW.tenant_id AND p.case_id=NEW.subject_id AND p.workflow_run_id::text||':'||p.workflow_step_id=regexp_replace(NEW.mail_key,':[0-9]+$','') AND p.email_template_id=v.template_id AND p.email_revision=v.revision;
  IF pin.id IS NOT NULL THEN context:=context||jsonb_build_object('periodRevision',pin.source_period_revision,'decisionRevision',pin.decision_revision);ELSIF jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb))>0 THEN RAISE EXCEPTION 'Prepare the immutable email documents first' USING ERRCODE='42501';END IF;
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
 'contentHash',(SELECT data->>'contentHash' FROM public.document_signing_document signing WHERE signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id)) ORDER BY id),'[]'::jsonb) INTO documents
 FROM jsonb_array_elements_text(CASE WHEN NEW.payload->'context'->>'kind'='templateTest' THEN '[]'::jsonb ELSE coalesce(v.document_ids,'[]'::jsonb) END) id JOIN LATERAL(
  SELECT letter.* FROM public.contract_shared_letter letter WHERE letter.tenant_id=NEW.tenant_id AND letter.case_id=NEW.subject_id AND letter.decision_revision=(context->>'decisionRevision')::integer
  AND letter.data->>'templateId'=id AND pin.documents->>id=letter.id::text AND letter.purpose IN('email',pin.phase)
  AND letter.data->>'state' NOT IN('withdrawn','declined','superseded') AND (app.contract_shared_email_document_readiness(letter.id)->>'ready')::boolean ORDER BY letter.updated_at DESC,letter.id LIMIT 1) letter ON true;
 IF NEW.payload->'context'->>'kind' IS DISTINCT FROM 'templateTest' AND jsonb_array_length(documents)<>jsonb_array_length(coalesce(v.document_ids,'[]'::jsonb)) THEN RAISE EXCEPTION 'Generate the selected case documents before continuing this email' USING ERRCODE='22023';END IF;
 NEW.payload:=jsonb_set(NEW.payload,'{mail}',(NEW.payload->'mail')||jsonb_build_object('templateId',v.template_id,'templateRevision',v.revision));
 SELECT coalesce(jsonb_agg(jsonb_build_object('userId',account.id,'personId',account.person_id) ORDER BY account.id),'[]'::jsonb) INTO recipient_people FROM public.app_user account JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id WHERE account.tenant_id=NEW.tenant_id AND ((NEW.payload->'mail'->'to')||(NEW.payload->'mail'->'cc')) ? account.id::text AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0;
 NEW.payload:=jsonb_set(NEW.payload,'{mail,delivery}',(NEW.payload->'mail'->'delivery')||jsonb_build_object('assets',receipts,'documents',documents,'documentRecipients',recipient_people));
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_self_binding_available(p_letter uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN public.document_signing_document d ON d.tenant_id=l.tenant_id AND d.id=l.signing_document_id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=l.tenant_id AND pin.case_id=l.case_id AND pin.company_id=c.company_id AND pin.subject_person_id=e.person_id AND pin.documents @> jsonb_build_object(l.data->>'templateId',l.id::text)
 JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.module='contract_staff' AND run.subject_id=pin.case_id AND run.status='waiting' AND run.waiting_for=pin.id
 WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.purpose='email' AND l.data->>'state'='routing' AND e.person_id::text=l.data->>'subjectPersonId'
 AND e.person_id=app.contract_actor_person(app.current_user_id()) AND app.contract_shared_email_document_current(l.id) AND app.contract_company_entitled(c.company_id)
 AND (SELECT count(*) FROM public.app_user account WHERE account.tenant_id=l.tenant_id AND account.person_id=e.person_id AND app.contract_verified_human(account.id))=1
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,step)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_self_binding_available(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_recipient_receipt(p_tenant uuid,p_letter uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter letter JOIN public.contract_case c ON c.tenant_id=letter.tenant_id AND c.id=letter.case_id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id AND e.person_id::text=letter.data->>'subjectPersonId'
 JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id=p_user JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
 JOIN public.automation_email_delivery delivery ON delivery.tenant_id=letter.tenant_id AND delivery.subject_id=letter.case_id AND delivery.module='contract_staff'
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=delivery.tenant_id AND pin.case_id=delivery.subject_id AND pin.company_id=c.company_id AND pin.subject_person_id=e.person_id
 WHERE letter.tenant_id=p_tenant AND letter.id=p_letter AND letter.data->>'state'='released' AND e.voided_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(letter.data->'definition'->'blocks') block WHERE block->>'type' IN('field','fields'))
 AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0 AND delivery.status<>'cancelled'
 AND pin.email_template_id::text=delivery.payload->'mail'->>'templateId' AND pin.email_revision::text=delivery.payload->'mail'->>'templateRevision'
 AND pin.documents @> jsonb_build_object(letter.data->>'templateId',letter.id::text)
 AND regexp_replace(delivery.mail_key,':[0-9]+$','')=pin.workflow_run_id::text||':'||pin.workflow_step_id
 AND delivery.payload->'mail'->'delivery'->'documents' @> jsonb_build_array(jsonb_build_object('id',letter.id))
 AND ((delivery.payload->'mail'->'to')||(delivery.payload->'mail'->'cc')) ? account.id::text
 AND delivery.payload->'mail'->'delivery'->'documentRecipients' @> jsonb_build_array(jsonb_build_object('userId',account.id,'personId',account.person_id)))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_recipient_receipt(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_recipient(p_tenant uuid,p_letter uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_letter letter JOIN public.contract_case c ON c.tenant_id=letter.tenant_id AND c.id=letter.case_id
 JOIN public.contract_shared_case flow ON flow.tenant_id=c.tenant_id AND flow.case_id=c.id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id AND employment.company_id=c.company_id
 JOIN public.document_signing_document signing ON signing.tenant_id=letter.tenant_id AND signing.id=letter.signing_document_id
 JOIN public.app_user account ON account.tenant_id=letter.tenant_id AND account.id=p_user
 JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
 WHERE letter.tenant_id=p_tenant AND letter.id=p_letter AND account.archived_at IS NULL AND NOT app.login_blocked(account.id) AND length(btrim(person.full_name))>0
 AND employment.person_id::text=letter.data->>'subjectPersonId' AND employment.voided_at IS NULL
 AND (EXISTS(SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step WHERE step->>'holderId'=account.id::text AND step->>'holderPersonId'=account.person_id::text)
 OR app.contract_shared_email_recipient_receipt(p_tenant,p_letter,p_user)))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_signing_access(p_type text,p_subject uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l public.contract_shared_letter;document jsonb;assigned boolean;ordinary_company uuid;
BEGIN
 -- Actual recipient access was explicitly approved; this grants no action or Form-body authority.
 IF p_type='contract' AND p_operation='read' AND app.contract_shared_email_recipient_receipt(app.current_tenant_id(),p_subject,app.current_user_id()) THEN RETURN true;END IF;
 IF p_type='contract' AND p_operation='read' AND app.contract_shared_email_self_binding_available(p_subject) THEN RETURN true;END IF;
 IF p_type='contract' AND p_operation='reroute' AND app.contract_shared_email_self_binding_available(p_subject) AND app.contract_shared_email_self_binding_held(p_subject) THEN RETURN true;END IF;
 -- Existing reads remain unchanged. Decision approvals and ordinary Letters require their own company module.
 IF p_type='contract-approval' AND p_operation IS DISTINCT FROM 'read' THEN
  SELECT c.company_id INTO ordinary_company FROM public.contract_shared_approval approval JOIN public.contract_case c ON c.tenant_id=approval.tenant_id AND c.id=approval.case_id
  WHERE approval.tenant_id=app.current_tenant_id() AND approval.id=p_subject;
  IF ordinary_company IS NOT NULL AND app.contract_company_entitled(ordinary_company) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 -- Held email/Form paths below delegate unchanged.
 IF p_type='contract' AND p_operation IS DISTINCT FROM 'read' THEN
  SELECT c.company_id INTO ordinary_company FROM public.contract_shared_letter letter JOIN public.contract_case c ON c.tenant_id=letter.tenant_id AND c.id=letter.case_id
  WHERE letter.tenant_id=app.current_tenant_id() AND letter.id=p_subject AND letter.purpose<>'email'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(letter.data->'definition'->'blocks','[]'::jsonb)) block WHERE block->>'type' IN('field','fields'));
  IF ordinary_company IS NOT NULL AND app.contract_company_entitled(ordinary_company) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 IF p_type<>'contract' OR p_operation NOT IN('sign','revise','live_refresh') THEN RETURN app.contract_shared_signing_access_before_email_documents(p_type,p_subject,p_operation);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_subject;
 IF l.purpose IS DISTINCT FROM 'email' THEN RETURN app.contract_shared_signing_access_before_email_documents(p_type,p_subject,p_operation);END IF;
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE OR app.contract_shared_email_document_current(p_subject) IS NOT TRUE OR l.data->>'state'<>'routing' THEN RETURN false;END IF;
 SELECT data INTO document FROM public.document_signing_document WHERE tenant_id=l.tenant_id AND id=l.signing_document_id AND subject_type='contract' AND subject_id=l.id;
 IF document IS NULL THEN RETURN false;END IF;
 assigned:=EXISTS(SELECT 1 FROM jsonb_array_elements(document->'route'->'steps') step WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text);
 IF p_operation='sign' THEN RETURN assigned AND (EXISTS(SELECT 1 FROM app.document_signing_pending_steps(document)) OR app.document_signing_returned(document) AND app.document_signing_owner(document)=app.current_user_id());END IF;
 IF p_operation='revise' THEN RETURN app.document_signing_can_edit(document,app.current_user_id());END IF;
 RETURN assigned AND NOT app.document_signing_locked(document);
END $$;
