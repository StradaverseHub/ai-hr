-- A fresh successful native upload is a real new observation, even when file bytes deduplicate.
-- Preserve5969 actor/source/pin checks; do not revive a processed stale child as its new completion proof.
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_emit(p_pin uuid,p_actor uuid,p_person uuid,p_observation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;origin jsonb;pin public.contract_shared_email_document_step;existing uuid;created uuid:=gen_random_uuid();signal_hash text;observation app.contract_email_upload_observation;
BEGIN
 IF app.contract_verified_human(p_actor) IS NOT TRUE OR p_person IS NULL OR p_person IS DISTINCT FROM app.contract_binding_person(p_actor) THEN RETURN NULL;END IF;
 IF p_observation IS NULL THEN
  IF p_actor IS DISTINCT FROM app.current_user_id() OR p_person IS DISTINCT FROM app.contract_actor_person(app.current_user_id()) THEN RAISE EXCEPTION 'Actual callback identity required' USING ERRCODE='42501';END IF;
 ELSE
  SELECT * INTO observation FROM app.contract_email_upload_observation WHERE tenant_id=app.current_tenant_id() AND id=p_observation;
  IF observation.id IS NULL OR observation.actor_user_id IS DISTINCT FROM p_actor OR observation.actor_person_id IS DISTINCT FROM p_person
  OR NOT EXISTS(SELECT 1 FROM public.contract_shared_email_document_step p JOIN public.lc_v9_email_asset asset ON asset.tenant_id=p.tenant_id AND asset.id=observation.asset_id
   JOIN public.automation_email_template_version v ON v.tenant_id=p.tenant_id AND v.template_id=p.email_template_id AND v.revision=p.email_revision
   WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_pin AND asset.automation_module='contract_staff' AND asset.kind='file'
   AND asset.email_template_id=p.email_template_id::text AND asset.shared_subject_id=p.case_id AND asset.shared_source_revision=p.source_period_revision
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v.file_slots,'[]'::jsonb)) slot WHERE slot->>'id'=asset.shared_slot_id))
  OR app.contract_shared_email_prerequisite_origin_held(p_pin) IS NOT TRUE THEN RAISE EXCEPTION 'Actual authorised upload observation required' USING ERRCODE='42501';END IF;
 END IF;
 PERFORM app.contract_shared_email_prerequisite_lock(p_pin);
 state:=app.contract_shared_email_prerequisite_state(p_pin);IF state->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 signal_hash:=encode(sha256(convert_to((CASE WHEN p_observation IS NULL THEN jsonb_build_array(state->>'proofHash',p_actor,p_person)
  ELSE jsonb_build_array(state->>'proofHash',p_actor,p_person,p_observation) END)::text,'UTF8')),'hex');
 SELECT receipt.event_id INTO existing FROM app.contract_email_prerequisite_resume receipt WHERE receipt.tenant_id=app.current_tenant_id() AND receipt.pin_id=p_pin AND receipt.proof_hash=signal_hash;
 IF existing IS NOT NULL THEN RETURN existing;END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 origin:=state->'origin';
 INSERT INTO app.contract_email_prerequisite_resume(tenant_id,event_id,pin_id,proof_hash,readiness_hash,callback_user_id,callback_person_id,source_run_hash)
 VALUES(pin.tenant_id,created,pin.id,signal_hash,state->>'proofHash',p_actor,p_person,state->>'runHash');
 INSERT INTO public.contract_shared_event(tenant_id,id,case_id,trigger_event,occurrence,decision_revision,actor_user_id,actor_person_id,actor_type,workflow_versions,data,root_event_id,job_id)
 VALUES(pin.tenant_id,created,pin.case_id,'emailDocumentReady',pin.id::text||':'||signal_hash,pin.decision_revision,p_actor,p_person,'user','[]'::jsonb,
  jsonb_build_object('prerequisiteId',pin.id,'runId',pin.workflow_run_id,'stepId',pin.workflow_step_id,'emailId',pin.email_template_id,'emailRevision',pin.email_revision,
   'proofHash',signal_hash,'letterId',origin->'letterId','sourcePersonId',pin.subject_person_id,'sourceRevision',pin.source_period_revision,'originEventId',origin->>'eventId'),
  (origin->>'rootEventId')::uuid,(origin->>'jobId')::uuid);
 RETURN created;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_emit(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
