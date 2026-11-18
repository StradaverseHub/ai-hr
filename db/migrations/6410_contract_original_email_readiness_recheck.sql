-- The genuine ORIGINAL current owner can observe one PM/account-only prerequisite hold becoming ready.
-- No event, callback actor, source override or new application grant is introduced.
CREATE FUNCTION app.contract_shared_email_original_recheck(p_event uuid,p_after uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event public.contract_shared_event;pin public.contract_shared_email_document_step;run public.automation_run;letter_id uuid;state jsonb;
BEGIN
 SELECT e.* INTO event FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.id=p_event;
 IF event.id::text IS DISTINCT FROM current_setting('app.contract_event',true) OR event.trigger_event='emailDocumentReady'
 OR app.contract_shared_worker_event_held(event.case_id,event.decision_revision) IS NOT TRUE
 THEN RAISE EXCEPTION 'Original current workflow owner required' USING ERRCODE='42501';END IF;
 SELECT p.* INTO pin FROM app.contract_email_prerequisite_origin origin
 JOIN public.contract_shared_email_document_step p ON p.tenant_id=origin.tenant_id AND p.id=origin.pin_id
 JOIN public.automation_run r ON r.tenant_id=p.tenant_id AND r.id=p.workflow_run_id AND r.status='waiting' AND r.waiting_for=p.id
 WHERE origin.tenant_id=event.tenant_id AND origin.origin_event_id=event.id AND origin.job_id=event.job_id AND (p_after IS NULL OR p.id>p_after)
 -- A real callback keeps its own identity boundary, even after its receipt became stale or was rejected.
 AND NOT EXISTS(SELECT 1 FROM app.contract_email_prerequisite_resume receipt WHERE receipt.tenant_id=p.tenant_id AND receipt.pin_id=p.id)
 -- Actual uploads use their dedicated observed callback path; this reader cannot replace an inactive uploader.
 AND NOT EXISTS(SELECT 1 FROM app.contract_email_upload_observation observation JOIN public.lc_v9_email_asset asset ON asset.tenant_id=observation.tenant_id AND asset.id=observation.asset_id
  WHERE asset.tenant_id=p.tenant_id AND asset.automation_module='contract_staff' AND asset.kind='file' AND asset.email_template_id=p.email_template_id::text
  AND asset.shared_subject_id=p.case_id AND asset.shared_source_revision=p.source_period_revision)
 ORDER BY p.id LIMIT 1;
 IF pin.id IS NULL THEN RETURN jsonb_build_object('selected',false,'ready',false);END IF;
 IF app.contract_shared_email_prerequisite_origin_held(pin.id) IS NOT TRUE THEN RAISE EXCEPTION 'Original live email owner required' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source(pin.case_id);
 FOR letter_id IN SELECT value::uuid FROM jsonb_each_text(pin.documents) ORDER BY value LOOP PERFORM app.contract_shared_email_document_lock(letter_id);END LOOP;
 PERFORM app.contract_shared_email_prerequisite_lock(pin.id);
 state:=app.contract_shared_email_prerequisite_state(pin.id);
 IF state->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN jsonb_build_object('selected',true,'pinId',pin.id,'ready',false);END IF;
 SELECT r.* INTO run FROM public.automation_run r WHERE r.tenant_id=pin.tenant_id AND r.id=pin.workflow_run_id;
 RETURN jsonb_build_object('selected',true,'pinId',pin.id,'ready',true,'run',to_jsonb(run));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_email_original_recheck(uuid,uuid) FROM PUBLIC,ai_hr_app;
