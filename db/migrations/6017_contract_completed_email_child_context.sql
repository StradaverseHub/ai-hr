-- INACTIVE REVIEW PROPOSAL. Root allocates a forward migration after review.
-- Same OID, owner, ACL and every existing historical/executor guard are retained.
DO $guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_email_recovery_original(uuid)'::regprocedure)
  IS DISTINCT FROM '85e05853ca44e5f0cd51ede68012d0132432cad58b912fab77e37be9f50fb1e4' THEN
  RAISE EXCEPTION 'Unexpected canonical original-email recovery owner before completed-email correction';
 END IF;
END $guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_recovery_original(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;waiting boolean;cursor_proof jsonb;
BEGIN
 SELECT * INTO event FROM public.contract_shared_event WHERE tenant_id=app.current_tenant_id() AND id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id WHERE binding.tenant_id=event.tenant_id AND binding.job_id=event.job_id AND pin.case_id=event.case_id AND binding.root_event_id=coalesce(event.root_event_id,event.id))
 THEN RETURN jsonb_build_object('handled',false);END IF;
 cursor_proof:=app.contract_shared_email_event_cursor(event.id);
 IF cursor_proof->'known'='true'::jsonb AND app.contract_shared_worker_event_held_recovery_base(event.case_id,event.decision_revision) AND NOT EXISTS(SELECT 1 FROM public.contract_shared_event retained
  WHERE retained.tenant_id=event.tenant_id AND retained.job_id=event.job_id AND retained.case_id=event.case_id
   AND coalesce(retained.root_event_id,retained.id)=coalesce(event.root_event_id,event.id) AND retained.email_reconciliation IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin binding
  WHERE binding.tenant_id=event.tenant_id AND binding.job_id=event.job_id
   AND app.contract_shared_email_recovery_disposition(binding.pin_id)<>'current'
   AND NOT EXISTS(
    -- A successfully consumed ordinary email is finished work, not historical recovery authority.
    -- Its native source event and run cursor must both prove completion of the frozen email step.
    SELECT 1 FROM public.contract_shared_event completed
    JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=binding.tenant_id AND pin.id=binding.pin_id
    JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id
     AND run.module='contract_staff' AND run.subject_id=pin.case_id AND run.status IN('running','waiting','done') AND run.failure IS NULL
     AND run.waiting_for IS DISTINCT FROM pin.id
    JOIN public.automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision AND version.module='contract_staff'
    JOIN public.automation_email_template_version email ON email.tenant_id=pin.tenant_id AND email.template_id=pin.email_template_id AND email.revision=pin.email_revision AND email.module='contract_staff'
    CROSS JOIN LATERAL jsonb_array_elements(version.definition->'steps') WITH ORDINALITY frozen(step,n)
    WHERE completed.tenant_id=binding.tenant_id AND completed.id=binding.origin_event_id AND completed.job_id=event.job_id
     AND completed.case_id=event.case_id AND pin.case_id=event.case_id
     AND coalesce(completed.root_event_id,completed.id)=binding.root_event_id AND binding.root_event_id=coalesce(event.root_event_id,event.id)
     AND app.contract_shared_email_recovery_source(pin.tenant_id,pin.id) IS TRUE
     AND completed.processed_at IS NOT NULL AND completed.error IS NULL AND completed.email_reconciliation IS NULL
     AND frozen.step->>'id'=pin.workflow_step_id AND frozen.step->>'type'='sendEmail'
     AND frozen.step->'params'->>'emailTemplateId'=pin.email_template_id::text AND run.step_cursor>=frozen.n
   )) THEN RETURN jsonb_build_object('handled',false);END IF;
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
