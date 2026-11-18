-- INACTIVE proposal: no migration identity, journal entry or installation authority.
-- Private technical disposition only; existing worker_event_held/event_finish stay unchanged.
CREATE FUNCTION app.contract_shared_finish_empty_opening(p_event uuid,p_job uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.contract_shared_event;j public.bulk_job;s app.bulk_job_seal;
 c public.contract_case;f public.contract_shared_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE
 OR p_job::text IS DISTINCT FROM current_setting('app.bulk_job',true)
 OR p_event::text IS DISTINCT FROM current_setting('app.contract_event',true)
 OR app.bulk_job_capability_held(p_job) IS NOT TRUE THEN RETURN false;END IF;
 SELECT * INTO j FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND id=p_job FOR UPDATE;
 SELECT * INTO s FROM app.bulk_job_seal WHERE tenant_id=j.tenant_id AND job_id=j.id;
 SELECT * INTO e FROM public.contract_shared_event WHERE tenant_id=j.tenant_id AND id=p_event AND job_id=j.id FOR UPDATE;
 IF j.id IS NULL OR e.id IS NULL OR j.kind<>'contract_automation' OR j.state<>'finalizing'
 OR j.cancel_requested_at IS NOT NULL OR j.lease_token IS NULL OR j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()
 OR j.operation_key IS DISTINCT FROM e.id OR j.input IS DISTINCT FROM jsonb_build_object('eventId',e.id)
 OR j.plan IS DISTINCT FROM jsonb_build_object('activeEventId',NULL,'workflowCursor',0)
 OR j.steps_total<>0 OR j.steps_done<>0 OR s.job_id IS NULL OR s.steps_sealed<>0 OR s.verified_at IS NULL
 OR s.lease_token IS DISTINCT FROM j.lease_token OR s.input_digest IS DISTINCT FROM app.bulk_job_value_digest(j.input)
 OR s.plan_digest IS DISTINCT FROM app.bulk_job_value_digest(j.plan)
 OR e.trigger_event<>'caseOpened' OR e.decision_revision<>0 OR e.actor_type<>'user'
 OR e.root_event_id IS NOT NULL OR e.processed_at IS NOT NULL OR e.error IS NOT NULL OR e.email_reconciliation IS NOT NULL
 OR e.workflow_versions IS DISTINCT FROM '[]'::jsonb
 OR e.actor_user_id IS NULL OR e.actor_person_id IS NULL OR j.created_by IS DISTINCT FROM e.actor_user_id
 OR j.context->>'tenantId' IS DISTINCT FROM j.tenant_id::text OR j.context->>'userId' IS DISTINCT FROM e.actor_user_id::text
 OR app.contract_verified_human(e.actor_user_id) IS NOT TRUE
 OR app.contract_binding_person(e.actor_user_id) IS DISTINCT FROM e.actor_person_id
 OR EXISTS(SELECT 1 FROM public.bulk_job_step WHERE job_id=j.id)
 OR EXISTS(SELECT 1 FROM app.bulk_job_step_seal WHERE job_id=j.id)
 OR EXISTS(SELECT 1 FROM public.contract_shared_event child WHERE child.tenant_id=e.tenant_id AND child.id<>e.id AND (child.job_id=j.id OR child.root_event_id=e.id))
 OR EXISTS(SELECT 1 FROM app.contract_email_prerequisite_origin origin WHERE origin.tenant_id=e.tenant_id AND (origin.job_id=j.id OR origin.root_event_id=e.id OR origin.origin_event_id=e.id))
 THEN RETURN false;END IF;
 -- Preserve the native source lock; no Form, pay, document or participant context is hydrated.
 PERFORM app.contract_shared_lock_source(e.case_id);
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=e.tenant_id AND id=e.case_id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=e.tenant_id AND case_id=e.case_id FOR UPDATE;
 IF c.id IS NULL OR f.case_id IS NULL OR c.source_conflict IS NOT NULL
 OR j.company_ids IS DISTINCT FROM ARRAY[c.company_id]::uuid[]
 OR app.contract_case_company_current(c.id) IS NOT TRUE
 OR app.contract_shared_native_intake_hold(c.employment_id) IS NOT NULL
 OR f.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision(c.employment_id)
 OR e.data->'period'->>'sourceRevision' IS DISTINCT FROM f.data->'period'->>'sourceRevision'
 OR NOT EXISTS(SELECT 1 FROM public.employment employment WHERE employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
  AND coalesce(least(employment.resignation_date,employment.last_working_date,employment.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,false)=false)
 OR jsonb_typeof(f.data->'decision') IS DISTINCT FROM 'object'
 OR coalesce((f.data->'decision'->>'revision')::integer,0)<1
 OR app.contract_shared_decision_current(c.id,(f.data->'decision'->>'revision')::integer) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.company company JOIN public.tenant tenant ON tenant.id=company.tenant_id
  WHERE company.tenant_id=e.tenant_id AND company.id=c.company_id AND company.archived_at IS NULL AND tenant.status IN('active','trial')
  AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=company.tenant_id AND module.module_code='lifecycle'
   AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()) AND (module.company_id IS NULL OR module.company_id=company.id)))
 -- Opening has one occurrence per native period: refuse even an unexpected skipped/failed run.
 OR EXISTS(SELECT 1 FROM public.automation_run run WHERE run.tenant_id=e.tenant_id AND run.module='contract_staff' AND run.subject_id=e.case_id AND run.trigger_event='caseOpened')
 OR EXISTS(SELECT 1 FROM public.automation_email_delivery delivery WHERE delivery.tenant_id=e.tenant_id AND delivery.module='contract_staff'
  AND delivery.subject_id=e.case_id AND (delivery.payload->'context'->>'eventId'=e.id::text OR delivery.payload->'context'->>'rootEventId'=e.id::text))
 THEN RETURN false;END IF;
 -- The sole persisted change. The kernel completes/cleans the genuine held job normally.
 UPDATE public.contract_shared_event SET processed_at=now() WHERE tenant_id=e.tenant_id AND id=e.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_finish_empty_opening(uuid,uuid) FROM PUBLIC,ai_hr_app;
