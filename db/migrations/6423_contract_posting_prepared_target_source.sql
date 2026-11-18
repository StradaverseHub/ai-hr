-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
-- INACTIVE EXECUTABLE PROPOSAL: UNAPPROVED / UNAPPLIED / NOT REGISTERED.
-- Complete companion to6001/6002. Existing approve runs BEFORE any inverse, under the initial captured
-- source. ONLY intent's period-source test needs a private target-frame exception after canonical inverse.
-- No public decision_current predicate, Personnel source hash, actor, role, date or tenant is substituted.
CREATE FUNCTION app.contract_posting_replay_target_begin(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state app.contract_posting_replay_state;source app.contract_posting_job_source;e public.employment;a public.assignment;
 p public.personnel_posting;assignment_count integer;
BEGIN
 SELECT * INTO state FROM app.contract_posting_replay_state WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=state.tenant_id AND job_id=p_job;
 IF state.job_id IS NULL OR app.contract_posting_original_source_intact(p_job,state.employment_id) IS NOT TRUE
 OR state.active_ordinal IS NOT NULL OR state.target_open OR state.target_completed
 OR EXISTS(SELECT 1 FROM app.contract_posting_replay_step step WHERE step.tenant_id=state.tenant_id AND step.job_id=p_job
 AND step.xact_id=state.xact_id AND step.backend_pid=state.backend_pid AND step.direction='inverse' AND NOT step.completed)
 OR EXISTS(SELECT 1 FROM app.contract_posting_replay_step step WHERE step.tenant_id=state.tenant_id AND step.job_id=p_job
 AND step.xact_id=state.xact_id AND step.backend_pid=state.backend_pid AND step.direction='replay' AND step.completed)
 THEN RAISE EXCEPTION 'Finish the exact inverse plan before the Contract target' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=source.tenant_id AND id=source.employment_id;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=source.tenant_id AND id=source.posting_id;
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE tenant_id=e.tenant_id AND employment_id=e.id AND superseded_at IS NULL AND valid_to IS NULL;
 SELECT * INTO a FROM public.assignment WHERE tenant_id=e.tenant_id AND employment_id=e.id AND superseded_at IS NULL AND valid_to IS NULL;
 IF e.person_id IS DISTINCT FROM source.subject_person_id OR e.company_id IS DISTINCT FROM source.company_id
 OR app.contract_posting_asof_legal_company(e.id,(source.requested_values->>'effectiveDate')::date) IS DISTINCT FROM source.company_id
 OR assignment_count<>1
 OR p.status<>'approved' OR p.approved_by IS DISTINCT FROM source.requester_user_id OR p.approved_at IS DISTINCT FROM now()
 OR p.revision IS DISTINCT FROM source.posting_revision+1 OR p.applied IS DISTINCT FROM source.requested_values
 THEN RAISE EXCEPTION 'Exact approved Contract target at its actual legal employer required' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_replay_state SET target_open=true,target_employment=to_jsonb(e),target_assignment=to_jsonb(a)
 WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_target_begin(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_target_prepare(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state app.contract_posting_replay_state;source app.contract_posting_job_source;e public.employment;a public.assignment;n integer;
BEGIN
 SELECT * INTO state FROM app.contract_posting_replay_state WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=state.tenant_id AND job_id=p_job;
 IF state.job_id IS NULL OR NOT state.target_open OR state.target_prepared OR state.target_completed OR state.active_ordinal IS NOT NULL
 OR app.contract_posting_original_source_intact(p_job,state.employment_id) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM app.contract_posting_replay_step s WHERE s.tenant_id=state.tenant_id AND s.job_id=p_job AND s.xact_id=state.xact_id
 AND s.backend_pid=state.backend_pid AND s.direction='inverse' AND NOT s.completed)
 THEN RAISE EXCEPTION 'Actual protected target preparation frame required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=source.tenant_id AND id=source.employment_id FOR UPDATE;
 SELECT count(*) INTO n FROM public.assignment WHERE tenant_id=e.tenant_id AND employment_id=e.id AND valid_to IS NULL AND superseded_at IS NULL;
 SELECT * INTO a FROM public.assignment WHERE tenant_id=e.tenant_id AND employment_id=e.id AND valid_to IS NULL AND superseded_at IS NULL FOR UPDATE;
 IF n<>1 OR a.employment_type<>'contract' OR a.valid_from>(source.requested_values->>'effectiveDate')::date
 OR e.company_id IS DISTINCT FROM source.company_id OR e.person_id IS DISTINCT FROM source.subject_person_id
 OR app.contract_posting_asof_legal_company(e.id,(source.requested_values->>'effectiveDate')::date) IS DISTINCT FROM source.company_id
 THEN RAISE EXCEPTION 'The canonical lifted Contract source does not cover the signed effective date' USING ERRCODE='40001';END IF;
 UPDATE app.contract_posting_replay_state SET target_prepared=true,target_employment=to_jsonb(e),target_assignment=to_jsonb(a)
 WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_target_prepare(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_target_source_held(p_posting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.contract_posting_job_source source
 JOIN app.contract_posting_replay_state state ON state.tenant_id=source.tenant_id AND state.job_id=source.job_id
 JOIN app.contract_posting_job_tx x ON x.tenant_id=state.tenant_id AND x.job_id=state.job_id AND x.xact_id=state.xact_id AND x.backend_pid=state.backend_pid
 JOIN public.personnel_posting p ON p.tenant_id=source.tenant_id AND p.id=source.posting_id
 JOIN public.contract_shared_posting r ON r.tenant_id=source.tenant_id AND r.posting_id=source.posting_id
 JOIN public.employment e ON e.tenant_id=source.tenant_id AND e.id=source.employment_id
 JOIN public.assignment a ON a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_to IS NULL
 WHERE source.tenant_id=app.current_tenant_id() AND source.posting_id=p_posting
 AND state.xact_id=txid_current() AND state.backend_pid=pg_backend_pid() AND state.login_name=session_user
 AND state.target_open AND state.target_prepared AND NOT state.target_completed AND state.active_ordinal IS NULL AND x.protected
 AND app.contract_posting_original_source_intact(source.job_id,source.employment_id)
 AND e.company_id=source.company_id AND e.person_id=source.subject_person_id
 AND to_jsonb(e)=state.target_employment AND to_jsonb(a)=state.target_assignment
 AND app.contract_posting_asof_legal_company(e.id,(source.requested_values->>'effectiveDate')::date)=source.company_id
 AND r.source_revision=source.source_revision AND r.case_id=source.case_id AND r.decision_revision=source.decision_revision
 AND r.letter_id=source.letter_id AND r.subject_person_id=source.subject_person_id AND r.applied_at IS NULL
 AND p.source='contract_staff' AND p.source_ref=source.case_id AND p.status='approved' AND p.approved_by=source.requester_user_id
 AND p.approved_at=now() AND p.revision=source.posting_revision+1 AND p.applied=source.requested_values
 AND source.values_hash=app.bulk_job_value_digest(source.requested_values)),false)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_target_source_held(uuid) FROM PUBLIC,ai_hr_app;

-- Factor the5815 canonical owner ONCE; the current public outer5913/5817 chain, criteria locks, custody,
-- legal values, actor freshness, old/as-of images, intent consume and future scheduling remain unchanged.
-- COPY rather than RENAME keeps cached/old callers of this exact5815 OID inside the guarded dispatcher.
-- The ONLY changed expression accepts the protected native target proof instead of rechecking today's
-- original-period hash against the deliberately rewound as-of state. No app can mint that private proof.
DO $factor$
DECLARE body text;original_predicate text:='IF r.source_revision IS DISTINCT FROM app.contract_shared_period_revision(e.id) THEN';
BEGIN
 body:=pg_get_functiondef('app.contract_shared_posting_intent_before_source_lock(uuid)'::regprocedure);
 IF strpos(body,original_predicate)=0 OR strpos(body,'app.contract_posting_target_source_held')>0
 THEN RAISE EXCEPTION 'Review canonical Contract intent source before factoring';END IF;
 body:=replace(body,'FUNCTION app.contract_shared_posting_intent_before_source_lock(','FUNCTION app.contract_posting_intent_canonical_owner(');
 body:=replace(body,original_predicate,'IF r.source_revision IS DISTINCT FROM app.contract_shared_period_revision(e.id) AND app.contract_posting_target_source_held(p.id) IS NOT TRUE THEN');
 EXECUTE body;
END $factor$;
REVOKE ALL ON FUNCTION app.contract_posting_intent_canonical_owner(uuid) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_posting_intent_before_source_lock(p_posting uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.contract_posting_intent_canonical_owner(p_posting);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent_before_source_lock(uuid) FROM PUBLIC,ai_hr_app;
