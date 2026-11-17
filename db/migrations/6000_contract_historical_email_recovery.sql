-- INACTIVE5980 REVIEW SOURCE. UNREGISTERED, UNAPPLIED. No new application grants.
-- Extend the canonical5960 owner; retain5968 cached-OID dispatchers and5957 sender capabilities.
-- No payload markers, alternate SMTP engine, impersonated principal, or parallel run owner.
ALTER TABLE public.contract_shared_event ADD COLUMN email_reconciliation jsonb;
ALTER TABLE public.contract_shared_posting ADD COLUMN after_period_revision text;
ALTER TABLE app.contract_email_prerequisite_resume ADD COLUMN disposition text,
 ADD COLUMN begun_xid bigint,ADD COLUMN begun_backend integer,ADD COLUMN begun_login text;
CREATE TABLE app.contract_email_delivery_receipt(
 tenant_id uuid NOT NULL,delivery_id uuid PRIMARY KEY REFERENCES public.automation_email_delivery(id),
 event_id uuid NOT NULL,pin_id uuid NOT NULL,job_id uuid NOT NULL,original_event_id uuid NOT NULL,root_event_id uuid NOT NULL,
 callback_user_id uuid NOT NULL,callback_person_id uuid NOT NULL,payload_hash bytea NOT NULL,
 input_digest bytea NOT NULL,operation_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,event_id) REFERENCES app.contract_email_prerequisite_resume(tenant_id,event_id),
 FOREIGN KEY(tenant_id,pin_id) REFERENCES app.contract_email_prerequisite_origin(tenant_id,pin_id));
ALTER TABLE app.contract_email_delivery_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_email_delivery_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_email_delivery_receipt_owner ON app.contract_email_delivery_receipt FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_email_delivery_receipt FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON app.contract_email_delivery_receipt TO ai_hr_owner;

--> statement-breakpoint
-- This is source-period provenance, not permission to run the old business suffix.
-- Reach only immutable native committed posting-period edges from the original pin to CURRENT.
-- Missing legacy provenance and manual drift cannot manufacture an edge.
CREATE FUNCTION app.contract_shared_email_recovery_source(p_tenant uuid,p_pin uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_email_document_step pin
 JOIN app.contract_email_prerequisite_origin binding ON binding.tenant_id=pin.tenant_id AND binding.pin_id=pin.id
 JOIN public.contract_shared_event original ON original.tenant_id=binding.tenant_id AND original.id=binding.origin_event_id
 JOIN public.bulk_job job ON job.tenant_id=binding.tenant_id AND job.id=binding.job_id
 JOIN public.contract_case c ON c.tenant_id=pin.tenant_id AND c.id=pin.case_id
 JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.person_id=pin.subject_person_id AND e.company_id=pin.company_id
 JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id AND co.archived_at IS NULL

 WHERE pin.tenant_id=p_tenant AND pin.id=p_pin AND c.company_id=pin.company_id AND c.source_conflict IS NULL
 AND f.data->'period'->>'sourceRevision'=pin.source_period_revision AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
 AND app.contract_company_entitled(p_tenant,pin.company_id) AND app.contract_shared_native_intake_hold(p_tenant,e.id) IS NULL
 AND original.case_id=pin.case_id AND original.decision_revision=pin.decision_revision AND original.job_id=job.id
 AND coalesce(original.root_event_id,original.id)=binding.root_event_id AND job.operation_key=binding.root_event_id
 AND job.cancel_requested_at IS NULL AND job.state<>'cancelled'
 AND ((original.actor_type='user' AND job.kind='contract_automation' AND job.created_by=original.actor_user_id
  AND EXISTS(SELECT 1 FROM public.app_user actor JOIN public.person person ON person.tenant_id=actor.tenant_id AND person.id=actor.person_id
   WHERE actor.tenant_id=p_tenant AND actor.id=original.actor_user_id AND actor.person_id=original.actor_person_id
   AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id) AND length(btrim(person.full_name))>0))
 OR (original.actor_type='system' AND original.actor_user_id IS NULL AND original.actor_person_id IS NULL
  AND job.kind='contract_scheduled_automation' AND job.created_by IS NULL AND job.context=jsonb_build_object('tenantId',p_tenant,'roles','[]'::jsonb)
  AND EXISTS(SELECT 1 FROM app.contract_system_job_source s WHERE s.tenant_id=p_tenant AND s.job_id=job.id AND s.event_id=original.id
   AND s.kind=job.kind AND s.case_id=pin.case_id AND s.employment_id=e.id AND s.period_revision=pin.source_period_revision AND s.cause=original.trigger_event
   AND s.source_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))
 AND (app.contract_shared_delivery_period_current(p_tenant,pin.case_id) OR (e.terminated_on IS NULL AND e.resignation_date IS NULL AND e.last_working_date IS NULL AND EXISTS(
  -- Reachability of native committed receipt edges is provenance only. UNION deduplicates each
  -- revision/depth state, so many paths cannot multiply recursively; depth64 bounds cyclic input.
  WITH RECURSIVE periods(revision,depth) AS (
   SELECT pin.source_period_revision,0
   UNION
   SELECT receipt.after_period_revision,path.depth+1
   FROM periods path JOIN public.contract_shared_posting receipt ON receipt.tenant_id=p_tenant
    AND receipt.subject_person_id=pin.subject_person_id AND receipt.source_revision=path.revision AND receipt.after_period_revision IS NOT NULL
   JOIN public.personnel_posting posting ON posting.tenant_id=receipt.tenant_id AND posting.id=receipt.posting_id
   JOIN public.contract_case posted_case ON posted_case.tenant_id=receipt.tenant_id AND posted_case.id=receipt.case_id
   JOIN public.contract_shared_case posted_flow ON posted_flow.tenant_id=posted_case.tenant_id AND posted_flow.case_id=posted_case.id
   WHERE path.depth<64 AND receipt.after_period_revision<>path.revision
    AND receipt.applied_at IS NOT NULL AND receipt.movement_group_id IS NOT NULL
    AND posting.source='contract_staff' AND posting.source_ref=posted_case.id AND posting.employment_id=e.id
    AND posting.company_id=pin.company_id AND posted_case.employment_id=e.id AND posted_case.company_id=pin.company_id
    AND posted_flow.data->'period'->>'sourceRevision'=receipt.source_revision
    AND posting.status='approved' AND posting.approved_by IS NOT NULL AND posting.approved_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.domain_event movement WHERE movement.tenant_id=p_tenant AND movement.subject_employment_id=e.id
     AND movement.payload->'movement'->>'groupId'=receipt.movement_group_id::text
     AND movement.payload->'movement'->>'type'=CASE posting.event_type WHEN 'contractConversion' THEN 'employmentTypeChange' WHEN 'contractRenewal' THEN 'contractRenewal' END)
  ) SELECT 1 FROM periods WHERE depth>0 AND revision=app.contract_shared_period_revision(p_tenant,e.id)))) )
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_recovery_source(uuid,uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_origin(p_pin uuid) RETURNS jsonb
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
 OR app.contract_company_entitled(pin.company_id) IS NOT TRUE OR app.contract_shared_email_recovery_source(pin.tenant_id,pin.id) IS NOT TRUE THEN RETURN NULL;END IF;
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
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_recovery_frame(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_storage_runner() AND p_job::text=current_setting('app.bulk_job',true) AND app.bulk_job_capability_held(p_job)
 AND EXISTS(SELECT 1 FROM public.bulk_job j JOIN app.bulk_job_seal seal ON seal.tenant_id=j.tenant_id AND seal.job_id=j.id
 JOIN app.contract_email_prerequisite_origin binding ON binding.tenant_id=j.tenant_id AND binding.job_id=j.id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
 JOIN public.contract_shared_event original ON original.tenant_id=binding.tenant_id AND original.id=binding.origin_event_id
 WHERE j.tenant_id=app.current_tenant_id() AND j.id=p_job AND j.kind IN('contract_automation','contract_scheduled_automation')
 AND j.state='finalizing' AND j.cancel_requested_at IS NULL AND j.lease_expires_at>clock_timestamp()
 AND j.input=jsonb_build_object('eventId',binding.root_event_id) AND j.operation_key=binding.root_event_id
 AND seal.input_digest=app.bulk_job_value_digest(j.input) AND seal.plan_digest=app.bulk_job_value_digest(j.plan)
 AND original.case_id=pin.case_id AND original.decision_revision=pin.decision_revision AND original.job_id=j.id
 AND coalesce(original.root_event_id,original.id)=binding.root_event_id
 AND ((original.actor_type='user' AND j.kind='contract_automation' AND j.created_by=original.actor_user_id
  AND app.contract_verified_human(original.actor_user_id) AND app.contract_binding_person(original.actor_user_id)=original.actor_person_id)
 OR (original.actor_type='system' AND original.actor_user_id IS NULL AND original.actor_person_id IS NULL AND j.kind='contract_scheduled_automation'
  AND j.created_by IS NULL AND j.context=jsonb_build_object('tenantId',j.tenant_id,'roles','[]'::jsonb)
  AND EXISTS(SELECT 1 FROM app.contract_system_job_source s WHERE s.tenant_id=j.tenant_id AND s.job_id=j.id AND s.kind=j.kind
   AND s.event_id=original.id AND s.case_id=pin.case_id AND s.employment_id=(SELECT employment_id FROM public.contract_case WHERE tenant_id=pin.tenant_id AND id=pin.case_id)
   AND s.period_revision=pin.source_period_revision AND s.cause=original.trigger_event AND s.input_digest=seal.input_digest AND s.source_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_recovery_frame(uuid) FROM PUBLIC,ai_hr_app;
-- Retain the strict5935 body for ordinary workers. Only the kernel's technical recovery admission gains an alternative.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_shared_system_job_held(uuid)'::regprocedure),'app.contract_shared_system_job_held(', 'app.contract_shared_system_job_held_current(');
 IF position('app.contract_shared_system_job_held(' in pg_get_functiondef('app.contract_shared_worker_event_held_recovery_base(uuid,integer)'::regprocedure))=0 THEN RAISE EXCEPTION 'Expected strict5968 system dispatch body before5980';END IF;
 EXECUTE replace(pg_get_functiondef('app.contract_shared_worker_event_held_recovery_base(uuid,integer)'::regprocedure),
  'app.contract_shared_system_job_held(', 'app.contract_shared_system_job_held_current(');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_system_job_held_current(uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_system_job_held(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_system_job_held_current(p_job) OR (EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=p_job AND j.kind='contract_scheduled_automation' AND j.created_by IS NULL)
 AND app.contract_shared_email_recovery_frame(p_job))
$$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_email_recovery_disposition(p_pin uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb;cursor_proof jsonb;saved text:=current_setting('app.contract_event',true);allowed boolean;
BEGIN
 origin:=app.contract_shared_email_prerequisite_origin(p_pin);
 IF origin IS NULL THEN RETURN 'stopped';END IF;
 cursor_proof:=app.contract_shared_email_event_cursor((origin->>'eventId')::uuid);
 IF cursor_proof->'known' IS DISTINCT FROM 'true'::jsonb THEN RETURN 'legacy_cursor_unknown';END IF;
 BEGIN
  PERFORM set_config('app.contract_event',origin->>'eventId',true);
  allowed:=app.contract_shared_worker_event_held_recovery_base((origin->>'caseId')::uuid,(origin->>'decisionRevision')::integer);
  IF origin->>'originType'='system' AND EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=(origin->>'caseId')::uuid AND coalesce(f.data->'decision'->>'revision','0') IS DISTINCT FROM origin->>'decisionRevision') THEN allowed:=false;END IF;
  PERFORM set_config('app.contract_event',coalesce(saved,''),true);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.contract_event',coalesce(saved,''),true);RAISE;END;
 RETURN CASE WHEN allowed THEN 'current' ELSE 'authority_changed' END;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_recovery_disposition(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_origin_held(p_pin uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb;job public.bulk_job;
BEGIN
 origin:=app.contract_shared_email_prerequisite_origin(p_pin);IF origin IS NULL OR app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND id=(origin->>'jobId')::uuid;
 IF job.id::text IS DISTINCT FROM current_setting('app.bulk_job',true) OR job.lease_expires_at<=clock_timestamp() OR app.bulk_job_capability_held(job.id) IS NOT TRUE THEN RETURN false;END IF;
 IF origin->>'originType'='system' THEN RETURN app.contract_shared_email_recovery_frame(job.id);END IF;
 RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_begin(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_prerequisite_resume;pin public.contract_shared_email_document_step;letter_id uuid;state jsonb;run public.automation_run;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=app.current_tenant_id() AND event_id=p_event;
 IF receipt.event_id IS NULL OR app.contract_shared_email_recovery_frame((SELECT job_id FROM app.contract_email_prerequisite_origin WHERE tenant_id=receipt.tenant_id AND pin_id=receipt.pin_id)) IS NOT TRUE
 OR p_event::text IS DISTINCT FROM current_setting('app.contract_event',true) THEN RAISE EXCEPTION 'Original held email job required' USING ERRCODE='42501';END IF;
 IF receipt.completed_at IS NOT NULL THEN RETURN jsonb_build_object('ready',false,'completed',true);END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id;
 PERFORM app.contract_shared_lock_source(pin.case_id);
 FOR letter_id IN SELECT value::uuid FROM jsonb_each_text(pin.documents) ORDER BY value LOOP PERFORM app.contract_shared_email_document_lock(letter_id);END LOOP;
 PERFORM app.contract_shared_email_prerequisite_lock(pin.id);
 IF app.contract_shared_email_prerequisite_event_held(p_event) IS NOT TRUE THEN RETURN jsonb_build_object('ready',false,'completed',false);END IF;
 UPDATE app.contract_email_prerequisite_resume SET disposition=app.contract_shared_email_recovery_disposition(pin.id),begun_xid=txid_current(),begun_backend=pg_backend_pid(),begun_login=session_user WHERE tenant_id=receipt.tenant_id AND event_id=p_event;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id;
 RETURN jsonb_build_object('ready',true,'completed',false,'run',to_jsonb(run),'pinId',pin.id,'disposition',app.contract_shared_email_recovery_disposition(pin.id));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_run_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;receipt app.contract_email_prerequisite_resume;pin public.contract_shared_email_document_step;first jsonb;tail jsonb;extra jsonb;expected_status text;added integer;preserved integer;mode text;binding app.contract_email_prerequisite_origin;job public.bulk_job;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 IF event.trigger_event IS DISTINCT FROM 'emailDocumentReady' THEN RETURN NEW;END IF;
 IF app.contract_shared_email_prerequisite_event_held(event.id) IS NOT TRUE THEN RAISE EXCEPTION 'Exact held email completion required' USING ERRCODE='42501';END IF;
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=event.tenant_id AND event_id=event.id;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id;
 IF receipt.begun_xid IS DISTINCT FROM txid_current() OR receipt.begun_backend IS DISTINCT FROM pg_backend_pid() OR receipt.begun_login IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'Begin the exact native email recovery in this transaction' USING ERRCODE='42501';END IF;
 mode:=app.contract_shared_email_recovery_disposition(pin.id);IF mode='stopped' OR mode IS DISTINCT FROM receipt.disposition THEN RAISE EXCEPTION 'Email source disposition changed' USING ERRCODE='40001';END IF;
 first:=OLD.remaining_steps->0;tail:=OLD.remaining_steps-0;expected_status:=CASE WHEN jsonb_array_length(tail)=0 THEN 'done' WHEN mode IN('authority_changed','legacy_cursor_unknown') THEN 'failed' ELSE 'running' END;
 added:=CASE WHEN expected_status IN('done','failed') THEN 2 ELSE 1 END;preserved:=least(jsonb_array_length(OLD.log),200-added);
 SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) INTO extra FROM jsonb_array_elements(NEW.log) WITH ORDINALITY x(value,n) WHERE n>preserved;
 IF OLD.tenant_id IS DISTINCT FROM event.tenant_id OR OLD.id IS DISTINCT FROM pin.workflow_run_id OR OLD.status<>'waiting' OR OLD.waiting_for IS DISTINCT FROM pin.id
 OR NEW.status IS DISTINCT FROM expected_status OR NEW.waiting_for IS NOT NULL OR NEW.remaining_steps IS DISTINCT FROM tail
 OR NEW.step_cursor IS DISTINCT FROM (first->>'index')::integer+1 OR NEW.failure IS DISTINCT FROM (CASE WHEN expected_status='failed' THEN CASE WHEN mode='legacy_cursor_unknown' THEN 'Original workflow progress needs reconciliation; remaining steps stopped.' ELSE 'Original workflow authority changed; remaining steps stopped.' END ELSE NULL::text END)
 OR (to_jsonb(NEW)-ARRAY['status','step_cursor','waiting_for','remaining_steps','log','failure','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','step_cursor','waiting_for','remaining_steps','log','failure','updated_at'])
 OR jsonb_array_length(NEW.log)<>preserved+added
 OR (SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(NEW.log) WITH ORDINALITY x(value,n) WHERE n<=preserved) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(OLD.log) WITH ORDINALITY x(value,n) WHERE n>jsonb_array_length(OLD.log)-preserved)
 OR extra->0->>'kind' IS DISTINCT FROM 'stepDone' OR extra->0->>'stepId' IS DISTINCT FROM pin.workflow_step_id OR extra->0->>'type' IS DISTINCT FROM 'sendEmail'
 OR (expected_status IN('done','failed') AND extra->1->>'kind' IS DISTINCT FROM expected_status)
 OR NOT EXISTS(SELECT 1 FROM public.automation_email_delivery delivery WHERE delivery.tenant_id=pin.tenant_id AND delivery.module='contract_staff' AND delivery.subject_id=pin.case_id AND regexp_replace(delivery.mail_key,':[0-9]+$','')=pin.workflow_run_id::text||':'||pin.workflow_step_id)
 THEN RAISE EXCEPTION 'An email recovery can consume only its actual queued Send email step' USING ERRCODE='42501';END IF;
 SELECT * INTO binding FROM app.contract_email_prerequisite_origin WHERE tenant_id=pin.tenant_id AND pin_id=pin.id;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=binding.tenant_id AND id=binding.job_id;
 IF EXISTS(SELECT 1 FROM public.automation_email_delivery d WHERE d.tenant_id=pin.tenant_id AND d.module='contract_staff' AND d.subject_id=pin.case_id
  AND regexp_replace(d.mail_key,':[0-9]+$','')=pin.workflow_run_id::text||':'||pin.workflow_step_id
  AND (d.payload->'context'->>'eventId' IS DISTINCT FROM event.id::text OR d.payload->'mail'->>'templateId' IS DISTINCT FROM pin.email_template_id::text
   OR d.payload->'mail'->>'templateRevision' IS DISTINCT FROM pin.email_revision::text)) THEN RAISE EXCEPTION 'Exact frozen email delivery required' USING ERRCODE='42501';END IF;
 INSERT INTO app.contract_email_delivery_receipt(tenant_id,delivery_id,event_id,pin_id,job_id,original_event_id,root_event_id,callback_user_id,callback_person_id,payload_hash,input_digest,operation_key)
 SELECT d.tenant_id,d.id,event.id,pin.id,job.id,binding.origin_event_id,binding.root_event_id,receipt.callback_user_id,receipt.callback_person_id,
  sha256(convert_to(d.payload::text,'UTF8')),app.bulk_job_value_digest(job.input),job.operation_key
 FROM public.automation_email_delivery d WHERE d.tenant_id=pin.tenant_id AND d.module='contract_staff' AND d.subject_id=pin.case_id
  AND regexp_replace(d.mail_key,':[0-9]+$','')=pin.workflow_run_id::text||':'||pin.workflow_step_id;
 UPDATE app.contract_email_prerequisite_resume SET completed_at=now(),continued_at=CASE WHEN expected_status IN('done','failed') THEN now() END,
  result_run_hash=encode(sha256(convert_to((to_jsonb(NEW)-'updated_at')::text,'UTF8')),'hex') WHERE tenant_id=receipt.tenant_id AND event_id=receipt.event_id;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_delivery_eligible(p_delivery uuid,p_tenant uuid,p_case uuid,p_context jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.contract_email_delivery_receipt;d public.automation_email_delivery;job public.bulk_job;callback public.app_user;
BEGIN
 SELECT * INTO r FROM app.contract_email_delivery_receipt WHERE delivery_id=p_delivery AND tenant_id=p_tenant;
 IF r.delivery_id IS NULL THEN RETURN app.contract_shared_delivery_eligible(p_tenant,p_case,p_context);END IF;
 SELECT * INTO d FROM public.automation_email_delivery WHERE id=p_delivery AND tenant_id=p_tenant;
 SELECT * INTO job FROM public.bulk_job WHERE id=r.job_id AND tenant_id=r.tenant_id;
 SELECT * INTO callback FROM public.app_user WHERE tenant_id=r.tenant_id AND id=r.callback_user_id;
 RETURN d.module='contract_staff' AND d.subject_id=p_case AND d.payload->'context'=p_context
 AND sha256(convert_to(d.payload::text,'UTF8'))=r.payload_hash AND job.operation_key=r.operation_key AND job.cancel_requested_at IS NULL AND job.state<>'cancelled'
 AND r.input_digest=app.bulk_job_value_digest(jsonb_build_object('eventId',r.root_event_id))
 AND callback.person_id=r.callback_person_id AND callback.archived_at IS NULL AND NOT app.login_blocked(callback.id)
 AND EXISTS(SELECT 1 FROM public.person p WHERE p.tenant_id=r.tenant_id AND p.id=callback.person_id AND length(btrim(p.full_name))>0)
 AND EXISTS(SELECT 1 FROM app.contract_email_prerequisite_resume receipt JOIN app.contract_email_prerequisite_origin binding ON binding.tenant_id=receipt.tenant_id AND binding.pin_id=receipt.pin_id
  JOIN public.contract_shared_event event ON event.tenant_id=receipt.tenant_id AND event.id=receipt.event_id
  WHERE receipt.tenant_id=r.tenant_id AND receipt.event_id=r.event_id AND receipt.pin_id=r.pin_id AND receipt.completed_at IS NOT NULL
  AND receipt.callback_user_id=r.callback_user_id AND receipt.callback_person_id=r.callback_person_id AND event.trigger_event='emailDocumentReady'
  AND event.actor_user_id=r.callback_user_id AND event.actor_person_id=r.callback_person_id AND event.job_id=r.job_id
  AND binding.job_id=r.job_id AND binding.origin_event_id=r.original_event_id AND binding.root_event_id=r.root_event_id)
 AND app.contract_shared_email_recovery_source(r.tenant_id,r.pin_id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_delivery_eligible(uuid,uuid,uuid,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_target_before_template_tests(p_id uuid, p_token uuid, p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND app.contract_shared_delivery_eligible(job.id,job.tenant_id,job.subject_id,job.payload->'context') IS NOT TRUE THEN RETURN NULL;END IF;
  recipients := coalesce(job.payload->'mail'->'to', '[]'::jsonb) || coalesce(job.payload->'mail'->'cc', '[]'::jsonb);
  SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
  SELECT jsonb_agg(jsonb_build_object('userId', r.uid, 'subject', identity.subject, 'issuer', identity.issuer) ORDER BY r.ordinality)
    INTO bindings
    FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid, ordinality)
    JOIN public.app_user u ON u.id::text = r.uid AND u.tenant_id = job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.issuer = p_origin || '/auth/' || job.tenant_id::text AND identity.revoked_at IS NULL AND (job.module<>'contract_staff' OR u.person_id::text=job.payload->'context'->'recipientPeople'->>u.id::text);
  bindings := coalesce(bindings, '[]'::jsonb);
  IF total < 1 OR jsonb_array_length(bindings) <> total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b) <> total THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND nullif(job.payload->'context'->>'approvalId','') IS NOT NULL AND EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(recipients) recipient WHERE NOT EXISTS(
      SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
      CROSS JOIN LATERAL app.document_signing_pending_steps(signing.data) pending
      WHERE approval.tenant_id=job.tenant_id AND approval.case_id=job.subject_id AND approval.id::text=job.payload->'context'->>'approvalId'
      AND app.contract_shared_approval_eligible_user(approval.tenant_id,approval.id,pending->>'id',recipient::uuid))) THEN RETURN NULL;END IF;
  IF job.module='contract_staff' THEN
    job.payload:=jsonb_set(job.payload,'{linkPath}',to_jsonb(app.contract_shared_delivery_link(job.tenant_id,job.subject_id,(job.payload->'mail'->'to'->>0)::uuid,job.payload->'context')));
  END IF;
  RETURN jsonb_build_object('id', job.id, 'tenantId', job.tenant_id, 'module', job.module, 'subjectId', job.subject_id, 'payload', job.payload, 'bindings', bindings);
END $$;
--> statement-breakpoint
-- Technical original-event disposition. This cannot construct executors or consume any business suffix.
CREATE FUNCTION app.contract_shared_email_recovery_original(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;waiting boolean;cursor_proof jsonb;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id WHERE binding.tenant_id=event.tenant_id AND binding.job_id=event.job_id AND pin.case_id=event.case_id AND binding.root_event_id=coalesce(event.root_event_id,event.id))
 THEN RETURN jsonb_build_object('handled',false);END IF;
 cursor_proof:=app.contract_shared_email_event_cursor(event.id);
 IF cursor_proof->'known'='true'::jsonb AND app.contract_shared_worker_event_held_recovery_base(event.case_id,event.decision_revision) AND NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding WHERE binding.tenant_id=event.tenant_id AND binding.job_id=event.job_id AND app.contract_shared_email_recovery_disposition(binding.pin_id)<>'current') THEN RETURN jsonb_build_object('handled',false);END IF;
 IF app.contract_shared_email_recovery_frame(event.job_id) IS NOT TRUE THEN RAISE EXCEPTION 'Actual original email job required' USING ERRCODE='42501';END IF;
 IF app.contract_shared_email_stop_completed_tail(event.id) THEN
  PERFORM app.contract_shared_email_retain_unattempted(event.id);
  RETURN jsonb_build_object('handled',true,'waiting',false,'reconciliationNeeded',true,'reason',CASE WHEN cursor_proof->'known'='true'::jsonb THEN 'authority_changed' ELSE 'legacy_cursor_unknown' END);
 END IF;
 PERFORM app.contract_shared_email_retain_unattempted(event.id);
 IF app.contract_shared_email_prerequisite_observed(event.id) THEN RETURN jsonb_build_object('handled',true,'waiting',false);END IF;
 SELECT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
  JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.status='waiting' AND run.waiting_for=pin.id
  WHERE binding.tenant_id=event.tenant_id AND binding.origin_event_id=event.id AND binding.job_id=event.job_id) INTO waiting;
 IF NOT waiting THEN UPDATE public.contract_shared_event SET processed_at=now(),error=CASE WHEN cursor_proof->'known'='true'::jsonb THEN 'Original workflow authority changed; unattempted work is retained for reconciliation.' ELSE 'Original workflow progress is unknown; frozen work is retained for reconciliation.' END WHERE tenant_id=event.tenant_id AND id=event.id;END IF;
 RETURN jsonb_build_object('handled',true,'waiting',waiting,'reason',CASE WHEN cursor_proof->'known'='true'::jsonb THEN 'authority_changed' ELSE 'legacy_cursor_unknown' END,'reconciliationNeeded',EXISTS(SELECT 1 FROM public.contract_shared_event retained WHERE retained.tenant_id=event.tenant_id AND retained.id=event.id AND retained.email_reconciliation IS NOT NULL));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_recovery_original(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_observed(p_event uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;pin_id uuid;observation_id uuid;observed app.contract_email_upload_observation;letter_id uuid;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR app.contract_shared_email_recovery_frame(event.job_id) IS NOT TRUE THEN RAISE EXCEPTION 'Original workflow authority required' USING ERRCODE='42501';END IF;
 SELECT pin.id,observation.id INTO pin_id,observation_id FROM app.contract_email_prerequisite_origin origin
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=origin.tenant_id AND pin.id=origin.pin_id
 JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.status='waiting' AND run.waiting_for=pin.id
 JOIN public.automation_email_template_version version ON version.tenant_id=pin.tenant_id AND version.template_id=pin.email_template_id AND version.revision=pin.email_revision
 JOIN public.lc_v9_email_asset asset ON asset.tenant_id=pin.tenant_id AND asset.email_template_id=pin.email_template_id::text AND asset.automation_module='contract_staff' AND asset.kind='file'
 AND asset.shared_subject_id=pin.case_id AND asset.shared_source_revision=pin.source_period_revision
 JOIN app.contract_email_upload_observation observation ON observation.tenant_id=asset.tenant_id AND observation.asset_id=asset.id
 WHERE origin.tenant_id=event.tenant_id AND origin.origin_event_id=event.id AND origin.job_id=event.job_id
 AND app.contract_shared_email_prerequisite_origin_held(pin.id)
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_prerequisite_finish(p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt app.contract_email_prerequisite_resume;binding app.contract_email_prerequisite_origin;run public.automation_run;pin public.contract_shared_email_document_step;same_wait boolean;
BEGIN
 SELECT * INTO receipt FROM app.contract_email_prerequisite_resume WHERE tenant_id=app.current_tenant_id() AND event_id=p_event;
 SELECT * INTO binding FROM app.contract_email_prerequisite_origin WHERE tenant_id=receipt.tenant_id AND pin_id=receipt.pin_id;
 IF receipt.event_id IS NULL OR app.contract_shared_email_recovery_frame(binding.job_id) IS NOT TRUE
 OR p_event::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR NOT EXISTS(SELECT 1 FROM public.contract_shared_event child WHERE child.tenant_id=receipt.tenant_id AND child.id=receipt.event_id AND child.trigger_event='emailDocumentReady'
  AND child.case_id=(SELECT case_id FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id)
  AND child.job_id=binding.job_id AND child.root_event_id=binding.root_event_id AND child.actor_user_id=receipt.callback_user_id AND child.actor_person_id=receipt.callback_person_id)
 THEN RAISE EXCEPTION 'Actual stored email callback and original live job required' USING ERRCODE='42501';END IF;
 SELECT * INTO pin FROM public.contract_shared_email_document_step WHERE tenant_id=receipt.tenant_id AND id=receipt.pin_id;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=pin.tenant_id AND id=pin.workflow_run_id;
 same_wait:=run.status='waiting' AND run.waiting_for=pin.id AND run.remaining_steps->0->'step'->>'id'=pin.workflow_step_id AND run.remaining_steps->0->'step'->>'type'='sendEmail';
 UPDATE public.contract_shared_event SET processed_at=now(),error=CASE WHEN receipt.completed_at IS NOT NULL THEN NULL
  WHEN same_wait THEN 'Email prerequisites or callback authority changed; the email remains waiting.'
  ELSE 'The email run already advanced; this callback sent nothing.' END
 WHERE tenant_id=receipt.tenant_id AND id=receipt.event_id AND trigger_event='emailDocumentReady';
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_email_prerequisite_origin(uuid),app.contract_shared_email_prerequisite_origin_held(uuid),
 app.contract_shared_email_prerequisite_begin(uuid),app.contract_shared_email_prerequisite_finish(uuid),
 app.contract_shared_email_prerequisite_run_progress(),app.contract_shared_email_prerequisite_observed(uuid) FROM PUBLIC,ai_hr_app;


--> statement-breakpoint
-- One bounded durable ordinary-child orchestration checkpoint; never a business-effect capability.
CREATE TABLE app.contract_ordinary_event_progress(
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,job_id uuid NOT NULL,root_event_id uuid NOT NULL,
 versions_hash bytea NOT NULL,workflow_cursor integer NOT NULL DEFAULT 0 CHECK(workflow_cursor BETWEEN 0 AND 250),
 mail_after uuid,email_recheck_after uuid,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,event_id),FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id));
ALTER TABLE app.contract_ordinary_event_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_ordinary_event_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_ordinary_event_progress_owner ON app.contract_ordinary_event_progress FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_ordinary_event_progress FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON app.contract_ordinary_event_progress TO ai_hr_owner;
CREATE FUNCTION app.contract_shared_ordinary_event_progress(p_event uuid,p_patch jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;job public.bulk_job;checkpoint app.contract_ordinary_event_progress;initial jsonb;digest bytea;result jsonb;cursor integer;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event FOR UPDATE;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=event.tenant_id AND id=event.job_id;
 IF event.id IS NULL OR event.root_event_id IS NULL OR event.root_event_id=event.id OR event.trigger_event='emailDocumentReady'
 OR event.processed_at IS NOT NULL OR event.id::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR job.id::text IS DISTINCT FROM current_setting('app.bulk_job',true) OR job.state<>'finalizing' OR job.cancel_requested_at IS NOT NULL
 OR job.lease_expires_at<=clock_timestamp() OR app.bulk_job_capability_held(job.id) IS NOT TRUE
 OR job.input IS DISTINCT FROM jsonb_build_object('eventId',event.root_event_id)
 OR NOT EXISTS(SELECT 1 FROM app.bulk_job_seal seal WHERE seal.tenant_id=job.tenant_id AND seal.job_id=job.id
  AND seal.input_digest=app.bulk_job_value_digest(job.input) AND seal.plan_digest=app.bulk_job_value_digest(job.plan))
 OR app.contract_shared_worker_event_held_recovery_base(event.case_id,event.decision_revision) IS NOT TRUE
 THEN RAISE EXCEPTION 'Actual current ordinary child workflow owner required' USING ERRCODE='42501';END IF;
 digest:=app.bulk_job_value_digest(event.workflow_versions);
 SELECT * INTO checkpoint FROM app.contract_ordinary_event_progress WHERE tenant_id=event.tenant_id AND event_id=event.id;
 -- Cold compatibility: read the actual sealed legacy tuple, not a caller-proposed cursor.
 initial:=CASE WHEN job.plan->>'activeEventId'=event.id::text THEN job.plan ELSE '{}'::jsonb END;
 IF checkpoint.event_id IS NULL THEN
  INSERT INTO app.contract_ordinary_event_progress(tenant_id,event_id,job_id,root_event_id,versions_hash,workflow_cursor,mail_after,email_recheck_after)
  VALUES(event.tenant_id,event.id,job.id,event.root_event_id,digest,coalesce((initial->>'workflowCursor')::integer,0),
   (initial->>'mailAfter')::uuid,(initial->>'emailRecheckAfter')::uuid) RETURNING * INTO checkpoint;
 END IF;
 IF checkpoint.job_id IS DISTINCT FROM job.id OR checkpoint.root_event_id IS DISTINCT FROM event.root_event_id OR checkpoint.versions_hash IS DISTINCT FROM digest
 THEN RAISE EXCEPTION 'The original child reference checkpoint changed' USING ERRCODE='40001';END IF;
 result:=jsonb_build_object('activeEventId',event.id,'workflowCursor',checkpoint.workflow_cursor,'mailAfter',checkpoint.mail_after,'emailRecheckAfter',checkpoint.email_recheck_after);
 IF p_patch IS NOT NULL THEN
  IF jsonb_typeof(p_patch)<>'object' OR p_patch-ARRAY['activeEventId','workflowCursor','mailAfter','emailRecheckAfter']<>'{}'::jsonb
  OR p_patch ? 'activeEventId' AND p_patch->>'activeEventId' IS NOT NULL AND p_patch->>'activeEventId'<>event.id::text
  THEN RAISE EXCEPTION 'Invalid child progress' USING ERRCODE='22023';END IF;
  result:=result||p_patch;cursor:=coalesce((result->>'workflowCursor')::integer,0);
  -- Clearing the tuple after successful native event_finish is unnecessary; the immutable event remains its owner.
  IF cursor<checkpoint.workflow_cursor OR cursor>jsonb_array_length(event.workflow_versions) THEN RAISE EXCEPTION 'Advance only the actual frozen reference cursor' USING ERRCODE='40001';END IF;
  UPDATE app.contract_ordinary_event_progress SET workflow_cursor=cursor,mail_after=(result->>'mailAfter')::uuid,email_recheck_after=(result->>'emailRecheckAfter')::uuid,updated_at=now()
  WHERE tenant_id=event.tenant_id AND event_id=event.id;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_ordinary_event_progress(uuid,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Passive native committed provenance. No legacy backfill, date/hash reconstruction or business authority.
CREATE INDEX contract_shared_posting_period_edge ON public.contract_shared_posting(tenant_id,subject_person_id,source_revision) WHERE after_period_revision IS NOT NULL;
CREATE FUNCTION app.contract_shared_posting_period_capture_valid(p_posting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_posting receipt
 JOIN public.personnel_posting posting ON posting.tenant_id=receipt.tenant_id AND posting.id=receipt.posting_id
 JOIN public.contract_case c ON c.tenant_id=receipt.tenant_id AND c.id=receipt.case_id
 JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
 LEFT JOIN LATERAL(SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=employment.tenant_id AND a.employment_id=employment.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) placement ON true
 JOIN public.contract_shared_posting_tx intent ON intent.tenant_id=receipt.tenant_id AND intent.posting_id=receipt.posting_id
  AND intent.employment_id=employment.id AND intent.transaction_id=txid_current() AND intent.backend_pid=pg_backend_pid()
  AND intent.login_name=session_user AND intent.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND intent.consumed
 WHERE receipt.tenant_id=app.current_tenant_id() AND receipt.posting_id=p_posting AND receipt.applied_at IS NOT NULL
 AND receipt.movement_group_id IS NOT NULL AND posting.source='contract_staff' AND posting.source_ref=c.id AND posting.employment_id=employment.id
 AND posting.company_id=c.company_id AND employment.company_id=c.company_id AND employment.person_id=receipt.subject_person_id
 AND posting.status='approved' AND posting.movement_id IS NOT NULL AND posting.approved_by IS NOT NULL AND posting.approved_at IS NOT NULL
 AND posting.event_type=intent.kind AND intent.kind IN('contractRenewal','contractConversion') AND f.data->'period'->>'sourceRevision'=receipt.source_revision
 AND to_jsonb(employment) @> intent.desired
 AND placement.employment_type=(CASE intent.kind WHEN 'contractConversion' THEN 'full_time' ELSE 'contract' END)::public.employment_type
 AND EXISTS(SELECT 1 FROM public.domain_event movement WHERE movement.tenant_id=receipt.tenant_id AND movement.subject_employment_id=employment.id
  AND movement.occurred_at=now() AND movement.actor_type=CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END
  AND movement.actor_id IS NOT DISTINCT FROM app.current_user_id() AND movement.payload->'movement'->>'groupId'=receipt.movement_group_id::text
  AND movement.payload->'movement'->>'type'=CASE intent.kind WHEN 'contractConversion' THEN 'employmentTypeChange' ELSE 'contractRenewal' END))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_period_capture_valid(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_posting_capture_applied_period(p_posting uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt public.contract_shared_posting;employment_id uuid;revision text;
BEGIN
 SELECT * INTO receipt FROM public.contract_shared_posting WHERE tenant_id=app.current_tenant_id() AND posting_id=p_posting FOR UPDATE;
 IF receipt.posting_id IS NULL THEN RETURN;END IF;
 SELECT c.employment_id INTO employment_id FROM public.contract_case c WHERE c.tenant_id=receipt.tenant_id AND c.id=receipt.case_id;
 revision:=app.contract_shared_period_revision(receipt.tenant_id,employment_id);
 -- Passive provenance never makes an existing authorized business write fail. New fixed owners
 -- capture AFTER replay and bind the receipt in their own final commit proof. Existing due owners
 -- first capture at deferred COMMIT; a later different target merely leaves unknown provenance.
 IF receipt.after_period_revision IS NOT NULL THEN RETURN;END IF;
 IF app.contract_shared_posting_period_capture_valid(p_posting) IS NOT TRUE OR revision IS NULL
 THEN RETURN;END IF;
 UPDATE public.contract_shared_posting SET after_period_revision=revision WHERE tenant_id=receipt.tenant_id AND posting_id=receipt.posting_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_capture_applied_period(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_posting_after_period_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.after_period_revision IS NOT NULL THEN RAISE EXCEPTION 'Create native posting provenance only after actual application' USING ERRCODE='42501';END IF;
 ELSIF NEW.after_period_revision IS DISTINCT FROM OLD.after_period_revision THEN
  IF OLD.after_period_revision IS NOT NULL OR NEW.after_period_revision IS NULL
  OR (to_jsonb(NEW)-'after_period_revision') IS DISTINCT FROM (to_jsonb(OLD)-'after_period_revision')
  OR app.contract_shared_posting_period_capture_valid(NEW.posting_id) IS NOT TRUE
  OR NEW.after_period_revision IS DISTINCT FROM app.contract_shared_period_revision(NEW.tenant_id,(SELECT employment_id FROM public.personnel_posting WHERE tenant_id=NEW.tenant_id AND id=NEW.posting_id))
  THEN RAISE EXCEPTION 'Native committed Contract period provenance is immutable and cannot be supplied by callers' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_after_period_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_posting_after_period_guard BEFORE INSERT OR UPDATE ON public.contract_shared_posting FOR EACH ROW EXECUTE FUNCTION app.contract_shared_posting_after_period_guard();
CREATE FUNCTION app.contract_shared_posting_period_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL THEN PERFORM app.contract_shared_posting_capture_applied_period(NEW.posting_id);END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_period_receipt() FROM PUBLIC,ai_hr_app;
-- Existing ordinary due owners reach this deferred fallback. The new protected-posting finish calls the
-- SAME capture helper explicitly AFTER replay and BEFORE sealing sharedreceipt, so this becomes a no-op.
CREATE CONSTRAINT TRIGGER contract_shared_posting_period_receipt AFTER UPDATE OF applied_at ON public.contract_shared_posting
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.contract_shared_posting_period_receipt();

--> statement-breakpoint
CREATE INDEX contract_shared_event_email_reconciliation ON public.contract_shared_event(tenant_id,case_id,id) WHERE email_reconciliation IS NOT NULL;
CREATE FUNCTION app.contract_shared_email_event_cursor(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;job public.bulk_job;checkpoint app.contract_ordinary_event_progress;cursor integer;known boolean:=false;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=event.tenant_id AND id=event.job_id;
 IF event.id IS NULL OR event.processed_at IS NOT NULL OR event.trigger_event='emailDocumentReady' OR app.contract_shared_email_recovery_frame(job.id) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
  WHERE binding.tenant_id=event.tenant_id AND binding.job_id=job.id AND pin.case_id=event.case_id AND binding.root_event_id=coalesce(event.root_event_id,event.id))
 THEN RAISE EXCEPTION 'Actual original email cohort required for its orchestration cursor' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(event.workflow_versions)=0 THEN RETURN jsonb_build_object('known',true,'cursor',0);END IF;
 SELECT * INTO checkpoint FROM app.contract_ordinary_event_progress WHERE tenant_id=event.tenant_id AND event_id=event.id;
 IF checkpoint.event_id IS NOT NULL AND checkpoint.job_id=job.id AND checkpoint.root_event_id=event.root_event_id
 AND checkpoint.versions_hash=app.bulk_job_value_digest(event.workflow_versions) THEN cursor:=checkpoint.workflow_cursor;known:=true;
 ELSIF job.plan->>'activeEventId'=event.id::text AND job.plan->>'workflowCursor'~'^[0-9]{1,3}$' THEN cursor:=(job.plan->>'workflowCursor')::integer;known:=true;
 ELSIF event.id=coalesce(event.root_event_id,event.id) AND job.plan->'activeEventId'='null'::jsonb AND coalesce(job.plan->>'workflowCursor','0')='0' THEN cursor:=0;known:=true;
 ELSIF event.root_event_id IS NOT NULL AND job.plan->'rootParked'='true'::jsonb AND checkpoint.event_id IS NULL THEN cursor:=0;known:=true;
 END IF;
 IF cursor IS NULL OR cursor<0 OR cursor>jsonb_array_length(event.workflow_versions) THEN known:=false;cursor:=NULL;END IF;
 RETURN jsonb_build_object('known',known,'cursor',cursor);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_event_cursor(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_shared_email_retain_unattempted(p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;proof jsonb;workflows jsonb;retained jsonb;recorded text;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event FOR UPDATE;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 THEN RAISE EXCEPTION 'Retain only the selected original event metadata' USING ERRCODE='42501';END IF;
 proof:=app.contract_shared_email_event_cursor(event.id);
 -- Only actual runs joined to this native origin/root can anchor another frozen dispatch.
 -- A resumed email may retain decisionSubmitted's run key while the selected event is letterReleased.
 WITH pinned AS MATERIALIZED(
  SELECT run.* FROM app.contract_email_prerequisite_origin binding
  JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
  JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id
  WHERE binding.tenant_id=event.tenant_id AND binding.origin_event_id=event.id AND binding.job_id=event.job_id
   AND binding.root_event_id=coalesce(event.root_event_id,event.id) AND pin.case_id=event.case_id
   AND run.module='contract_staff' AND run.subject_id=event.case_id
 ), anchors AS MATERIALIZED(
  SELECT * FROM pinned UNION
  SELECT run.* FROM public.automation_run run
  WHERE run.tenant_id=event.tenant_id AND run.module='contract_staff' AND run.subject_id=event.case_id
   AND run.trigger_event=event.trigger_event AND run.event_key=event.trigger_event||'|'||event.occurrence
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(event.workflow_versions) refs(ref)
    WHERE ref->>'workflowId'=run.workflow_id::text AND (ref->>'revision')::integer=run.workflow_revision)
 ), dispatches AS MATERIALIZED(
  SELECT DISTINCT dispatch.id,dispatch.workflow_versions,anchor.event_key,anchor.trigger_event
  FROM anchors anchor JOIN public.contract_shared_event dispatch
   ON dispatch.tenant_id=event.tenant_id AND dispatch.case_id=event.case_id AND dispatch.trigger_event=anchor.trigger_event
   AND dispatch.occurrence=substr(anchor.event_key,length(anchor.trigger_event)+2)
   AND anchor.event_key=dispatch.trigger_event||'|'||dispatch.occurrence
  WHERE dispatch.trigger_event NOT IN('beforeContractEnd','afterContractEnd','emailDocumentReady')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(dispatch.workflow_versions) refs(ref)
    WHERE ref->>'workflowId'=anchor.workflow_id::text AND (ref->>'revision')::integer=anchor.workflow_revision)
 ), causal AS MATERIALIZED(
  SELECT * FROM pinned UNION
  SELECT run.* FROM dispatches dispatch JOIN public.automation_run run
   ON run.tenant_id=event.tenant_id AND run.module='contract_staff' AND run.subject_id=event.case_id
   AND run.trigger_event=dispatch.trigger_event AND run.event_key=dispatch.event_key
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(dispatch.workflow_versions) refs(ref)
   WHERE ref->>'workflowId'=run.workflow_id::text AND (ref->>'revision')::integer=run.workflow_revision)
 ), unresolved AS MATERIALIZED(
  SELECT * FROM causal WHERE status='waiting' OR status IN('running','failed') AND jsonb_array_length(remaining_steps)>0
 ), candidates AS(
  SELECT (ref->>'workflowId')::uuid AS id,(ref->>'revision')::integer AS revision,
   CASE WHEN proof->'known'='true'::jsonb THEN 'not_started' ELSE 'needs_reconciliation' END AS stage
  FROM jsonb_array_elements(event.workflow_versions) WITH ORDINALITY refs(ref,n)
  WHERE proof->'known' IS DISTINCT FROM 'true'::jsonb OR n>(proof->>'cursor')::integer
  UNION ALL SELECT workflow_id,workflow_revision,'needs_reconciliation' FROM unresolved
 ), definitions AS(
  SELECT DISTINCT ON(candidate.id,candidate.revision) candidate.id,candidate.revision,candidate.stage,
   coalesce(version.definition->>'name','Workflow') AS name
  FROM candidates candidate JOIN public.automation_workflow_version version
   ON version.tenant_id=event.tenant_id AND version.module='contract_staff'
   AND version.workflow_id=candidate.id AND version.revision=candidate.revision
  ORDER BY candidate.id,candidate.revision,CASE WHEN candidate.stage='needs_reconciliation' THEN 0 ELSE 1 END
 )
 SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'name',name,'stage',stage) ORDER BY id,revision),'[]'::jsonb) FROM definitions),
  (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM unresolved)
 INTO workflows,retained;
 IF jsonb_array_length(workflows)>0 OR jsonb_array_length(retained)>0 THEN
  recorded:=coalesce(event.email_reconciliation->>'recordedAt',now()::text);
  UPDATE public.contract_shared_event SET email_reconciliation=jsonb_build_object('version',1,'reason',CASE WHEN proof->'known'='true'::jsonb THEN 'authority_changed' ELSE 'legacy_cursor_unknown' END,
   'recordedAt',recorded,'cursor',proof->'cursor','workflows',workflows,'retainedRunIds',retained)
  WHERE tenant_id=event.tenant_id AND id=event.id;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_retain_unattempted(uuid) FROM PUBLIC,ai_hr_app;
-- Selected-case-only metadata. Existing CaseView owner remains the sole read admission.
CREATE FUNCTION app.contract_shared_email_reconciliation_page(p_case uuid,p_limit integer,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;page_size integer:=least(greatest(coalesce(p_limit,50),1),50);page_offset integer:=coalesce(p_offset,0);
BEGIN
 IF app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'This Contract case is unavailable' USING ERRCODE='42501';END IF;
 IF page_offset<0 OR page_offset>100000 THEN RAISE EXCEPTION 'Invalid reconciliation page' USING ERRCODE='22023';END IF;
 WITH scope AS MATERIALIZED(SELECT c.employment_id,c.company_id,c.company_id=e.company_id AS current_company FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),retained AS MATERIALIZED(SELECT event.id AS "eventId",c.id AS "caseId",c.number AS "caseNumber",event.email_reconciliation->>'reason' AS reason,
  event.email_reconciliation->>'recordedAt' AS "recordedAt",event.email_reconciliation->'workflows' AS workflows,event.email_reconciliation->'retainedRunIds' AS "retainedRunIds"
  FROM public.contract_shared_event event JOIN public.contract_case c ON c.tenant_id=event.tenant_id AND c.id=event.case_id
  CROSS JOIN scope WHERE event.tenant_id=app.current_tenant_id() AND (event.case_id=p_case OR scope.current_company AND c.employment_id=scope.employment_id AND c.company_id=scope.company_id) AND event.email_reconciliation IS NOT NULL),
 page AS MATERIALIZED(SELECT * FROM retained ORDER BY "recordedAt" DESC,"eventId" LIMIT page_size OFFSET page_offset)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "recordedAt" DESC,"eventId") FROM page),'[]'::jsonb),
  'total',(SELECT count(*) FROM retained),'limit',page_size,'offset',page_offset,'hasMore',page_offset+(SELECT count(*) FROM page)<(SELECT count(*) FROM retained)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_reconciliation_page(uuid,integer,integer) FROM PUBLIC,ai_hr_app;
-- Existing app workspace grant, same OID and existing CaseView gate; the offset is NEVER authority.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('app.contract_shared_workspace(uuid)'::regprocedure);
 IF position('RETURN result;' in definition)=0 THEN RAISE EXCEPTION 'Expected native workspace return before6000 reconciliation extension';END IF;
 definition:=replace(definition,'DECLARE result jsonb;', 'DECLARE requested_offset text:=nullif(current_setting(''app.requested_contract_email_reconciliation_offset'',true),'''');reconciliation_offset integer:=0;result jsonb;');
 definition:=replace(definition,' RETURN result;', ' IF requested_offset IS NOT NULL THEN IF requested_offset !~ ''^[0-9]{1,6}$'' OR requested_offset::integer>100000 THEN RAISE EXCEPTION ''Invalid reconciliation offset'' USING ERRCODE=''22023'';END IF;reconciliation_offset:=requested_offset::integer;END IF; RETURN result||jsonb_build_object(''emailReconciliations'',app.contract_shared_email_reconciliation_page(p_case,50,reconciliation_offset));');
 EXECUTE definition;
END $$;

--> statement-breakpoint
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('app.contract_shared_tracker(text,uuid,text,integer,integer,boolean)'::regprocedure);
 needle:=' visible AS MATERIALIZED(';
 IF position(needle in definition)=0 OR position('LEFT JOIN pending_pay pending ON pending.employment_id=e.id' in definition)=0
 OR position('AS flags,f.updated_at' in definition)=0 THEN RAISE EXCEPTION 'Expected native tracker seams before6000 reconciliation extension';END IF;
 -- The existing set-based rights are equivalent to CaseView for these SAME-current-company cases:
 -- case_permitted(view) delegates shared_permitted(view,c.company_id,...,c.employment_id) when c.company=e.company.
 -- No old-company names/IDs are inferred from current employment rights.
 definition:=replace(definition,needle, ' email_reconciliation AS MATERIALIZED(SELECT DISTINCT ON(old.employment_id) old.employment_id,old.id AS case_id,old.number AS case_number FROM public.contract_shared_event event JOIN public.contract_case old ON old.tenant_id=event.tenant_id AND old.id=event.case_id JOIN public.employment current_e ON current_e.tenant_id=old.tenant_id AND current_e.id=old.employment_id AND current_e.company_id=old.company_id JOIN rights ON rights.employment_id=old.employment_id WHERE event.tenant_id=app.current_tenant_id() AND event.email_reconciliation IS NOT NULL ORDER BY old.employment_id,event.created_at DESC,event.id DESC), visible AS MATERIALIZED(');
 definition:=replace(definition,'LEFT JOIN pending_pay pending ON pending.employment_id=e.id','LEFT JOIN pending_pay pending ON pending.employment_id=e.id LEFT JOIN email_reconciliation retained_work ON retained_work.employment_id=e.id');
 definition:=replace(definition,'AS flags,f.updated_at','||CASE WHEN retained_work.employment_id IS NOT NULL THEN ''["workflow_reconciliation"]''::jsonb ELSE ''[]''::jsonb END AS flags,retained_work.employment_id IS NOT NULL AS "reconciliationNeeded",retained_work.case_id AS "reconciliationCaseId",retained_work.case_number AS "reconciliationCaseNumber",f.updated_at');
 definition:=replace(definition,'jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL','"reconciliationNeeded" OR jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL');
 EXECUTE definition;
 definition:=pg_get_functiondef('app.contract_shared_case_attention(uuid[])'::regprocedure);
 IF position('stalled IS NOT NULL OR jsonb_array_length(flags)>0' in definition)=0 THEN RAISE EXCEPTION 'Expected native attention seam before6000 reconciliation extension';END IF;
 IF position(' facts AS MATERIALIZED(' in definition)=0 OR position('LEFT JOIN public.contract_shared_settings s' in definition)=0 THEN RAISE EXCEPTION 'Expected set-based bounded attention joins before6000';END IF;
 definition:=replace(definition,' facts AS MATERIALIZED(', ' email_attention_work AS MATERIALIZED(SELECT DISTINCT old.employment_id,old.company_id FROM public.contract_case selected JOIN rights ON rights.employment_id=selected.employment_id JOIN public.employment current_e ON current_e.tenant_id=selected.tenant_id AND current_e.id=selected.employment_id AND current_e.company_id=selected.company_id JOIN public.contract_case old ON old.tenant_id=selected.tenant_id AND old.employment_id=selected.employment_id AND old.company_id=selected.company_id JOIN public.contract_shared_event retained ON retained.tenant_id=old.tenant_id AND retained.case_id=old.id AND retained.email_reconciliation IS NOT NULL WHERE selected.tenant_id=app.current_tenant_id() AND selected.id=ANY(p_cases)), facts AS MATERIALIZED(');
 definition:=replace(definition,'LEFT JOIN public.contract_shared_settings s','LEFT JOIN email_attention_work retained_work ON retained_work.employment_id=c.employment_id AND retained_work.company_id=c.company_id LEFT JOIN public.contract_shared_settings s');
 definition:=replace(definition,'END AS flags','END||CASE WHEN retained_work.employment_id IS NOT NULL THEN ''["workflow_reconciliation"]''::jsonb ELSE ''[]''::jsonb END AS flags');
 EXECUTE definition;
END $$;

--> statement-breakpoint
-- One real existing run per unit. A legacy/missing receipt is metadata-only; it cannot mint a failure.
CREATE FUNCTION app.contract_shared_email_stop_completed_tail(p_event uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;pin_id uuid;receipt_id uuid;run public.automation_run;after_run public.automation_run;mode text;message text;kept_log jsonb;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.processed_at IS NOT NULL OR event.trigger_event='emailDocumentReady'
 OR app.contract_shared_email_recovery_frame(event.job_id) IS NOT TRUE THEN RAISE EXCEPTION 'Actual original email cohort frame required' USING ERRCODE='42501';END IF;
 SELECT pin.id,receipt.event_id INTO pin_id,receipt_id
 FROM app.contract_email_prerequisite_origin binding
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
 JOIN public.automation_run candidate ON candidate.tenant_id=pin.tenant_id AND candidate.id=pin.workflow_run_id AND candidate.module='contract_staff' AND candidate.subject_id=pin.case_id
 JOIN app.contract_email_prerequisite_resume receipt ON receipt.tenant_id=pin.tenant_id AND receipt.pin_id=pin.id AND receipt.completed_at IS NOT NULL AND receipt.continued_at IS NULL
 JOIN public.contract_shared_event completed ON completed.tenant_id=receipt.tenant_id AND completed.id=receipt.event_id AND completed.trigger_event='emailDocumentReady'
  AND completed.processed_at IS NOT NULL AND completed.workflow_versions='[]'::jsonb AND completed.job_id=binding.job_id AND completed.root_event_id=binding.root_event_id AND completed.case_id=pin.case_id
  AND completed.actor_user_id=receipt.callback_user_id AND completed.actor_person_id=receipt.callback_person_id
 WHERE binding.tenant_id=event.tenant_id AND binding.origin_event_id=event.id AND binding.job_id=event.job_id AND pin.case_id=event.case_id
 AND candidate.status='running' AND candidate.waiting_for IS NULL AND jsonb_array_length(candidate.remaining_steps)>0
 AND receipt.result_run_hash=encode(sha256(convert_to((to_jsonb(candidate)-'updated_at')::text,'UTF8')),'hex')
 AND app.contract_shared_email_recovery_disposition(pin.id)<>'current'
 ORDER BY pin.id,receipt.event_id LIMIT 1 FOR UPDATE OF candidate;
 IF pin_id IS NULL THEN RETURN false;END IF;
 SELECT candidate.* INTO run FROM public.automation_run candidate JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=candidate.tenant_id AND pin.workflow_run_id=candidate.id WHERE pin.tenant_id=event.tenant_id AND pin.id=pin_id;
 mode:=app.contract_shared_email_recovery_disposition(pin_id);
 IF mode='current' THEN RETURN false;END IF;
 IF app.contract_shared_email_recovery_frame(event.job_id) IS NOT TRUE THEN RAISE EXCEPTION 'The original email cohort lease changed while selecting its real tail' USING ERRCODE='42501';END IF;
 message:=CASE WHEN mode='legacy_cursor_unknown' THEN 'Original workflow progress needs reconciliation; remaining steps stopped.' ELSE 'Original workflow authority changed; remaining steps stopped.' END;
 SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb) INTO kept_log FROM jsonb_array_elements(run.log) WITH ORDINALITY entries(value,n) WHERE n>greatest(jsonb_array_length(run.log)-199,0);
 UPDATE public.automation_run SET status='failed',failure=message,waiting_for=NULL,updated_at=now(),
  log=kept_log||jsonb_build_array(jsonb_build_object('at',now(),'kind','failed','step',NULL,'stepId',NULL,'type',NULL,'message',message))
 WHERE tenant_id=run.tenant_id AND id=run.id
 AND status='running' AND EXISTS(SELECT 1 FROM app.contract_email_prerequisite_resume receipt WHERE receipt.tenant_id=run.tenant_id AND receipt.event_id=receipt_id AND receipt.completed_at IS NOT NULL AND receipt.continued_at IS NULL AND receipt.result_run_hash=encode(sha256(convert_to((to_jsonb(run)-'updated_at')::text,'UTF8')),'hex'))
 RETURNING * INTO after_run;
 IF after_run.id IS NULL THEN RETURN false;END IF;
 IF (to_jsonb(after_run)-ARRAY['status','failure','waiting_for','log','updated_at']) IS DISTINCT FROM (to_jsonb(run)-ARRAY['status','failure','waiting_for','log','updated_at'])
 OR after_run.remaining_steps IS DISTINCT FROM run.remaining_steps OR after_run.failure IS DISTINCT FROM message OR after_run.status<>'failed'
 THEN RAISE EXCEPTION 'Technical source loss may only fail the proven real run and retain its exact tail' USING ERRCODE='42501';END IF;
 -- Close this proven handoff; the original email queue/completion receipt remains immutable evidence.
 UPDATE app.contract_email_prerequisite_resume SET continued_at=now() WHERE tenant_id=run.tenant_id AND event_id=receipt_id AND completed_at IS NOT NULL AND continued_at IS NULL;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_stop_completed_tail(uuid) FROM PUBLIC,ai_hr_app;
