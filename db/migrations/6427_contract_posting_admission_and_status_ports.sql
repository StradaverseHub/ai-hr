-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
CREATE FUNCTION app.contract_posting_request(p_id uuid,p_revision integer,p_values jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;r public.contract_shared_posting;chosen jsonb;queued jsonb;job_id uuid;operation uuid:=gen_random_uuid();prior app.contract_posting_job_source;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'A human Contract posting approval is required' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-posting-request:'||app.current_tenant_id()::text||':'||p_id::text,0));
 -- Lock only the posting here; no Employment/Payroll row lock is taken during read-only admission.
 -- A concurrent worker cannot approve between pending validation and the truthful queued response.
 PERFORM 1 FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 chosen:=app.contract_posting_request_values(p_id,p_revision,p_values);
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=p.tenant_id AND posting_id=p.id;
 SELECT source.* INTO prior FROM app.contract_posting_job_source source JOIN public.bulk_job job ON job.tenant_id=source.tenant_id AND job.id=source.job_id
 WHERE source.tenant_id=p.tenant_id AND source.posting_id=p.id AND job.state IN('queued','preparing','finalizing') ORDER BY source.requested_at,source.job_id LIMIT 1;
 IF prior.job_id IS NOT NULL THEN
  IF prior.requester_user_id IS DISTINCT FROM app.current_user_id() OR prior.requester_person_id IS DISTINCT FROM app.contract_actor_person(app.current_user_id())
  OR prior.posting_revision IS DISTINCT FROM p_revision OR prior.values_hash IS DISTINCT FROM app.bulk_job_value_digest(chosen)
  THEN RAISE EXCEPTION 'A different pending application already owns this posting' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('postingId',p.id,'jobId',prior.job_id,'postingStatus','pending','applicationState','queued');
 END IF;
 queued:=app.bulk_job_enqueue('contract_posting_apply',operation,ARRAY[p.company_id]::uuid[],'',NULL,jsonb_build_object('postingId',p.id));
 job_id:=(queued->>'id')::uuid;
 IF job_id IS NULL THEN RAISE EXCEPTION 'The Contract application could not be queued' USING ERRCODE='40001';END IF;
 INSERT INTO app.contract_posting_job_source(tenant_id,job_id,operation_key,posting_id,posting_revision,requested_values,values_hash,requester_user_id,requester_person_id,
 company_id,employment_id,subject_person_id,case_id,decision_revision,letter_id,source_revision)
 VALUES(p.tenant_id,job_id,operation,p.id,p_revision,chosen,app.bulk_job_value_digest(chosen),app.current_user_id(),app.contract_actor_person(app.current_user_id()),
 p.company_id,p.employment_id,r.subject_person_id,r.case_id,r.decision_revision,r.letter_id,r.source_revision);
 RETURN jsonb_build_object('postingId',p.id,'jobId',job_id,'postingStatus','pending','applicationState','queued');
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_request(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_posting_request(uuid,integer,jsonb) TO ai_hr_app;

CREATE FUNCTION app.contract_posting_request_status(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;job public.bulk_job;p public.personnel_posting;result app.contract_posting_job_result;receipt public.contract_shared_posting;
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'A human Contract application status reader is required' USING ERRCODE='42501';END IF;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=app.current_tenant_id() AND job_id=p_job AND requester_user_id=app.current_user_id();
 IF source.job_id IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE
 OR source.requester_person_id IS DISTINCT FROM app.contract_actor_person(app.current_user_id()) OR app.contract_shared_posting_approver(source.company_id) IS NOT TRUE
 THEN RAISE EXCEPTION 'Contract application status unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=source.tenant_id AND id=p_job;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=source.tenant_id AND id=source.posting_id;
 SELECT * INTO result FROM app.contract_posting_job_result WHERE tenant_id=source.tenant_id AND job_id=p_job;
 SELECT * INTO receipt FROM public.contract_shared_posting WHERE tenant_id=source.tenant_id AND posting_id=source.posting_id;
 RETURN jsonb_build_object('jobId',p_job,'postingId',source.posting_id,'jobState',job.state,'postingStatus',p.status,
 'applicationState',CASE WHEN result.job_id IS NOT NULL THEN CASE WHEN receipt.applied_at IS NOT NULL THEN 'applied' WHEN result.scheduled THEN 'scheduled' ELSE 'needs_review' END
  WHEN job.state IN('failed','cancelled') THEN 'needs_review' ELSE 'queued' END,
 'groupId',result.movement_group_id,'requestedAt',source.requested_at,'completedAt',result.completed_at);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_request_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_posting_request_status(uuid) TO ai_hr_app;
