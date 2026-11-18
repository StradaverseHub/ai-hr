-- A historical upload receipt retains its real actor. A retry still requires that account to be active and bound.
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
 signal_hash:=encode(sha256(convert_to(jsonb_build_array(state->>'proofHash',p_actor,p_person)::text,'UTF8')),'hex');
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_event_held(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;receipt app.contract_email_prerequisite_resume;state jsonb;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=event.tenant_id AND event_id=event.id;
 IF receipt.event_id IS NULL OR receipt.completed_at IS NOT NULL OR event.trigger_event<>'emailDocumentReady' OR event.processed_at IS NOT NULL
 OR event.workflow_versions IS DISTINCT FROM '[]'::jsonb OR event.id::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR event.actor_type<>'user' OR event.actor_user_id IS DISTINCT FROM receipt.callback_user_id OR event.actor_person_id IS DISTINCT FROM receipt.callback_person_id
 OR app.contract_verified_human(receipt.callback_user_id) IS NOT TRUE OR receipt.callback_person_id IS DISTINCT FROM app.contract_binding_person(receipt.callback_user_id)
 OR app.contract_shared_email_prerequisite_origin_held(receipt.pin_id) IS NOT TRUE THEN RETURN false;END IF;
 state:=app.contract_shared_email_prerequisite_state(receipt.pin_id);
 RETURN state->'ready'='true'::jsonb AND state->>'proofHash'=receipt.readiness_hash AND state->>'runHash'=receipt.source_run_hash
 AND event.case_id::text=state->'origin'->>'caseId' AND event.job_id::text=state->'origin'->>'jobId'
 AND event.root_event_id::text=state->'origin'->>'rootEventId' AND event.decision_revision::text=state->'origin'->>'decisionRevision'
 AND event.data=jsonb_build_object('prerequisiteId',receipt.pin_id,'runId',state->'origin'->>'runId','stepId',state->'origin'->>'stepId',
  'emailId',state->'origin'->>'emailId','emailRevision',(state->'origin'->>'emailRevision')::integer,'proofHash',receipt.proof_hash,'letterId',state->'origin'->'letterId',
  'sourcePersonId',state->'origin'->>'personId','sourceRevision',state->'origin'->>'sourceRevision','originEventId',state->'origin'->>'eventId');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_event_held(uuid) FROM PUBLIC,ai_hr_app;
