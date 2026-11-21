-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
CREATE FUNCTION app.contract_posting_job_bind_intent(p_job uuid,p_employment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x app.contract_posting_job_tx;source app.contract_posting_job_source;i public.contract_shared_posting_tx;
 p public.personnel_posting;e public.employment;a public.assignment;desired jsonb;digest bytea;future boolean;
BEGIN
 IF app.contract_posting_original_source_intact(p_job,p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Immutable Contract source required for intent binding' USING ERRCODE='42501';END IF;
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=app.current_tenant_id() AND job_id=p_job AND employment_id=p_employment
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=x.tenant_id AND job_id=p_job;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=x.tenant_id AND id=x.posting_id;
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id AND employment_id=p_employment
 AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND actor_user_id=x.actor_user_id AND NOT consumed;
 future:=i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 desired:=CASE p.event_type WHEN 'contractRenewal' THEN jsonb_build_object('contract_start_date',source.requested_values->>'effectiveDate',
  'contract_end_date',source.requested_values->>'endDate','contract_number',(source.requested_values->>'contractNumber')::integer)
 ELSE jsonb_build_object('contract_start_date',NULL,'contract_end_date',NULL,'contract_number',(x.original_employment->>'contract_number')::integer) END;
 IF app.contract_posting_target_source_held(x.posting_id) IS NOT TRUE OR i.employment_id IS NULL OR i.kind IS DISTINCT FROM p.event_type OR i.kind NOT IN('contractRenewal','contractConversion')
 OR i.effective_on::text IS DISTINCT FROM source.requested_values->>'effectiveDate' OR i.desired IS DISTINCT FROM desired
 OR p.status<>'approved' OR p.approved_by IS DISTINCT FROM source.requester_user_id OR p.approved_at IS DISTINCT FROM now()
 OR p.revision IS DISTINCT FROM source.posting_revision+1 OR p.applied IS DISTINCT FROM source.requested_values
 OR (NOT future AND x.protected IS NOT TRUE)
 THEN RAISE EXCEPTION 'Protected exact approved target intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=x.tenant_id AND id=p_employment;
 SELECT * INTO a FROM public.assignment WHERE tenant_id=x.tenant_id AND employment_id=p_employment AND superseded_at IS NULL AND valid_to IS NULL;
 IF to_jsonb(e) IS DISTINCT FROM i.old_employment OR to_jsonb(a) IS DISTINCT FROM i.old_assignment
 OR e.company_id IS DISTINCT FROM source.company_id OR e.person_id IS DISTINCT FROM source.subject_person_id
 OR app.contract_posting_asof_legal_company(p_employment,i.effective_on) IS DISTINCT FROM source.company_id
 THEN RAISE EXCEPTION 'Bind only the actual unchanged as-of target source' USING ERRCODE='42501';END IF;
 IF future AND (to_jsonb(e) IS DISTINCT FROM x.original_employment OR to_jsonb(a) IS DISTINCT FROM x.original_assignment)
 THEN RAISE EXCEPTION 'Future scheduling cannot change current Personnel or replay history' USING ERRCODE='42501';END IF;
 digest:=app.bulk_job_value_digest(jsonb_build_array(i.posting_id,i.employment_id,i.old_employment,i.old_assignment,i.desired,i.effective_on,i.kind));
 IF x.intent_hash IS NOT NULL AND x.intent_hash IS DISTINCT FROM digest THEN RAISE EXCEPTION 'The bound Contract target intent changed' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_job_tx SET intent_hash=digest WHERE tenant_id=x.tenant_id AND xact_id=x.xact_id AND backend_pid=x.backend_pid AND employment_id=p_employment;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_job_bind_intent(uuid,uuid) FROM PUBLIC,ai_hr_app;

-- After canonical target receipt AND the immutable later replay, require original CURRENT flat facts plus
-- ONLY target desired fields. Comparing to i.old_employment would incorrectly erase legitimate later grade,
-- payment-method and other restored facts. The target itself retains5815/5817's unchanged old-as-of image proof.
-- The SAME exact held job then delegates only fixed native stale marking.
CREATE FUNCTION app.contract_posting_replay_target_end(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state app.contract_posting_replay_state;source app.contract_posting_job_source;x app.contract_posting_job_tx;
 i public.contract_shared_posting_tx;p public.personnel_posting;r public.contract_shared_posting;e public.employment;digest bytea;future boolean;
BEGIN
 SELECT * INTO state FROM app.contract_posting_replay_state WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=state.tenant_id AND job_id=p_job;
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
 IF state.job_id IS NULL OR NOT state.target_open OR NOT state.target_prepared OR state.target_completed OR state.active_ordinal IS NOT NULL
 OR app.contract_posting_original_source_intact(p_job,state.employment_id) IS NOT TRUE
 THEN RAISE EXCEPTION 'Actual native target frame required' USING ERRCODE='42501';END IF;
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id AND employment_id=x.employment_id
 AND transaction_id=x.xact_id AND backend_pid=x.backend_pid AND login_name=x.login_name AND actor_user_id=x.actor_user_id AND consumed;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=x.tenant_id AND id=x.posting_id;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=x.tenant_id AND id=x.employment_id;
 future:=i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 digest:=app.bulk_job_value_digest(jsonb_build_array(i.posting_id,i.employment_id,i.old_employment,i.old_assignment,i.desired,i.effective_on,i.kind));
 IF i.employment_id IS NULL OR x.intent_hash IS DISTINCT FROM digest OR i.old_employment IS DISTINCT FROM state.target_employment
 OR i.old_assignment IS DISTINCT FROM state.target_assignment OR p.status<>'approved' OR p.movement_id IS NULL
 OR p.approved_by IS DISTINCT FROM source.requester_user_id OR p.approved_at IS DISTINCT FROM now()
 OR p.applied IS DISTINCT FROM source.requested_values OR r.movement_group_id IS NULL
 OR e.company_id IS DISTINCT FROM source.company_id OR e.person_id IS DISTINCT FROM source.subject_person_id
 OR (NOT future AND r.applied_at IS NULL)
 OR (future AND (r.applied_at IS NOT NULL OR to_jsonb(e) IS DISTINCT FROM x.original_employment
  OR app.contract_posting_assignment_hash(e.id) IS DISTINCT FROM app.bulk_job_value_digest(jsonb_build_array(x.original_assignment))
  OR EXISTS(SELECT 1 FROM app.contract_posting_replay_step step WHERE step.tenant_id=x.tenant_id AND step.job_id=p_job AND step.xact_id=x.xact_id AND step.backend_pid=x.backend_pid)))
 OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.tenant_id=x.tenant_id AND d.id::text=p.movement_id
 AND d.subject_employment_id=x.employment_id AND d.occurred_at=now() AND d.payload->'movement'->>'groupId'=r.movement_group_id::text)
 THEN RAISE EXCEPTION 'Actual consumed canonical target and native receipt required before replay' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_replay_state SET target_open=false,target_completed=true,
 checkpoint_employment=app.bulk_job_value_digest(to_jsonb(e)),checkpoint_assignment=app.contract_posting_assignment_hash(e.id)
 WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_target_end(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_complete(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.contract_posting_replay_state state
 JOIN app.contract_posting_job_source source ON source.tenant_id=state.tenant_id AND source.job_id=state.job_id
 JOIN public.employment e ON e.tenant_id=source.tenant_id AND e.id=source.employment_id
 WHERE state.tenant_id=app.current_tenant_id() AND state.job_id=p_job AND state.xact_id=txid_current()
 AND state.backend_pid=pg_backend_pid() AND state.login_name=session_user AND state.target_completed AND NOT state.target_open
 AND state.active_ordinal IS NULL AND app.contract_posting_original_source_intact(p_job,state.employment_id)
 AND e.company_id=source.company_id AND e.person_id=source.subject_person_id
 AND NOT EXISTS(SELECT 1 FROM app.contract_posting_replay_step step WHERE step.tenant_id=state.tenant_id AND step.job_id=state.job_id
 AND step.xact_id=state.xact_id AND step.backend_pid=state.backend_pid AND (NOT step.completed OR step.group_hash IS DISTINCT FROM app.contract_posting_group_hash(p_job,step.event_id)))),false)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_complete(uuid) FROM PUBLIC,ai_hr_app;
