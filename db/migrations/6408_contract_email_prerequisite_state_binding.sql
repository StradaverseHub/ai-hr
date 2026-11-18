-- Same proof and same function OID: qualify native columns and distinguish the selected-template loop variable.
-- A real canonical Form save exposed the former template_id variable/column ambiguity in5960.
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_state(p_pin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;run public.automation_run;version public.automation_email_template_version;
 origin jsonb;first jsonb;frozen jsonb;v_template_key text;letter public.contract_shared_letter;signing public.document_signing_document;
 form public.document_form_response;ready jsonb;documents jsonb:='[]'::jsonb;files jsonb;proof jsonb;
BEGIN
 origin:=app.contract_shared_email_prerequisite_origin(p_pin);IF origin IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 SELECT p.* INTO pin FROM public.contract_shared_email_document_step p WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_pin;
 SELECT r.* INTO run FROM public.automation_run r WHERE r.tenant_id=pin.tenant_id AND r.id=pin.workflow_run_id;
 first:=run.remaining_steps->0;
 SELECT s.step INTO frozen FROM public.automation_workflow_version v CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') WITH ORDINALITY s(step,n)
 WHERE v.tenant_id=run.tenant_id AND v.workflow_id=run.workflow_id AND v.revision=run.workflow_revision AND s.n=(first->>'index')::integer+1;
 IF run.module<>'contract_staff' OR run.subject_id IS DISTINCT FROM pin.case_id OR run.status<>'waiting' OR run.waiting_for IS DISTINCT FROM pin.id
 OR run.step_cursor IS DISTINCT FROM (first->>'index')::integer OR first->'step' IS DISTINCT FROM frozen
 OR first->'step'->>'id' IS DISTINCT FROM pin.workflow_step_id OR first->'step'->>'type' IS DISTINCT FROM 'sendEmail'
 OR first->'step'->'params'->>'emailTemplateId' IS DISTINCT FROM pin.email_template_id::text THEN RETURN jsonb_build_object('ready',false,'reason','not_waiting');END IF;
 SELECT v.* INTO version FROM public.automation_email_template_version v WHERE v.tenant_id=pin.tenant_id AND v.template_id=pin.email_template_id AND v.revision=pin.email_revision AND v.module='contract_staff';
 IF version.template_id IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','template_missing');END IF;
 FOR v_template_key IN SELECT selected.value#>>'{}' FROM jsonb_array_elements(coalesce(version.document_ids,'[]'::jsonb)) selected(value) ORDER BY selected.value#>>'{}' LOOP
  SELECT l.* INTO letter FROM public.contract_shared_letter l WHERE l.tenant_id=pin.tenant_id AND l.id=(pin.documents->>v_template_key)::uuid AND l.case_id=pin.case_id AND l.decision_revision=pin.decision_revision AND l.data->>'templateId'=v_template_key AND l.data->>'subjectPersonId'=pin.subject_person_id::text;
  IF letter.id IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','document_missing');END IF;
  ready:=app.contract_shared_email_document_readiness(letter.id);
  IF ready->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN ready;END IF;
  SELECT d.* INTO signing FROM public.document_signing_document d WHERE d.tenant_id=letter.tenant_id AND d.id=letter.signing_document_id;
  SELECT f.* INTO form FROM public.document_form_response f WHERE f.tenant_id=letter.tenant_id AND f.document_id=letter.signing_document_id;
  documents:=documents||jsonb_build_array(jsonb_build_object('templateId',v_template_key,'letterId',letter.id,'signingId',signing.id,'revision',signing.revision,
   'signingHash',encode(sha256(convert_to(signing.data::text,'UTF8')),'hex'),'formRevision',form.revision,'formHash',CASE WHEN form.document_id IS NOT NULL THEN encode(sha256(convert_to(jsonb_build_array(form.answers,form.locked_values)::text,'UTF8')),'hex') END));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(version.file_slots,'[]'::jsonb)) slot(value) WHERE slot.value->'required'='true'::jsonb) THEN
  IF to_regprocedure('app.contract_shared_email_required_files_proof(uuid)') IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','required_files');END IF;
  EXECUTE 'SELECT app.contract_shared_email_required_files_proof($1)' INTO files USING p_pin;
  IF files->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN jsonb_build_object('ready',false,'reason','required_files');END IF;
 ELSE files:=jsonb_build_object('ready',true,'assets','[]'::jsonb);END IF;
 proof:=origin||jsonb_build_object('documents',documents,'files',files);
 RETURN jsonb_build_object('ready',true,'proofHash',encode(sha256(convert_to(proof::text,'UTF8')),'hex'),
  'runHash',encode(sha256(convert_to((to_jsonb(run)-'updated_at')::text,'UTF8')),'hex'),'origin',origin);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_state(uuid) FROM PUBLIC,ai_hr_app;
