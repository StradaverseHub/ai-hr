-- Explicit owner approval: only the same pinned, waiting Send email may recover after canonical progress.
-- Its ORIGINAL live kernel job retains all other authority. No new job kind, principal or authored trigger.
ALTER TABLE public.contract_shared_event DROP CONSTRAINT contract_shared_event_trigger_event_check;
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_trigger_event_check CHECK(trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd','decisionSubmitted','approvalsComplete','approvalRejected','employeeDeclined','letterActionNeeded','letterSentBack','letterReleased','manual','approvalActionNeeded','emailDocumentReady'));
--> statement-breakpoint
CREATE TABLE app.contract_email_prerequisite_origin(
 tenant_id uuid NOT NULL,pin_id uuid NOT NULL,origin_event_id uuid NOT NULL,root_event_id uuid NOT NULL,job_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,pin_id),
 FOREIGN KEY(tenant_id,pin_id) REFERENCES public.contract_shared_email_document_step(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(tenant_id,root_event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(job_id) REFERENCES public.bulk_job(id)
);
CREATE TABLE app.contract_email_prerequisite_resume(
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,pin_id uuid NOT NULL,proof_hash text NOT NULL CHECK(proof_hash~'^[0-9a-f]{64}$'),readiness_hash text NOT NULL CHECK(readiness_hash~'^[0-9a-f]{64}$'),
 callback_user_id uuid NOT NULL REFERENCES public.app_user(id),callback_person_id uuid NOT NULL REFERENCES public.person(id),
 source_run_hash text NOT NULL,result_run_hash text,completed_at timestamptz,continued_at timestamptz,
 PRIMARY KEY(tenant_id,event_id),UNIQUE(tenant_id,pin_id,proof_hash),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,pin_id) REFERENCES app.contract_email_prerequisite_origin(tenant_id,pin_id)
);
CREATE TABLE app.contract_email_upload_observation(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES public.lc_v9_email_asset(id),
 actor_user_id uuid NOT NULL REFERENCES public.app_user(id),actor_person_id uuid NOT NULL REFERENCES public.person(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE app.contract_email_upload_seen(
 tenant_id uuid NOT NULL,pin_id uuid NOT NULL,observation_id uuid NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,pin_id,observation_id),
 FOREIGN KEY(tenant_id,pin_id) REFERENCES app.contract_email_prerequisite_origin(tenant_id,pin_id),
 FOREIGN KEY(tenant_id,observation_id) REFERENCES app.contract_email_upload_observation(tenant_id,id)
);
REVOKE ALL ON app.contract_email_prerequisite_origin,app.contract_email_prerequisite_resume FROM PUBLIC,ai_hr_app;
REVOKE ALL ON app.contract_email_upload_observation,app.contract_email_upload_seen FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON app.contract_email_prerequisite_origin TO ai_hr_owner;
GRANT SELECT,INSERT,UPDATE ON app.contract_email_prerequisite_resume TO ai_hr_owner;
GRANT SELECT,INSERT ON app.contract_email_upload_observation,app.contract_email_upload_seen TO ai_hr_owner;
CREATE INDEX contract_email_upload_observation_asset ON app.contract_email_upload_observation(tenant_id,asset_id,recorded_at,id);
CREATE INDEX contract_email_prerequisite_origin_job ON app.contract_email_prerequisite_origin(tenant_id,job_id,origin_event_id);
CREATE INDEX contract_email_prerequisite_document_case ON public.contract_shared_email_document_step(tenant_id,case_id);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_lock(p_pin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE template_id uuid;
BEGIN
 SELECT email_template_id INTO template_id FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 IF template_id IS NULL THEN RAISE EXCEPTION 'Email prerequisite unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-email-pin:'||app.current_tenant_id()::text||':'||p_pin::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||app.current_tenant_id()::text||':'||template_id::text,0));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_lock(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Capture the ACTUAL worker event which first reached this step (often letterReleased, not the run starter).
ALTER FUNCTION app.contract_shared_email_documents_prepare(uuid,uuid,text,uuid,integer) RENAME TO contract_shared_email_documents_prepare_before_recovery;
CREATE FUNCTION app.contract_shared_email_documents_prepare(p_case uuid,p_run uuid,p_step text,p_email uuid,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;event public.contract_shared_event;origin app.contract_email_prerequisite_origin;
BEGIN
 result:=app.contract_shared_email_documents_prepare_before_recovery(p_case,p_run,p_step,p_email,p_revision);
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true) AND case_id=p_case;
 IF event.id IS NULL OR app.contract_shared_effect_held(p_case,p_run,p_step,'sendEmail') IS NOT TRUE THEN RAISE EXCEPTION 'Actual held Send email owner required' USING ERRCODE='42501';END IF;
 SELECT * INTO origin FROM app.contract_email_prerequisite_origin WHERE tenant_id=event.tenant_id AND pin_id=(result->>'prerequisiteId')::uuid;
 IF origin.pin_id IS NULL THEN
  IF event.trigger_event='emailDocumentReady' THEN RAISE EXCEPTION 'Recovery cannot invent an original email owner' USING ERRCODE='42501';END IF;
  INSERT INTO app.contract_email_prerequisite_origin(tenant_id,pin_id,origin_event_id,root_event_id,job_id)
  VALUES(event.tenant_id,(result->>'prerequisiteId')::uuid,event.id,coalesce(event.root_event_id,event.id),event.job_id);
 ELSIF origin.job_id IS DISTINCT FROM event.job_id OR origin.root_event_id IS DISTINCT FROM coalesce(event.root_event_id,event.id)
 OR (event.trigger_event<>'emailDocumentReady' AND origin.origin_event_id IS DISTINCT FROM event.id) THEN
  RAISE EXCEPTION 'The original email owner changed' USING ERRCODE='42501';
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_documents_prepare_before_recovery(uuid,uuid,text,uuid,integer),app.contract_shared_email_documents_prepare(uuid,uuid,text,uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- No current capability is assumed at a human callback; execution additionally checks its genuine live seal.
CREATE FUNCTION app.contract_shared_email_prerequisite_origin(p_pin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;binding app.contract_email_prerequisite_origin;
 event public.contract_shared_event;job public.bulk_job;flow public.contract_shared_case;c public.contract_case;person uuid;company uuid;native_system boolean;
BEGIN
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 SELECT * INTO binding FROM app.contract_email_prerequisite_origin WHERE tenant_id=pin.tenant_id AND pin_id=pin.id;
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=binding.tenant_id AND id=binding.origin_event_id;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=binding.tenant_id AND id=binding.job_id;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=pin.tenant_id AND id=pin.case_id;
 SELECT * INTO flow FROM public.contract_shared_case WHERE tenant_id=pin.tenant_id AND case_id=pin.case_id;
 SELECT e.person_id,e.company_id INTO person,company FROM public.employment e WHERE e.tenant_id=pin.tenant_id AND e.id=c.employment_id;
 IF pin.id IS NULL OR binding.pin_id IS NULL OR event.id IS NULL OR event.processed_at IS NOT NULL
 OR event.case_id IS DISTINCT FROM pin.case_id OR event.decision_revision IS DISTINCT FROM pin.decision_revision
 OR event.job_id IS DISTINCT FROM job.id OR coalesce(event.root_event_id,event.id) IS DISTINCT FROM binding.root_event_id
 OR job.input IS DISTINCT FROM jsonb_build_object('eventId',binding.root_event_id)
 OR job.state NOT IN('queued','preparing','finalizing') OR job.cancel_requested_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM app.bulk_job_seal seal WHERE seal.job_id=job.id AND seal.tenant_id=job.tenant_id AND seal.input_digest=app.bulk_job_value_digest(job.input) AND seal.plan_digest=app.bulk_job_value_digest(job.plan))
 OR c.company_id IS DISTINCT FROM pin.company_id OR company IS DISTINCT FROM pin.company_id OR person IS DISTINCT FROM pin.subject_person_id
 OR c.source_conflict IS NOT NULL OR flow.data->'period'->>'sourceRevision' IS DISTINCT FROM pin.source_period_revision
 OR (pin.decision_revision<>0 AND coalesce((flow.data->'decision'->>'revision')::integer,0)<>pin.decision_revision AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(flow.data->'decisionHistory') decision WHERE decision->>'revision'=pin.decision_revision::text))
 OR app.contract_company_entitled(pin.company_id) IS NOT TRUE THEN RETURN NULL;END IF;
 IF event.actor_type='user' THEN
  IF job.kind<>'contract_automation' OR job.created_by IS DISTINCT FROM event.actor_user_id
  OR event.actor_person_id IS DISTINCT FROM app.contract_binding_person(event.actor_user_id) THEN RETURN NULL;END IF;
 ELSIF event.actor_type='system' THEN
  IF job.kind<>'contract_scheduled_automation' OR job.created_by IS NOT NULL OR event.actor_user_id IS NOT NULL OR event.actor_person_id IS NOT NULL THEN RETURN NULL;END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM app.contract_system_job_source source WHERE source.tenant_id=$1 AND source.job_id=$2 AND source.event_id=$3 AND source.case_id=$4 AND source.employment_id=$5 AND source.period_revision=$6 AND source.cause=$7 AND source.input_digest=app.bulk_job_value_digest($8))'
   INTO native_system USING pin.tenant_id,job.id,event.id,pin.case_id,c.employment_id,pin.source_period_revision,event.trigger_event,job.input;
  IF NOT native_system THEN RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 RETURN jsonb_build_object('pinId',pin.id,'caseId',pin.case_id,'runId',pin.workflow_run_id,'stepId',pin.workflow_step_id,
  'eventId',event.id,'letterId',event.data->'letterId','rootEventId',binding.root_event_id,'jobId',job.id,'originType',event.actor_type,'companyId',pin.company_id,
  'personId',pin.subject_person_id,'sourceRevision',pin.source_period_revision,'decisionRevision',pin.decision_revision,'emailId',pin.email_template_id,'emailRevision',pin.email_revision);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_origin(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_origin_held(p_pin uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb;job public.bulk_job;
BEGIN
 origin:=app.contract_shared_email_prerequisite_origin(p_pin);IF origin IS NULL OR app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND id=(origin->>'jobId')::uuid;
 IF job.id::text IS DISTINCT FROM current_setting('app.bulk_job',true) OR job.lease_expires_at<=clock_timestamp() OR app.bulk_job_capability_held(job.id) IS NOT TRUE THEN RETURN false;END IF;
 IF origin->>'originType'='system' THEN RETURN app.contract_shared_system_job_held(job.id);END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_origin_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_state(p_pin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pin public.contract_shared_email_document_step;run public.automation_run;version public.automation_email_template_version;
 origin jsonb;first jsonb;frozen jsonb;template_id text;letter public.contract_shared_letter;signing public.document_signing_document;
 form public.document_form_response;ready jsonb;documents jsonb:='[]'::jsonb;files jsonb;proof jsonb;
BEGIN
 origin:=app.contract_shared_email_prerequisite_origin(p_pin);IF origin IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','source_changed');END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=app.current_tenant_id() AND id=p_pin;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id;
 first:=run.remaining_steps->0;
 SELECT step INTO frozen FROM public.automation_workflow_version v CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') WITH ORDINALITY s(step,n)
 WHERE v.tenant_id=run.tenant_id AND v.workflow_id=run.workflow_id AND v.revision=run.workflow_revision AND n=(first->>'index')::integer+1;
 IF run.module<>'contract_staff' OR run.subject_id IS DISTINCT FROM pin.case_id OR run.status<>'waiting' OR run.waiting_for IS DISTINCT FROM pin.id
 OR run.step_cursor IS DISTINCT FROM (first->>'index')::integer OR first->'step' IS DISTINCT FROM frozen
 OR first->'step'->>'id' IS DISTINCT FROM pin.workflow_step_id OR first->'step'->>'type' IS DISTINCT FROM 'sendEmail'
 OR first->'step'->'params'->>'emailTemplateId' IS DISTINCT FROM pin.email_template_id::text THEN RETURN jsonb_build_object('ready',false,'reason','not_waiting');END IF;
 SELECT * INTO version FROM public.automation_email_template_version WHERE tenant_id=pin.tenant_id AND template_id=pin.email_template_id AND revision=pin.email_revision AND module='contract_staff';
 IF version.template_id IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','template_missing');END IF;
 FOR template_id IN SELECT value#>>'{}' FROM jsonb_array_elements(coalesce(version.document_ids,'[]'::jsonb)) ORDER BY value#>>'{}' LOOP
  SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=pin.tenant_id AND id=(pin.documents->>template_id)::uuid AND case_id=pin.case_id AND decision_revision=pin.decision_revision AND data->>'templateId'=template_id AND data->>'subjectPersonId'=pin.subject_person_id::text;
  IF letter.id IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','document_missing');END IF;
  ready:=app.contract_shared_email_document_readiness(letter.id);
  IF ready->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN ready;END IF;
  SELECT * INTO signing FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
  SELECT * INTO form FROM public.document_form_response WHERE tenant_id=letter.tenant_id AND document_id=letter.signing_document_id;
  documents:=documents||jsonb_build_array(jsonb_build_object('templateId',template_id,'letterId',letter.id,'signingId',signing.id,'revision',signing.revision,
   'signingHash',encode(sha256(convert_to(signing.data::text,'UTF8')),'hex'),'formRevision',form.revision,'formHash',CASE WHEN form.document_id IS NOT NULL THEN encode(sha256(convert_to(jsonb_build_array(form.answers,form.locked_values)::text,'UTF8')),'hex') END));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(version.file_slots,'[]'::jsonb)) slot WHERE slot->'required'='true'::jsonb) THEN
  IF to_regprocedure('app.contract_shared_email_required_files_proof(uuid)') IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','required_files');END IF;
  EXECUTE 'SELECT app.contract_shared_email_required_files_proof($1)' INTO files USING p_pin;
  IF files->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN jsonb_build_object('ready',false,'reason','required_files');END IF;
 ELSE files:=jsonb_build_object('ready',true,'assets','[]'::jsonb);END IF;
 proof:=origin||jsonb_build_object('documents',documents,'files',files);
 RETURN jsonb_build_object('ready',true,'proofHash',encode(sha256(convert_to(proof::text,'UTF8')),'hex'),
  'runHash',encode(sha256(convert_to((to_jsonb(run)-'updated_at')::text,'UTF8')),'hex'),'origin',origin);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_state(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_emit(p_pin uuid,p_actor uuid,p_person uuid,p_observation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;origin jsonb;pin public.contract_shared_email_document_step;existing uuid;created uuid:=gen_random_uuid();signal_hash text;observation app.contract_email_upload_observation;
BEGIN
 IF p_person IS NULL OR p_person IS DISTINCT FROM app.contract_binding_person(p_actor) THEN RETURN NULL;END IF;
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
 -- The real callback actor is independent of the original job principal. Its job/provenance is unchanged.
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
CREATE FUNCTION app.contract_shared_email_prerequisite_signal(p_pin uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN app.contract_shared_email_prerequisite_emit(p_pin,app.current_user_id(),app.contract_actor_person(app.current_user_id()),NULL);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_signal(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The native upload owner calls this AFTER its real authorised write, even on legacy/deduplicated uploads.
-- No PIN/template/document lock is taken here: legacy upload already owns its template lock.
CREATE FUNCTION app.contract_shared_email_prerequisite_observe_upload(p_asset uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE asset public.lc_v9_email_asset;created uuid:=gen_random_uuid();person uuid;
BEGIN
 person:=app.contract_actor_person(app.current_user_id());
 SELECT * INTO asset FROM public.lc_v9_email_asset WHERE tenant_id=app.current_tenant_id() AND id=p_asset;
 IF person IS NULL OR asset.id IS NULL OR asset.automation_module<>'contract_staff' OR asset.kind<>'file' OR asset.shared_subject_id IS NULL OR asset.shared_slot_id IS NULL
 OR app.contract_shared_case_permitted(asset.shared_subject_id,'view') IS NOT TRUE OR app.contract_shared_case_permitted(asset.shared_subject_id,'manual') IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=asset.tenant_id AND f.case_id=asset.shared_subject_id AND f.data->'period'->>'sourceRevision'=asset.shared_source_revision)
 THEN RAISE EXCEPTION 'Actual authorised case-file upload required' USING ERRCODE='42501';END IF;
 INSERT INTO app.contract_email_upload_observation(tenant_id,id,asset_id,actor_user_id,actor_person_id)
 VALUES(asset.tenant_id,created,asset.id,app.current_user_id(),person);
 RETURN created;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_observe_upload(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_observed(p_event uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;pin_id uuid;observation_id uuid;observed app.contract_email_upload_observation;letter_id uuid;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR app.contract_shared_worker_event_held_before_email_recovery(event.case_id,event.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Original workflow authority required' USING ERRCODE='42501';END IF;
 SELECT pin.id,observation.id INTO pin_id,observation_id FROM app.contract_email_prerequisite_origin origin
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=origin.tenant_id AND pin.id=origin.pin_id
 JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.status='waiting' AND run.waiting_for=pin.id
 JOIN public.automation_email_template_version version ON version.tenant_id=pin.tenant_id AND version.template_id=pin.email_template_id AND version.revision=pin.email_revision
 JOIN public.lc_v9_email_asset asset ON asset.tenant_id=pin.tenant_id AND asset.email_template_id=pin.email_template_id::text AND asset.automation_module='contract_staff' AND asset.kind='file'
 AND asset.shared_subject_id=pin.case_id AND asset.shared_source_revision=pin.source_period_revision
 JOIN app.contract_email_upload_observation observation ON observation.tenant_id=asset.tenant_id AND observation.asset_id=asset.id
 WHERE origin.tenant_id=event.tenant_id AND origin.origin_event_id=event.id AND origin.job_id=event.job_id
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(version.file_slots,'[]'::jsonb)) slot WHERE slot->>'id'=asset.shared_slot_id)
 AND NOT EXISTS(SELECT 1 FROM app.contract_email_upload_seen seen WHERE seen.tenant_id=pin.tenant_id AND seen.pin_id=pin.id AND seen.observation_id=observation.id)
 ORDER BY observation.recorded_at,observation.id,pin.id LIMIT 1;
 IF pin_id IS NULL THEN RETURN false;END IF;
 SELECT * INTO observed FROM app.contract_email_upload_observation WHERE tenant_id=event.tenant_id AND id=observation_id;
 PERFORM app.contract_shared_lock_source(event.case_id);
 FOR letter_id IN SELECT value::uuid FROM public.contract_shared_email_document_step pin CROSS JOIN LATERAL jsonb_each_text(pin.documents) WHERE pin.tenant_id=event.tenant_id AND pin.id=pin_id ORDER BY value LOOP PERFORM app.contract_shared_email_document_lock(letter_id);END LOOP;
 PERFORM app.contract_shared_email_prerequisite_lock(pin_id);
 INSERT INTO app.contract_email_upload_seen(tenant_id,pin_id,observation_id) VALUES(event.tenant_id,pin_id,observed.id) ON CONFLICT DO NOTHING;
 PERFORM app.contract_shared_email_prerequisite_emit(pin_id,observed.actor_user_id,observed.actor_person_id,observed.id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_observed(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_event_held(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;receipt app.contract_email_prerequisite_resume;state jsonb;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=event.tenant_id AND event_id=event.id;
 IF receipt.event_id IS NULL OR receipt.completed_at IS NOT NULL OR event.trigger_event<>'emailDocumentReady' OR event.processed_at IS NOT NULL
 OR event.workflow_versions IS DISTINCT FROM '[]'::jsonb OR event.id::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR event.actor_type<>'user' OR event.actor_user_id IS DISTINCT FROM receipt.callback_user_id OR event.actor_person_id IS DISTINCT FROM receipt.callback_person_id
 OR receipt.callback_person_id IS DISTINCT FROM app.contract_binding_person(receipt.callback_user_id)
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
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_worker_event_held(uuid,integer) RENAME TO contract_shared_worker_event_held_before_email_recovery;
CREATE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event='emailDocumentReady' THEN RETURN event.case_id=p_case AND event.decision_revision=p_revision AND app.contract_shared_email_prerequisite_event_held(event.id);END IF;
 RETURN app.contract_shared_worker_event_held_before_email_recovery(p_case,p_revision);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_worker_event_held_before_email_recovery(uuid,integer),app.contract_shared_worker_event_held(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.contract_shared_effect_held(uuid,uuid,text,text) RENAME TO contract_shared_effect_held_before_email_recovery;
CREATE FUNCTION app.contract_shared_effect_held(p_case uuid,p_run uuid,p_step text,p_type text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event='emailDocumentReady' THEN
  RETURN p_type='sendEmail' AND event.case_id=p_case AND event.data->>'runId'=p_run::text AND event.data->>'stepId'=p_step
   AND app.contract_shared_email_prerequisite_event_held(event.id);
 END IF;
 RETURN app.contract_shared_effect_held_before_email_recovery(p_case,p_run,p_step,p_type);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_effect_held_before_email_recovery(uuid,uuid,text,text),app.contract_shared_effect_held(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The ordinary run owner still writes progress. Its extra internal-event boundary permits exactly ONE step.
CREATE FUNCTION app.contract_shared_email_prerequisite_run_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;receipt app.contract_email_prerequisite_resume;pin public.contract_shared_email_document_step;first jsonb;tail jsonb;extra jsonb;expected_status text;added integer;preserved integer;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event IS DISTINCT FROM 'emailDocumentReady' THEN RETURN NEW;END IF;
 IF app.contract_shared_email_prerequisite_event_held(event.id) IS NOT TRUE THEN RAISE EXCEPTION 'Exact held email completion required' USING ERRCODE='42501';END IF;
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=event.tenant_id AND event_id=event.id;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id;
 first:=OLD.remaining_steps->0;tail:=OLD.remaining_steps-0;expected_status:=CASE WHEN jsonb_array_length(tail)=0 THEN 'done' ELSE 'running' END;
 added:=CASE WHEN expected_status='done' THEN 2 ELSE 1 END;preserved:=least(jsonb_array_length(OLD.log),200-added);
 SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) INTO extra FROM jsonb_array_elements(NEW.log) WITH ORDINALITY x(value,n) WHERE n>preserved;
 IF OLD.tenant_id IS DISTINCT FROM event.tenant_id OR OLD.id IS DISTINCT FROM pin.workflow_run_id OR OLD.status<>'waiting' OR OLD.waiting_for IS DISTINCT FROM pin.id
 OR NEW.status IS DISTINCT FROM expected_status OR NEW.waiting_for IS NOT NULL OR NEW.remaining_steps IS DISTINCT FROM tail
 OR NEW.step_cursor IS DISTINCT FROM (first->>'index')::integer+1 OR NEW.failure IS NOT NULL
 OR (to_jsonb(NEW)-ARRAY['status','step_cursor','waiting_for','remaining_steps','log','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','step_cursor','waiting_for','remaining_steps','log','updated_at'])
 OR jsonb_array_length(NEW.log)<>preserved+added
 OR (SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(NEW.log) WITH ORDINALITY x(value,n) WHERE n<=preserved) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(OLD.log) WITH ORDINALITY x(value,n) WHERE n>jsonb_array_length(OLD.log)-preserved)
 OR extra->0->>'kind' IS DISTINCT FROM 'stepDone' OR extra->0->>'stepId' IS DISTINCT FROM pin.workflow_step_id OR extra->0->>'type' IS DISTINCT FROM 'sendEmail'
 OR (expected_status='done' AND extra->1->>'kind' IS DISTINCT FROM 'done')
 OR NOT EXISTS(SELECT 1 FROM public.automation_email_delivery delivery WHERE delivery.tenant_id=pin.tenant_id AND delivery.module='contract_staff' AND delivery.subject_id=pin.case_id AND regexp_replace(delivery.mail_key,':[0-9]+$','')=pin.workflow_run_id::text||':'||pin.workflow_step_id)
 THEN RAISE EXCEPTION 'An email recovery can consume only its actual queued Send email step' USING ERRCODE='42501';END IF;
 UPDATE app.contract_email_prerequisite_resume SET completed_at=now(),continued_at=CASE WHEN expected_status='done' THEN now() END,
  result_run_hash=encode(sha256(convert_to((to_jsonb(NEW)-'updated_at')::text,'UTF8')),'hex') WHERE tenant_id=receipt.tenant_id AND event_id=receipt.event_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_run_progress() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_email_recovery_one_step BEFORE UPDATE ON public.automation_run FOR EACH ROW EXECUTE FUNCTION app.contract_shared_email_prerequisite_run_progress();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_begin(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_prerequisite_resume;pin public.contract_shared_email_document_step;letter_id uuid;state jsonb;run public.automation_run;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=app.current_tenant_id() AND event_id=p_event;
 IF receipt.event_id IS NULL OR app.contract_shared_email_prerequisite_origin_held(receipt.pin_id) IS NOT TRUE
 OR p_event::text IS DISTINCT FROM current_setting('app.contract_event',true) THEN RAISE EXCEPTION 'Original held email job required' USING ERRCODE='42501';END IF;
 IF receipt.completed_at IS NOT NULL THEN RETURN jsonb_build_object('ready',false,'completed',true);END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id;
 PERFORM app.contract_shared_lock_source(pin.case_id);
 FOR letter_id IN SELECT value::uuid FROM jsonb_each_text(pin.documents) ORDER BY value LOOP PERFORM app.contract_shared_email_document_lock(letter_id);END LOOP;
 PERFORM app.contract_shared_email_prerequisite_lock(pin.id);
 IF app.contract_shared_email_prerequisite_event_held(p_event) IS NOT TRUE THEN RETURN jsonb_build_object('ready',false,'completed',false);END IF;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id;
 RETURN jsonb_build_object('ready',true,'completed',false,'run',to_jsonb(run),'pinId',pin.id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_begin(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_finish(p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_prerequisite_resume;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=app.current_tenant_id() AND event_id=p_event;
 IF receipt.event_id IS NULL OR app.contract_shared_email_prerequisite_origin_held(receipt.pin_id) IS NOT TRUE
 OR p_event::text IS DISTINCT FROM current_setting('app.contract_event',true) THEN RAISE EXCEPTION 'Original held email job required' USING ERRCODE='42501';END IF;
 UPDATE public.contract_shared_event SET processed_at=now(),error=CASE WHEN receipt.completed_at IS NULL THEN 'The prerequisites changed; the same email step remains waiting.' END
 WHERE tenant_id=receipt.tenant_id AND id=receipt.event_id AND trigger_event='emailDocumentReady';
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_finish(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only the ordinary ORIGINAL event/capability may consume the untouched tail after the email receipt.
CREATE FUNCTION app.contract_shared_email_prerequisite_continuation(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;receipt app.contract_email_prerequisite_resume;run public.automation_run;waiting boolean;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR app.contract_shared_worker_event_held_before_email_recovery(event.case_id,event.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Original workflow authority required' USING ERRCODE='42501';END IF;
 SELECT r.* INTO receipt FROM app.contract_email_prerequisite_resume r JOIN app.contract_email_prerequisite_origin origin ON origin.tenant_id=r.tenant_id AND origin.pin_id=r.pin_id
 WHERE r.tenant_id=event.tenant_id AND origin.origin_event_id=event.id AND origin.job_id=event.job_id AND r.completed_at IS NOT NULL AND r.continued_at IS NULL ORDER BY r.completed_at,r.event_id LIMIT 1;
 IF receipt.event_id IS NOT NULL THEN
  SELECT runrow.* INTO run FROM public.automation_run runrow JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=runrow.tenant_id AND pin.workflow_run_id=runrow.id
  WHERE pin.tenant_id=receipt.tenant_id AND pin.id=receipt.pin_id;
  IF app.contract_shared_email_prerequisite_origin_held(receipt.pin_id) IS NOT TRUE OR run.status<>'running'
  OR receipt.result_run_hash IS DISTINCT FROM encode(sha256(convert_to((to_jsonb(run)-'updated_at')::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'The completed email continuation changed' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('waiting',false,'receiptId',receipt.event_id,'run',to_jsonb(run));
 END IF;
 SELECT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin origin JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=origin.tenant_id AND pin.id=origin.pin_id
 JOIN public.automation_run runrow ON runrow.tenant_id=pin.tenant_id AND runrow.id=pin.workflow_run_id AND runrow.status='waiting' AND runrow.waiting_for=pin.id
 WHERE origin.tenant_id=event.tenant_id AND origin.origin_event_id=event.id AND origin.job_id=event.job_id) INTO waiting;
 IF waiting AND app.contract_shared_email_prerequisite_observed(p_event) THEN RETURN jsonb_build_object('waiting',false,'observed',true);END IF;
 RETURN jsonb_build_object('waiting',waiting);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_continuation(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_continued(p_receipt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_prerequisite_resume;origin app.contract_email_prerequisite_origin;event public.contract_shared_event;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=app.current_tenant_id() AND event_id=p_receipt;
 SELECT * INTO origin FROM app.contract_email_prerequisite_origin WHERE tenant_id=receipt.tenant_id AND pin_id=receipt.pin_id;
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=origin.tenant_id AND id=origin.origin_event_id;
 IF receipt.completed_at IS NULL OR event.id::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR app.contract_shared_email_prerequisite_origin_held(receipt.pin_id) IS NOT TRUE
 OR app.contract_shared_worker_event_held_before_email_recovery(event.case_id,event.decision_revision) IS NOT TRUE THEN RAISE EXCEPTION 'Original continuation authority required' USING ERRCODE='42501';END IF;
 UPDATE app.contract_email_prerequisite_resume SET continued_at=now() WHERE tenant_id=receipt.tenant_id AND event_id=receipt.event_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_continued(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_prerequisite_document_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;pin_id uuid;
BEGIN
 IF TG_TABLE_NAME='document_signing_document' THEN
  IF NEW.subject_type<>'contract' OR NEW.data IS NOT DISTINCT FROM OLD.data THEN RETURN NEW;END IF;
  SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND signing_document_id=NEW.id AND id=NEW.subject_id;
 ELSE
  IF NEW.answers IS NOT DISTINCT FROM OLD.answers AND NEW.locked_values IS NOT DISTINCT FROM OLD.locked_values THEN RETURN NEW;END IF;
  SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=NEW.tenant_id AND signing_document_id=NEW.document_id;
 END IF;
 IF letter.id IS NULL OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE THEN RETURN NEW;END IF;
 FOR pin_id IN SELECT pin.id FROM public.contract_shared_email_document_step pin JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id
 WHERE pin.tenant_id=letter.tenant_id AND pin.case_id=letter.case_id AND pin.documents @> jsonb_build_object(letter.data->>'templateId',letter.id::text)
 AND run.status='waiting' AND run.waiting_for=pin.id ORDER BY pin.id
 LOOP PERFORM app.contract_shared_email_prerequisite_signal(pin_id);END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_document_progress() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER zzzz_contract_email_prerequisite_document AFTER UPDATE OF data ON public.document_signing_document FOR EACH ROW EXECUTE FUNCTION app.contract_shared_email_prerequisite_document_progress();
CREATE TRIGGER zzzz_contract_email_prerequisite_form AFTER UPDATE OF answers,locked_values ON public.document_form_response FOR EACH ROW EXECUTE FUNCTION app.contract_shared_email_prerequisite_document_progress();
