-- UNAPPROVED / UNAPPLIED / UNREGISTERED.6000–6005 must precede this concrete producer proof.
-- FIRST creation is immutable provenance, never inferred from a later duplicate or from caller flags.
-- These are technical receipts owned by the existing runtime; no authored trigger, workflow tail owner,
-- Personnel mutation or relaxed ordinary worker/effect authority is added.
CREATE TABLE app.contract_posting_producer(
 tenant_id uuid NOT NULL,posting_id uuid NOT NULL,case_id uuid NOT NULL,employment_id uuid NOT NULL,company_id uuid NOT NULL,
 subject_person_id uuid NOT NULL,decision_revision integer NOT NULL,letter_id uuid NOT NULL,source_revision text NOT NULL,
 run_id uuid NOT NULL,workflow_id uuid NOT NULL,workflow_revision integer NOT NULL,step_id text NOT NULL,step_hash bytea NOT NULL,
 event_id uuid NOT NULL,origin_event_id uuid NOT NULL,root_event_id uuid NOT NULL,job_id uuid NOT NULL,
 event_versions_hash bytea NOT NULL,origin_versions_hash bytea NOT NULL,proposal_hash bytea NOT NULL,
 posting_created_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,posting_id),FOREIGN KEY(tenant_id,posting_id) REFERENCES public.contract_shared_posting(tenant_id,posting_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id),
 FOREIGN KEY(tenant_id,employment_id) REFERENCES public.employment(tenant_id,id),
 FOREIGN KEY(company_id) REFERENCES public.company(id),FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.automation_run(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(tenant_id,root_event_id) REFERENCES public.contract_shared_event(tenant_id,id),
 FOREIGN KEY(job_id) REFERENCES public.bulk_job(id)
);
CREATE INDEX contract_posting_producer_event ON app.contract_posting_producer(tenant_id,event_id);
CREATE TABLE app.contract_posting_producer_certificate(
 tenant_id uuid NOT NULL,posting_id uuid NOT NULL,event_id uuid NOT NULL,job_id uuid NOT NULL,
 versions_hash bytea NOT NULL,workflow_cursor integer NOT NULL,cohort_hash bytea NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,posting_id,cohort_hash),FOREIGN KEY(tenant_id,posting_id) REFERENCES app.contract_posting_producer(tenant_id,posting_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id),FOREIGN KEY(job_id) REFERENCES public.bulk_job(id)
);
ALTER TABLE app.contract_posting_producer ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_producer FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_producer_certificate ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_producer_certificate FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_producer_owner ON app.contract_posting_producer FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_posting_producer_certificate_owner ON app.contract_posting_producer_certificate FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_producer,app.contract_posting_producer_certificate FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON app.contract_posting_producer,app.contract_posting_producer_certificate TO ai_hr_owner;
CREATE TRIGGER contract_posting_producer_immutable BEFORE UPDATE OR DELETE ON app.contract_posting_producer FOR EACH ROW EXECUTE FUNCTION app.contract_case_revision_immutable();
CREATE TRIGGER contract_posting_producer_certificate_immutable BEFORE UPDATE OR DELETE ON app.contract_posting_producer_certificate FOR EACH ROW EXECUTE FUNCTION app.contract_case_revision_immutable();
--> statement-breakpoint
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_shared_create_posting(uuid,uuid,text)'::regprocedure),
 'FUNCTION app.contract_shared_create_posting(', 'FUNCTION app.contract_shared_create_posting_before_producer(');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_create_posting_before_producer(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_create_posting(p_case uuid,p_run uuid,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;event public.contract_shared_event;origin public.contract_shared_event;job public.bulk_job;
 run public.automation_run;posting public.personnel_posting;receipt public.contract_shared_posting;frozen jsonb;
BEGIN
 result:=app.contract_shared_create_posting_before_producer(p_case,p_run,p_step);
 -- Duplicate and skipped paths NEVER mint or repair missing FIRST provenance.
 IF result->'existing' IS DISTINCT FROM 'false'::jsonb THEN RETURN result;END IF;
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id::text=current_setting('app.contract_event',true);
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=event.tenant_id AND id=event.job_id;
 SELECT * INTO run FROM public.automation_run WHERE tenant_id=event.tenant_id AND id=p_run;
 SELECT * INTO posting FROM public.personnel_posting WHERE tenant_id=event.tenant_id AND id=(result->>'id')::uuid;
 SELECT * INTO receipt FROM public.contract_shared_posting WHERE tenant_id=posting.tenant_id AND posting_id=posting.id;
 SELECT step INTO frozen FROM public.automation_workflow_version v CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') step
 WHERE v.tenant_id=run.tenant_id AND v.workflow_id=run.workflow_id AND v.revision=run.workflow_revision AND step->>'id'=p_step AND step->>'type'='createPosting';
 SELECT candidate.* INTO origin FROM public.contract_shared_event candidate WHERE candidate.tenant_id=run.tenant_id AND candidate.case_id=run.subject_id
 AND candidate.trigger_event=run.trigger_event AND (run.event_key=candidate.trigger_event||'|'||candidate.occurrence OR starts_with(run.event_key,candidate.trigger_event||'|'||candidate.occurrence||'|'))
 ORDER BY length(candidate.occurrence) DESC,candidate.created_at,candidate.id LIMIT 1;
 IF event.id IS NULL OR event.trigger_event='emailDocumentReady' OR event.case_id IS DISTINCT FROM p_case OR event.processed_at IS NOT NULL
 OR app.contract_shared_effect_held(p_case,p_run,p_step,'createPosting') IS NOT TRUE OR app.contract_shared_storage_runner() IS NOT TRUE
 OR job.id::text IS DISTINCT FROM current_setting('app.bulk_job',true) OR job.kind<>'contract_automation' OR job.state<>'finalizing'
 OR job.operation_key IS DISTINCT FROM coalesce(event.root_event_id,event.id) OR job.input IS DISTINCT FROM jsonb_build_object('eventId',job.operation_key)
 OR job.cancel_requested_at IS NOT NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp() OR app.bulk_job_capability_held(job.id) IS NOT TRUE
 OR app.bulk_job_seal_verify(job.id,'full') IS NOT NULL
 OR posting.id IS NULL OR posting.source<>'contract_staff' OR posting.source_ref IS DISTINCT FROM p_case OR posting.created_at IS DISTINCT FROM now()
 OR receipt.created_at IS DISTINCT FROM now() OR receipt.case_id IS DISTINCT FROM p_case OR receipt.decision_revision IS DISTINCT FROM event.decision_revision
 OR receipt.letter_id IS DISTINCT FROM app.contract_shared_released_step_letter(p_case,p_run,p_step)
 OR run.id IS NULL OR run.module<>'contract_staff' OR run.subject_id IS DISTINCT FROM p_case OR frozen IS NULL OR origin.id IS NULL
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(origin.workflow_versions) ref WHERE ref->>'workflowId'=run.workflow_id::text AND ref->>'revision'=run.workflow_revision::text)
 THEN RAISE EXCEPTION 'Actual FIRST protected Contract posting producer required' USING ERRCODE='42501';END IF;
 INSERT INTO app.contract_posting_producer(tenant_id,posting_id,case_id,employment_id,company_id,subject_person_id,decision_revision,letter_id,source_revision,
 run_id,workflow_id,workflow_revision,step_id,step_hash,event_id,origin_event_id,root_event_id,job_id,event_versions_hash,origin_versions_hash,proposal_hash,posting_created_at)
 VALUES(receipt.tenant_id,posting.id,p_case,posting.employment_id,posting.company_id,receipt.subject_person_id,receipt.decision_revision,receipt.letter_id,receipt.source_revision,
 run.id,run.workflow_id,run.workflow_revision,p_step,app.bulk_job_value_digest(frozen),event.id,origin.id,coalesce(event.root_event_id,event.id),job.id,
 app.bulk_job_value_digest(event.workflow_versions),app.bulk_job_value_digest(origin.workflow_versions),app.bulk_job_value_digest(posting.proposed),posting.created_at);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_create_posting(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- ONE set-based, bounded technical projection. No per-posting SECURITY DEFINER page loop; no amount
-- values are returned. The unchanged canonical request/approval owners separately enforce live PM period
-- and decision identity. Here captured source/letter/ref facts and actual remaining native work are checked.
CREATE FUNCTION app.contract_posting_producer_disposition(p_ids uuid[])
RETURNS TABLE(posting_id uuid,event_id uuid,job_id uuid,email_only boolean,complete boolean,cohort_hash bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids)=0 THEN RETURN;END IF;
 IF cardinality(p_ids)>100 THEN RAISE EXCEPTION 'Bound the Contract readiness projection' USING ERRCODE='22023';END IF;
 RETURN QUERY
 WITH ids AS MATERIALIZED(SELECT DISTINCT unnest(p_ids) id),
 bases AS MATERIALIZED(
  SELECT producer.*,job.state AS job_state,job.input AS job_input,job.plan AS job_plan,job.operation_key,job.cancel_requested_at,
   seal.input_digest,seal.plan_digest,seal.steps_sealed,event.processed_at,event.workflow_versions,(origin.processed_at IS NOT NULL OR origin.id=producer.event_id) AS origin_settled,origin.trigger_event AS origin_trigger,origin.occurrence AS origin_occurrence
  FROM ids JOIN app.contract_posting_producer producer ON producer.tenant_id=app.current_tenant_id() AND producer.posting_id=ids.id
  JOIN public.personnel_posting posting ON posting.tenant_id=producer.tenant_id AND posting.id=producer.posting_id AND posting.source='contract_staff'
   AND posting.source_ref=producer.case_id AND posting.employment_id=producer.employment_id AND posting.company_id=producer.company_id
   AND posting.created_at=producer.posting_created_at AND app.bulk_job_value_digest(posting.proposed)=producer.proposal_hash
  JOIN public.contract_shared_posting receipt ON receipt.tenant_id=producer.tenant_id AND receipt.posting_id=producer.posting_id
   AND receipt.case_id=producer.case_id AND receipt.decision_revision=producer.decision_revision AND receipt.letter_id=producer.letter_id
   AND receipt.subject_person_id=producer.subject_person_id AND receipt.source_revision=producer.source_revision
  JOIN public.employment employment ON employment.tenant_id=producer.tenant_id AND employment.id=producer.employment_id
   AND employment.company_id=producer.company_id AND employment.person_id=producer.subject_person_id
  JOIN public.contract_shared_case flow ON flow.tenant_id=producer.tenant_id AND flow.case_id=producer.case_id
   AND flow.data->'period'->>'sourceRevision'=producer.source_revision
  JOIN public.contract_shared_letter letter ON letter.tenant_id=producer.tenant_id AND letter.id=producer.letter_id
   AND letter.case_id=producer.case_id AND letter.decision_revision=producer.decision_revision AND letter.data->>'state'='released' AND letter.data->'valuesFixed'='true'::jsonb
  JOIN public.contract_shared_event event ON event.tenant_id=producer.tenant_id AND event.id=producer.event_id AND event.job_id=producer.job_id
   AND coalesce(event.root_event_id,event.id)=producer.root_event_id AND event.case_id=producer.case_id AND event.decision_revision=producer.decision_revision
   AND app.bulk_job_value_digest(event.workflow_versions)=producer.event_versions_hash
  JOIN public.contract_shared_event origin ON origin.tenant_id=producer.tenant_id AND origin.id=producer.origin_event_id AND origin.case_id=producer.case_id
   AND app.bulk_job_value_digest(origin.workflow_versions)=producer.origin_versions_hash
  JOIN public.automation_run producer_run ON producer_run.tenant_id=producer.tenant_id AND producer_run.id=producer.run_id AND producer_run.module='contract_staff'
   AND producer_run.subject_id=producer.case_id AND producer_run.workflow_id=producer.workflow_id AND producer_run.workflow_revision=producer.workflow_revision
  JOIN public.automation_workflow_version producer_version ON producer_version.tenant_id=producer.tenant_id AND producer_version.workflow_id=producer.workflow_id AND producer_version.revision=producer.workflow_revision
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(producer_version.definition->'steps') step WHERE step->>'id'=producer.step_id AND step->>'type'='createPosting' AND app.bulk_job_value_digest(step)=producer.step_hash)
  JOIN public.bulk_job job ON job.tenant_id=producer.tenant_id AND job.id=producer.job_id AND job.kind='contract_automation' AND job.operation_key=producer.root_event_id
  LEFT JOIN app.bulk_job_seal seal ON seal.tenant_id=job.tenant_id AND seal.job_id=job.id
 ),cohort AS MATERIALIZED(
  SELECT DISTINCT base.posting_id,run.* FROM bases base JOIN public.automation_run run ON run.tenant_id=base.tenant_id AND run.module='contract_staff' AND run.subject_id=base.case_id
  WHERE run.id=base.run_id OR EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin pin_origin JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=pin_origin.tenant_id AND pin.id=pin_origin.pin_id
   WHERE pin_origin.tenant_id=base.tenant_id AND pin_origin.job_id=base.job_id AND pin.workflow_run_id=run.id)
  OR EXISTS(SELECT 1 FROM public.contract_shared_event related WHERE related.tenant_id=base.tenant_id AND related.case_id=base.case_id
   AND (related.job_id=base.job_id OR related.id=base.origin_event_id OR (related.trigger_event='letterReleased' AND related.data->>'letterId'=base.letter_id::text AND related.decision_revision=base.decision_revision AND related.created_at<=base.posting_created_at)) AND related.trigger_event=run.trigger_event
   AND (run.event_key=related.trigger_event||'|'||related.occurrence OR starts_with(run.event_key,related.trigger_event||'|'||related.occurrence||'|'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(related.workflow_versions) ref WHERE ref->>'workflowId'=run.workflow_id::text AND ref->>'revision'=run.workflow_revision::text))
 ),run_state AS MATERIALIZED(
  SELECT run.posting_id,run.id,run.status,
   run.waiting_for IS NULL AND (run.status='skipped' OR run.status='done' AND run.remaining_steps='[]'::jsonb) AS terminal,
   run.status='waiting' AND jsonb_array_length(run.remaining_steps)>0
   AND run.step_cursor=(run.remaining_steps->0->>'index')::integer
   AND EXISTS(SELECT 1 FROM public.contract_shared_email_document_step first_pin
    JOIN app.contract_email_prerequisite_origin first_origin ON first_origin.tenant_id=first_pin.tenant_id AND first_origin.pin_id=first_pin.id
    WHERE first_pin.tenant_id=run.tenant_id AND first_pin.workflow_run_id=run.id AND first_pin.id=run.waiting_for
    AND first_pin.workflow_step_id=run.remaining_steps->0->'step'->>'id' AND first_origin.job_id=base.job_id AND first_origin.root_event_id=base.root_event_id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.remaining_steps) remaining
    WHERE remaining->'step'->>'type' IS DISTINCT FROM 'sendEmail' OR NOT EXISTS(
     SELECT 1 FROM public.automation_workflow_version version
     JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=version.tenant_id AND pin.workflow_run_id=run.id
      AND pin.workflow_step_id=remaining->'step'->>'id' AND pin.case_id=base.case_id AND pin.company_id=base.company_id
      AND pin.subject_person_id=base.subject_person_id AND pin.decision_revision=base.decision_revision AND pin.source_period_revision=base.source_revision
     JOIN app.contract_email_prerequisite_origin pin_origin ON pin_origin.tenant_id=pin.tenant_id AND pin_origin.pin_id=pin.id
      AND pin_origin.job_id=base.job_id AND pin_origin.root_event_id=base.root_event_id
     JOIN public.contract_shared_event pin_event ON pin_event.tenant_id=pin_origin.tenant_id AND pin_event.id=pin_origin.origin_event_id
      AND pin_event.job_id=base.job_id AND coalesce(pin_event.root_event_id,pin_event.id)=base.root_event_id AND pin_event.case_id=base.case_id
      AND pin_event.trigger_event<>'emailDocumentReady' AND pin_event.decision_revision=base.decision_revision
     JOIN public.automation_email_template_version email ON email.tenant_id=pin.tenant_id AND email.template_id=pin.email_template_id AND email.revision=pin.email_revision AND email.module='contract_staff'
     WHERE version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision
     AND version.definition->'steps'->((remaining->>'index')::integer)=remaining->'step'
     AND remaining->'step'->'params'->>'emailTemplateId'=pin.email_template_id::text
     AND EXISTS(SELECT 1 FROM public.contract_shared_event run_origin WHERE run_origin.tenant_id=run.tenant_id AND run_origin.case_id=base.case_id
      AND run_origin.trigger_event=run.trigger_event AND run_origin.created_at<=pin.prepared_at
      AND (run.event_key=run_origin.trigger_event||'|'||run_origin.occurrence OR starts_with(run.event_key,run_origin.trigger_event||'|'||run_origin.occurrence||'|'))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(run_origin.workflow_versions) ref WHERE ref->>'workflowId'=run.workflow_id::text AND ref->>'revision'=run.workflow_revision::text)))) AS pinned_email,
   app.bulk_job_value_digest(jsonb_build_array(run.id,run.workflow_id,run.workflow_revision,run.event_key,run.trigger_event,run.status,run.step_cursor,run.waiting_for,run.remaining_steps)) AS row_hash
  FROM cohort run JOIN bases base ON base.posting_id=run.posting_id
 ),cohort_state AS MATERIALIZED(
  SELECT state.posting_id,bool_and(state.terminal) all_terminal,bool_and(state.terminal OR state.pinned_email) email_or_terminal,
   bool_or(state.pinned_email) has_email,app.bulk_job_value_digest(jsonb_agg(encode(state.row_hash,'hex') ORDER BY state.id)) digest
  FROM run_state state GROUP BY state.posting_id
 ),children AS MATERIALIZED(
  SELECT base.posting_id,NOT EXISTS(SELECT 1 FROM public.contract_shared_event child WHERE child.tenant_id=base.tenant_id AND child.job_id=base.job_id
   AND child.processed_at IS NULL AND child.id<>base.event_id AND (child.case_id<>base.case_id OR coalesce(child.root_event_id,child.id)<>base.root_event_id
   OR child.trigger_event='emailDocumentReady' AND NOT EXISTS(
    SELECT 1 FROM app.contract_email_prerequisite_resume resume JOIN app.contract_email_prerequisite_origin pin_origin ON pin_origin.tenant_id=resume.tenant_id AND pin_origin.pin_id=resume.pin_id
    JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=pin_origin.tenant_id AND pin.id=pin_origin.pin_id
    JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.status='waiting' AND run.waiting_for=pin.id
    WHERE resume.tenant_id=base.tenant_id AND resume.event_id=child.id AND pin_origin.job_id=base.job_id
    AND pin_origin.root_event_id=base.root_event_id AND pin.case_id=base.case_id AND run.remaining_steps->0->'step'->>'id'=pin.workflow_step_id)
   OR child.trigger_event<>'emailDocumentReady' AND NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin pin_origin
    JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=pin_origin.tenant_id AND pin.id=pin_origin.pin_id
    JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id AND run.status='waiting' AND run.waiting_for=pin.id
    WHERE pin_origin.tenant_id=base.tenant_id AND pin_origin.job_id=base.job_id AND pin_origin.root_event_id=base.root_event_id
    AND pin_origin.origin_event_id=child.id AND pin.case_id=base.case_id AND run.remaining_steps->0->'step'->>'id'=pin.workflow_step_id))) AS only_internal_mail
  FROM bases base
 ),event_sets AS MATERIALIZED(SELECT base.posting_id,app.bulk_job_value_digest(coalesce(jsonb_agg(jsonb_build_array(event.id,event.trigger_event,event.occurrence,event.decision_revision,event.workflow_versions,event.created_at) ORDER BY event.id) FILTER(WHERE event.id IS NOT NULL),'[]'::jsonb)) digest
 FROM bases base LEFT JOIN public.contract_shared_event event ON event.tenant_id=base.tenant_id AND event.job_id=base.job_id AND event.processed_at IS NULL AND event.trigger_event<>'emailDocumentReady' GROUP BY base.posting_id)
 SELECT base.posting_id,base.event_id,base.job_id,
  coalesce(base.job_state IN('queued','preparing','finalizing') AND base.processed_at IS NULL AND base.cancel_requested_at IS NULL
   AND base.job_input=jsonb_build_object('eventId',base.root_event_id) AND base.input_digest=app.bulk_job_value_digest(base.job_input)
   AND base.plan_digest=app.bulk_job_value_digest(base.job_plan) AND base.steps_sealed=0
   AND NOT EXISTS(SELECT 1 FROM public.bulk_job_step step WHERE step.job_id=base.job_id)
   AND base.origin_settled AND cohort.email_or_terminal AND cohort.has_email AND children.only_internal_mail,false),
  coalesce(base.job_state='completed' AND base.processed_at IS NOT NULL AND base.origin_settled AND cohort.all_terminal AND children.only_internal_mail,false),app.bulk_job_value_digest(jsonb_build_array(cohort.digest,event_sets.digest))
 FROM bases base JOIN cohort_state cohort ON cohort.posting_id=base.posting_id JOIN children ON children.posting_id=base.posting_id JOIN event_sets ON event_sets.posting_id=base.posting_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_producer_disposition(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_posting_producer_yield(p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;job public.bulk_job;ids uuid[];cursor_fact jsonb;proof record;related record;checked integer:=0;
BEGIN
 SELECT array_agg(producer.posting_id ORDER BY producer.posting_id) INTO ids FROM app.contract_posting_producer producer
 WHERE producer.tenant_id=app.current_tenant_id() AND producer.event_id=p_event;
 IF ids IS NULL THEN RETURN;END IF; -- All ordinary nonproducer jobs remain unchanged.
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=event.tenant_id AND id=event.job_id;
 IF event.id IS NULL OR event.processed_at IS NOT NULL OR event.trigger_event='emailDocumentReady'
 OR event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR job.id::text IS DISTINCT FROM current_setting('app.bulk_job',true)
 OR app.contract_shared_storage_runner() IS NOT TRUE OR app.contract_shared_worker_event_held(event.case_id,event.decision_revision) IS NOT TRUE
 OR job.kind<>'contract_automation' OR job.state<>'finalizing' OR job.cancel_requested_at IS NOT NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
 OR app.bulk_job_capability_held(job.id) IS NOT TRUE OR app.bulk_job_seal_verify(job.id,'full') IS NOT NULL
 THEN RAISE EXCEPTION 'Actual selected live FIRST producer owner required' USING ERRCODE='42501';END IF;
 cursor_fact:=app.contract_shared_email_event_cursor(event.id);
 IF cursor_fact->'known' IS DISTINCT FROM 'true'::jsonb OR (cursor_fact->>'cursor')::integer IS DISTINCT FROM jsonb_array_length(event.workflow_versions)
 THEN RAISE EXCEPTION 'Attempt every frozen producer workflow before yielding' USING ERRCODE='42501';END IF;
 --6000 native cursor metadata is consulted ONLY under this genuine live worker frame, never by pages.
 IF (SELECT count(*) FROM public.contract_shared_event child WHERE child.tenant_id=event.tenant_id AND child.job_id=job.id AND child.processed_at IS NULL AND child.trigger_event<>'emailDocumentReady')>200 THEN RETURN;END IF;
 FOR related IN SELECT child.* FROM public.contract_shared_event child WHERE child.tenant_id=event.tenant_id AND child.job_id=job.id AND child.processed_at IS NULL AND child.trigger_event<>'emailDocumentReady' ORDER BY child.id LOOP
  IF related.case_id IS DISTINCT FROM event.case_id OR coalesce(related.root_event_id,related.id) IS DISTINCT FROM coalesce(event.root_event_id,event.id)
  THEN RAISE EXCEPTION 'The actual producer event cohort changed' USING ERRCODE='42501';END IF;
  cursor_fact:=app.contract_shared_email_event_cursor(related.id);
  IF cursor_fact->'known' IS DISTINCT FROM 'true'::jsonb OR (cursor_fact->>'cursor')::integer IS DISTINCT FROM jsonb_array_length(related.workflow_versions)
  THEN RETURN;END IF; -- Unattempted genuine child work stays waiting, uncertified.
 END LOOP;
 FOR proof IN SELECT * FROM app.contract_posting_producer_disposition(ids) LOOP
  checked:=checked+1;
  -- A genuine waiting business/notification tail keeps waiting WITHOUT a certificate or forced job failure.
  -- It must never become ready merely because an artificial refusal terminalized its original kernel job.
  IF proof.email_only THEN
   INSERT INTO app.contract_posting_producer_certificate(tenant_id,posting_id,event_id,job_id,versions_hash,workflow_cursor,cohort_hash)
   VALUES(event.tenant_id,proof.posting_id,event.id,job.id,app.bulk_job_value_digest(event.workflow_versions),jsonb_array_length(event.workflow_versions),proof.cohort_hash)
   ON CONFLICT(tenant_id,posting_id,cohort_hash) DO NOTHING;
  END IF;
 END LOOP;
 IF checked<>cardinality(ids) THEN RAISE EXCEPTION 'The immutable FIRST producer source changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_producer_yield(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_posting_workflow_readiness(p_ids uuid[]) RETURNS TABLE(posting_id uuid,ready boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids)=0 THEN RETURN;END IF;
 IF cardinality(p_ids)>100 THEN RAISE EXCEPTION 'Bound the Contract readiness projection' USING ERRCODE='22023';END IF;
 RETURN QUERY WITH ids AS MATERIALIZED(SELECT DISTINCT unnest(p_ids) id),
 dispositions AS MATERIALIZED(SELECT * FROM app.contract_posting_producer_disposition(p_ids)),
 causes AS MATERIALIZED(
  SELECT receipt.posting_id,event.id,event.job_id,job.state,first_producer.posting_id AS first_id,first_producer.job_id AS first_job,disposition.complete,
   disposition.email_only AND certificate.event_id=first_producer.event_id AND certificate.job_id=first_producer.job_id
   AND certificate.versions_hash=first_producer.event_versions_hash AND certificate.workflow_cursor=jsonb_array_length(producer_event.workflow_versions)
   AND certificate.cohort_hash=disposition.cohort_hash AS certified
  FROM ids JOIN public.contract_shared_posting receipt ON receipt.tenant_id=app.current_tenant_id() AND receipt.posting_id=ids.id
  JOIN public.personnel_posting posting ON posting.tenant_id=receipt.tenant_id AND posting.id=receipt.posting_id
  JOIN public.contract_shared_event event ON event.tenant_id=receipt.tenant_id AND event.case_id=receipt.case_id AND event.decision_revision=receipt.decision_revision
   AND event.trigger_event='letterReleased' AND event.data->>'letterId'=receipt.letter_id::text AND event.created_at<=posting.created_at
  JOIN public.bulk_job job ON job.tenant_id=event.tenant_id AND job.id=event.job_id AND job.kind='contract_automation' AND job.operation_key=coalesce(event.root_event_id,event.id)
  LEFT JOIN app.contract_posting_producer first_producer ON first_producer.tenant_id=receipt.tenant_id AND first_producer.posting_id=receipt.posting_id
  LEFT JOIN public.contract_shared_event producer_event ON producer_event.tenant_id=first_producer.tenant_id AND producer_event.id=first_producer.event_id
  LEFT JOIN dispositions disposition ON disposition.posting_id=receipt.posting_id AND disposition.job_id=job.id
  LEFT JOIN app.contract_posting_producer_certificate certificate ON certificate.tenant_id=receipt.tenant_id AND certificate.posting_id=receipt.posting_id AND certificate.cohort_hash=disposition.cohort_hash
 ),verdict AS(SELECT cause.posting_id,bool_and(CASE WHEN cause.first_id IS NULL THEN cause.state IN('completed','failed','cancelled')
  WHEN cause.job_id<>cause.first_job THEN cause.state IN('completed','failed','cancelled')
  ELSE coalesce(cause.complete,false) OR coalesce(cause.certified,false) END) AS allowed FROM causes cause GROUP BY cause.posting_id)
 SELECT ids.id,coalesce(verdict.allowed,false) FROM ids LEFT JOIN verdict ON verdict.posting_id=ids.id;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_workflow_readiness(uuid[]) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_posting_workflow_ready(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT readiness.ready FROM app.contract_posting_workflow_readiness(ARRAY[p_id]) readiness WHERE readiness.posting_id=p_id),false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_workflow_ready(uuid) FROM PUBLIC,ai_hr_app;
